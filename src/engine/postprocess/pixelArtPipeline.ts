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
uniform float uDebugView;
uniform float uToneMode;
uniform float uEnabled;
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

float gxAt(vec2 uv) {
  float centre = viewDepthAt(uv);
  vec2 texel = uTexelSize;
  return abs(viewDepthAt(uv + vec2(texel.x, 0.0)) - centre) +
    abs(viewDepthAt(uv - vec2(texel.x, 0.0)) - centre);
}

float gyAt(vec2 uv) {
  float centre = viewDepthAt(uv);
  vec2 texel = uTexelSize;
  return abs(viewDepthAt(uv + vec2(0.0, texel.y)) - centre) +
    abs(viewDepthAt(uv - vec2(0.0, texel.y)) - centre);
}

float diagonalAt(vec2 uv) {
  float centre = viewDepthAt(uv);
  vec2 texel = uTexelSize;
  return abs(viewDepthAt(uv + texel) - centre) +
    abs(viewDepthAt(uv - texel) - centre) +
    abs(viewDepthAt(uv + vec2(texel.x, -texel.y)) - centre) +
    abs(viewDepthAt(uv + vec2(-texel.x, texel.y)) - centre);
}

float edgeGradient(vec2 uv) {
  return max(gxAt(uv), gyAt(uv)) + diagonalAt(uv) * 0.35;
}

float edgeStrength(vec2 uv) {
  return smoothstep(uEdgeLow, uEdgeHigh, edgeGradient(uv));
}

// --- ACES filmic (three.js implementation) --------------------------------
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = (0.983729 * v + 0.4329510) * v + 0.238081;
  return a / b;
}

vec3 acesFilmicToneMapping(vec3 color) {
  const mat3 ACESInputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 ACESOutputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602)
  );
  color *= uExposure / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}

vec3 applyToneMapping(vec3 color) {
  if (uToneMode > 1.5) return acesFilmicToneMapping(color);
  if (uToneMode > 0.5) return clamp(color * uExposure, 0.0, 1.0);
  return neutralToneMapping(color);
}

