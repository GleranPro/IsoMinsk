/**
 * Pixel-art post-processing pipeline (a real render stage, not a CSS filter).
 *
 *   scene ──► low-resolution colour+depth render target (linear, no tonemap)
 *         ──► fullscreen post pass (tonemap, fog, ordered dither, palette
 *             quantisation, depth-edge outlines, vignette)
 *         ──► nearest-neighbour upscale to the full-size canvas
 *
 * When the effect is disabled the scene renders directly to the canvas at full
 * resolution (clean debug view). The low-res target keeps a high-precision
 * depth texture so outlines are always exactly one low-resolution pixel wide —
 * i.e. crisp chunky pixel-art outlines after the upscale.
 */

import * as THREE from 'three';
import type { PixelArtSettings } from '../../shared/appApi';
import {
  PIXEL_PALETTE,
  PIXEL_PALETTE_SIZE,
  hexToRgb,
} from './palette';

export interface PixelArtEnvironment {
  /** sRGB channel values 0..1. */
  fogColor: [number, number, number];
  skyColor: [number, number, number];
  outlineColor: [number, number, number];
  /** Fog range in camera view-depth metres (mirrors scene.fog). */
  fogNear: number;
  fogFar: number;
  /** World metres covered by one low-res pixel, at the current zoom. */
  pixelWorld: number;
  /** Depth-gradient thresholds, also in world metres. */
  edgeLow: number;
  edgeHigh: number;
  /** Tone mapping exposure; must match the renderer's direct-to-canvas path. */
  exposure: number;
}

function buildPaletteVectors(): THREE.Vector3[] {
  return PIXEL_PALETTE.map((hex) => {
    const { r, g, b } = hexToRgb(hex);
    return new THREE.Vector3(r / 255, g / 255, b / 255);
  });
}

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uTexelSize;
uniform float uNear;
uniform float uFar;

uniform float uExposure;
uniform float uOutline;
uniform vec3 uOutlineColor;
uniform float uLevels;
uniform float uPaletteMix;
uniform float uDither;
uniform float uVignette;
uniform float uFogNear;
uniform float uFogFar;
uniform float uPixelWorld;
uniform float uEdgeLow;
uniform float uEdgeHigh;
uniform vec3 uFogColor;
uniform vec3 uSkyColor;
uniform vec3 uPalette[PIXEL_PALETTE_SIZE];

// --- tone mapping (matches three.js NeutralToneMapping) --------------------
vec3 neutralToneMapping(vec3 color) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  color *= uExposure;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}

vec3 linearToSrgb(vec3 value) {
  vec3 clamped = clamp(value, 0.0, 1.0);
  vec3 low = clamped * 12.92;
  vec3 high = 1.055 * pow(clamped, vec3(1.0 / 2.4)) - 0.055;
  return mix(high, low, vec3(lessThanEqual(clamped, vec3(0.0031308))));
}

// --- ordered dithering (Bayer 4x4) ----------------------------------------
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a);
}