void main() {
  vec3 linearColor = texture2D(tScene, vUv).rgb;
  float depth = texture2D(tDepth, vUv).x;
  float viewDist = uNear + depth * (uFar - uNear);
  bool isSky = depth > 0.99999;

  if (uDebugView > 0.5) {
    if (uDebugView < 1.5) {
      gl_FragColor = vec4(vec3(fract(viewDist * 0.0025)), 1.0);
    } else if (uDebugView < 2.5) {
      gl_FragColor = vec4(vec3(edgeStrength(vUv)), 1.0);
    } else if (uDebugView < 3.5) {
      gl_FragColor = vec4(linearToSrgb(linearColor), 1.0);
    } else if (uDebugView < 4.5) {
      gl_FragColor = vec4(vec3(depth), 1.0);
    } else if (uDebugView < 5.5) {
      gl_FragColor = vec4(vec3(viewDist / 10000.0), 1.0);
    } else if (uDebugView < 6.5) {
      gl_FragColor = vec4(linearToSrgb(applyToneMapping(linearColor)), 1.0);
    } else if (uDebugView < 7.5) {
      gl_FragColor = vec4(vec3(edgeGradient(vUv) / 10.0), 1.0);
    } else if (uDebugView < 8.5) {
      gl_FragColor = vec4(vec3(gxAt(vUv) / 10.0), 1.0);
    } else if (uDebugView < 9.5) {
      gl_FragColor = vec4(vec3(gyAt(vUv) / 10.0), 1.0);
    } else if (uDebugView < 10.5) {
      gl_FragColor = vec4(vec3(diagonalAt(vUv) / 10.0), 1.0);
    } else {
      gl_FragColor = vec4(uTexelSize * 1000.0, 0.5, 1.0);
    }
    return;
  }

  // Clean full-resolution 3D view (pixel-art effect disabled): tone mapping
  // only, no outlines / quantisation / vignette.
  if (uEnabled < 0.5) {
    gl_FragColor = vec4(linearToSrgb(applyToneMapping(linearColor)), 1.0);
    return;
  }

  // Sky: keep the background clear colour, tone mapped but unquantised and
  // un-outlined, so the horizon converges to the same tone as fogged geometry.
  if (isSky) {
    gl_FragColor = vec4(linearToSrgb(applyToneMapping(linearColor)), 1.0);
    return;
  }

  // Subtle vignette in linear light (so the palette quantisation below still
  // produces flat posterised regions).
  float radius = length(vUv - vec2(0.5));
  float vignette = smoothstep(0.9, 0.28, radius);
  linearColor *= mix(1.0, 1.0 - uVignette, 1.0 - vignette);

  float edge = edgeStrength(vUv);

  vec3 color = linearToSrgb(applyToneMapping(linearColor));

  float fog = smoothstep(uFogNear, uFogFar, viewDist);
  color = mix(color, uFogColor, fog);

  if (uPaletteMix > 0.0) {
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
  private effectEnabled = true;
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
      uVignette: { value: 0.1 },
      uFogNear: { value: 2000 },
      uFogFar: { value: 6000 },
      uPixelWorld: { value: 1 },
      uEdgeLow: { value: 1 },
      uEdgeHigh: { value: 4 },
      uFogColor: { value: new THREE.Vector3(0.9, 0.92, 0.94) },
      uSkyColor: { value: new THREE.Vector3(0.9, 0.92, 0.94) },
      uDebugView: { value: 0 },
      uToneMode: { value: 2 },
      uEnabled: { value: 1 },
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

  get targetHandle(): THREE.WebGLRenderTarget {
    return this.target;
  }

  /** Debug: render the scene into the low-resolution target only. */
  renderSceneToTarget(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
  }

  get cssSize(): { width: number; height: number } {
    return { width: this.cssWidth, height: this.cssHeight };
  }

  /**
   * Recompute the render-target size. When the pixel-art effect is enabled the
   * target is the low internal resolution; when disabled it is the full canvas
   * size so the "clean 3D" debug view is genuinely full resolution.
   */
  setSize(cssWidth: number, cssHeight: number, settings?: Partial<PixelArtSettings>): void {
    if (settings) Object.assign(this.settings, settings);
    this.cssWidth = Math.max(1, Math.floor(cssWidth));
    this.cssHeight = Math.max(1, Math.floor(cssHeight));
    this.applyTargetSize();
  }

  /** Toggle the pixel-art stage (target resolution + shader branch). */
  setEffectEnabled(enabled: boolean): void {
    this.effectEnabled = Boolean(enabled);
    this.uniforms.uEnabled.value = this.effectEnabled ? 1 : 0;
    this.applyTargetSize();
  }

  private applyTargetSize(): void {
    const aspect = this.cssWidth / this.cssHeight;
    let width: number;
    let height: number;
    if (this.effectEnabled) {
      const vertical = Math.round(Math.max(120, Math.min(this.settings.resolution, 1080)));
      width = Math.max(160, Math.round(vertical * aspect));
      height = vertical;
    } else {
      width = this.cssWidth;
      height = this.cssHeight;
    }
    if (width === this.renderWidth && height === this.renderHeight) {
      this.updateSettingsUniforms();
      return;
    }
    this.renderWidth = width;
    this.renderHeight = height;
    this.target.setSize(width, height);
    this.target.texture.needsUpdate = true;
    (this.uniforms.uTexelSize.value as THREE.Vector2).set(1 / width, 1 / height);
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
    // Global palette snapping is intentionally OFF: a 41-entry global LUT
    // pulls saturated mid-tones onto neutral entries and washes the city out.
    // The limited-palette feel comes from the materials plus ordered dithering
    // and per-channel posterisation. The palette LUT remains available through
    // the debug uniform for experiments.
    this.uniforms.uPaletteMix.value = 0;
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

  /** Render the scene straight to the canvas (debug path), bypassing the post pass. */
  renderDirect(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.disposed) return;
    this.renderer.setRenderTarget(null);
    this.renderer.render(scene, camera);
  }

  /** Debug: framebuffer completeness of the low-resolution scene target. */
  checkTargetFramebufferStatus(): number {
    const gl = this.renderer.getContext();
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    this.renderer.setRenderTarget(previous);
    return status;
  }

  /** Debug: read back pixels from the low-resolution scene target. */
  readTargetPixels(x: number, y: number, width: number, height: number): Uint8Array | null {
    const clampedWidth = Math.max(1, Math.min(width, this.renderWidth));
    const clampedHeight = Math.max(1, Math.min(height, this.renderHeight));
    const buffer = new Uint8Array(clampedWidth * clampedHeight * 4);
    try {
      this.renderer.readRenderTargetPixels(
        this.target,
        Math.max(0, Math.min(x, this.renderWidth - clampedWidth)),
        Math.max(0, Math.min(y, this.renderHeight - clampedHeight)),
        clampedWidth,
        clampedHeight,
        buffer,
      );
      return buffer;
    } catch (error) {
      console.warn('[city] readRenderTargetPixels failed', error);
      return null;
    }
  }

  /** Debug: set one of the post uniforms by name (numbers / vec3 arrays). */
  setUniformValue(name: string, value: number | number[]): void {
    const uniform = this.uniforms[name];
    if (!uniform) return;
    if (Array.isArray(value) && uniform.value instanceof THREE.Vector3) {
      uniform.value.set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
      return;
    }
    uniform.value = value;
  }

  getUniformNames(): string[] {
    return Object.keys(this.uniforms);
  }

  /** Debug: low-resolution target + depth texture configuration. */
  getTargetInfo(): Record<string, unknown> {
    return {
      width: this.renderWidth,
      height: this.renderHeight,
      texture: {
        type: this.target.texture.type,
        format: this.target.texture.format,
        colorSpace: this.target.texture.colorSpace,
        minFilter: this.target.texture.minFilter,
        magFilter: this.target.texture.magFilter,
      },
      depthTexture: {
        type: this.depthTexture.type,
        format: this.depthTexture.format,
        image: { ...this.depthTexture.image },
        minFilter: this.depthTexture.minFilter,
        magFilter: this.depthTexture.magFilter,
        compareFunction: this.depthTexture.compareFunction,
      },
      sameDepthTexture: this.target.depthTexture === this.depthTexture,
      framebufferStatus: this.checkTargetFramebufferStatus(),
    };
  }

  /** Debug: snapshot of the numeric post uniforms. */
  getUniformValues(): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const [name, uniform] of Object.entries(this.uniforms)) {
      const value = uniform.value;
      if (typeof value === 'number') values[name] = value;
      else if (value instanceof THREE.Vector2) values[name] = value.toArray();
      else if (value instanceof THREE.Vector3) values[name] = value.toArray();
    }
    return values;
  }

  /** Debug: switch the fragment shader to a diagnostic visualisation. */
  setDebugView(mode: number): void {
    this.uniforms.uDebugView.value = mode;
  }

  /** Choose tone mapping for the post pass: 0 = neutral, 1 = linear/clamp. */
  setToneMode(mode: number): void {
    this.uniforms.uToneMode.value = mode;
    this.uniforms.uExposure.value = this.uniforms.uExposure.value;
  }

  /** Debug: read back pixels from the default framebuffer (after rendering). */
  readCanvasPixels(x: number, y: number, width: number, height: number): Uint8Array | null {
    const gl = this.renderer.getContext();
    const buffer = new Uint8Array(width * height * 4);
    try {
      gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
      return buffer;
    } catch (error) {
      console.warn('[city] gl.readPixels failed', error);
      return null;
    }
  }

  /**
   * Render one frame. The scene always goes through the post pass (the tone
   * mapping/look must be identical in both modes); when the pixel-art effect is
   * disabled the target is full resolution and the shader takes the clean
   * branch (no outlines, quantisation or vignette).
   */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.disposed) return;
    const renderer = this.renderer;
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