// --- limited palette -------------------------------------------------------
vec3 nearestPalette(vec3 color) {
  float bestDistance = 1e9;
  vec3 best = color;
  for (int i = 0; i < PIXEL_PALETTE_SIZE; i++) {
    vec3 candidate = uPalette[i];
    vec3 delta = color - candidate;
    float distance = delta.r * delta.r * 0.9 + delta.g * delta.g * 1.15 + delta.b * delta.b * 0.8;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

// --- depth edges -----------------------------------------------------------
float viewDepthAt(vec2 uv) {
  return uNear + texture2D(tDepth, uv).x * (uFar - uNear);
}

float edgeStrength(vec2 uv) {
  vec2 texel = uTexelSize;
  float centre = viewDepthAt(uv);
  float gx =
    abs(viewDepthAt(uv + vec2(texel.x, 0.0)) - centre) +
    abs(viewDepthAt(uv - vec2(texel.x, 0.0)) - centre);
  float gy =
    abs(viewDepthAt(uv + vec2(0.0, texel.y)) - centre) +
    abs(viewDepthAt(uv - vec2(0.0, texel.y)) - centre);
  float diagonal =
    abs(viewDepthAt(uv + texel) - centre) +
    abs(viewDepthAt(uv - texel) - centre) +
    abs(viewDepthAt(uv + vec2(texel.x, -texel.y)) - centre) +
    abs(viewDepthAt(uv + vec2(-texel.x, texel.y)) - centre);
  float gradient = max(gx, gy) + diagonal * 0.35;
  return smoothstep(uEdgeLow, uEdgeHigh, gradient);
}

void main() {
  vec3 linearColor = texture2D(tScene, vUv).rgb;
  float depth = texture2D(tDepth, vUv).x;
  float viewDist = uNear + depth * (uFar - uNear);
  bool isSky = depth > 0.99999;

  // Subtle vignette in linear light (so the palette quantisation below still
  // produces flat posterised regions).
  float radius = length(vUv - vec2(0.5));
  float vignette = smoothstep(0.9, 0.28, radius);
  linearColor *= mix(1.0, 1.0 - uVignette, 1.0 - vignette);

  float edge = edgeStrength(vUv);

  vec3 color = neutralToneMapping(linearColor);
  color = linearToSrgb(color);

  float fog = smoothstep(uFogNear, uFogFar, viewDist);
  color = mix(color, uFogColor, fog);

  if (isSky) {
    color = uSkyColor;
  } else if (uPaletteMix > 0.0) {
    float dither = (bayer4(gl_FragCoord.xy) - 0.5) * uDither * 0.16;
    vec3 candidate = clamp(color + dither, 0.0, 1.0);
    color = mix(candidate, nearestPalette(candidate), uPaletteMix);
  } else if (uLevels > 1.0) {
    float dither = (bayer4(gl_FragCoord.xy) - 0.5) * (uDither / uLevels);
    vec3 candidate = clamp(color + dither, 0.0, 1.0);
    color = floor(candidate * uLevels + 0.5) / uLevels;
  }

  float outline = edge * uOutline * (1.0 - fog * 0.85);
  color = mix(color, uOutlineColor, outline);

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

export class PixelArtPipeline {
  readonly settings: PixelArtSettings;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly depthTexture: THREE.DepthTexture;
  private readonly postScene = new THREE.Scene();
  private readonly postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private renderWidth = 1;
  private renderHeight = 1;
  private cssWidth = 1;
  private cssHeight = 1;
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer, settings: PixelArtSettings) {
    this.renderer = renderer;
    this.settings = { ...settings };

    this.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.depthTexture.format = THREE.DepthFormat;
    this.depthTexture.minFilter = THREE.NearestFilter;
    this.depthTexture.magFilter = THREE.NearestFilter;
    this.depthTexture.generateMipmaps = false;

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: this.depthTexture,
    });
    this.target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.target.texture.generateMipmaps = false;

    const palette = buildPaletteVectors();
    this.uniforms = {
      tScene: { value: this.target.texture },
      tDepth: { value: this.depthTexture },
      uTexelSize: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 1 },
      uFar: { value: 10000 },
      uExposure: { value: 1 },
      uOutline: { value: settings.outline },
      uOutlineColor: { value: new THREE.Vector3(0.07, 0.09, 0.11) },
      uLevels: { value: 0 },
      uPaletteMix: { value: 1 },
      uDither: { value: settings.dither },
      uVignette: { value: 0.16 },
      uFogNear: { value: 2000 },
      uFogFar: { value: 6000 },
      uPixelWorld: { value: 1 },
      uEdgeLow: { value: 1 },
      uEdgeHigh: { value: 4 },
      uFogColor: { value: new THREE.Vector3(0.9, 0.92, 0.94) },
      uSkyColor: { value: new THREE.Vector3(0.9, 0.92, 0.94) },
      uPalette: { value: palette },
    };

    const material = new THREE.ShaderMaterial({
      name: 'pixel-art-post',
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      toneMapped: false,
      defines: { PIXEL_PALETTE_SIZE: PIXEL_PALETTE_SIZE },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    this.quad.frustumCulled = false;
    this.postScene.add(this.quad);
  }

  getRenderSize(): { width: number; height: number } {
    return { width: this.renderWidth, height: this.renderHeight };
  }

  get cssSize(): { width: number; height: number } {
    return { width: this.cssWidth, height: this.cssHeight };
  }

  /**
   * Recompute the low-resolution target size from the CSS canvas size and the
   * requested vertical resolution.
   */
  setSize(cssWidth: number, cssHeight: number, settings?: Partial<PixelArtSettings>): void {
    if (settings) Object.assign(this.settings, settings);
    this.cssWidth = Math.max(1, Math.floor(cssWidth));
    this.cssHeight = Math.max(1, Math.floor(cssHeight));
    const aspect = this.cssWidth / this.cssHeight;
    const vertical = Math.round(
      Math.max(120, Math.min(this.settings.resolution, 1080)),
    );
    const width = Math.max(160, Math.round(vertical * aspect));
    this.renderWidth = width;
    this.renderHeight = vertical;
    this.target.setSize(width, vertical);
    this.target.texture.needsUpdate = true;
    (this.uniforms.uTexelSize.value as THREE.Vector2).set(1 / width, 1 / vertical);
    this.updateSettingsUniforms();
  }

  setSettings(settings: PixelArtSettings): void {
    Object.assign(this.settings, settings);
    this.updateSettingsUniforms();
  }

  private updateSettingsUniforms(): void {
    this.uniforms.uOutline.value = this.settings.outline;
    this.uniforms.uDither.value = this.settings.dither;
    const quantise = this.settings.colorLevels >= 2;
    this.uniforms.uLevels.value = quantise ? this.settings.colorLevels : 0;
    this.uniforms.uPaletteMix.value = quantise ? 1 : 0;
  }

  /** Update per-frame environment uniforms (fog/sky/outline/edges/exposure). */
  updateEnvironment(env: PixelArtEnvironment): void {
    this.uniforms.uFogNear.value = env.fogNear;
    this.uniforms.uFogFar.value = env.fogFar;
    (this.uniforms.uFogColor.value as THREE.Vector3).set(...env.fogColor);
    (this.uniforms.uSkyColor.value as THREE.Vector3).set(...env.skyColor);
    (this.uniforms.uOutlineColor.value as THREE.Vector3).set(...env.outlineColor);
    this.uniforms.uPixelWorld.value = env.pixelWorld;
    this.uniforms.uEdgeLow.value = env.edgeLow;
    this.uniforms.uEdgeHigh.value = env.edgeHigh;
    this.uniforms.uExposure.value = env.exposure;
  }

  /** Set the camera-derived depth range used by the edge pass. */
  setDepthRange(near: number, far: number): void {
    this.uniforms.uNear.value = near;
    this.uniforms.uFar.value = far;
  }

  render(scene: THREE.Scene, camera: THREE.Camera, enabled: boolean): void {
    if (this.disposed) return;
    const renderer = this.renderer;
    if (!enabled) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.postScene, this.postCamera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.quad.geometry.dispose();
    (this.quad.material as THREE.ShaderMaterial).dispose();
    this.target.dispose();
    this.depthTexture.dispose();
  }
}
