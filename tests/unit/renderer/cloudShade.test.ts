import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  applyCloudShade,
  CLOUD_DARKEN_GLSL,
  CLOUD_FRAGMENT_GLSL,
  CLOUD_VERTEX_BODY_GLSL,
  CLOUD_VERTEX_GLSL,
  createCloudShadeUniforms,
  createCloudNoiseTexture,
  CloudShadeController,
} from '../../../src/engine/renderer/cloudShade';

describe('cloud shade shader chunks', () => {
  it('declare the shared uniforms and the world-position varying', () => {
    expect(CLOUD_FRAGMENT_GLSL).toContain('uniform sampler2D uCloudMap');
    expect(CLOUD_FRAGMENT_GLSL).toContain('uniform vec2 uCloudOffset');
    expect(CLOUD_FRAGMENT_GLSL).toContain('uniform float uCloudStrength');
    expect(CLOUD_FRAGMENT_GLSL).toContain('varying vec3 vCloudWorld');
    expect(CLOUD_VERTEX_GLSL).toContain('varying vec3 vCloudWorld');
  });

  it('handles instanced and non-instanced vertex paths', () => {
    expect(CLOUD_VERTEX_BODY_GLSL).toContain('USE_INSTANCING');
    expect(CLOUD_VERTEX_BODY_GLSL).toContain('instanceMatrix');
    expect(CLOUD_VERTEX_BODY_GLSL).toContain('modelMatrix * vec4(transformed');
  });

  it('darkens albedo, leaving emissive untouched — and carries no global snow', () => {
    expect(CLOUD_DARKEN_GLSL).toContain('diffuseColor.rgb');
    expect(CLOUD_DARKEN_GLSL).not.toContain('totalEmissiveRadiance');
    // The rejected winter mixed one cold white into every up-facing surface;
    // season snow belongs to the ground mask, never to the cloud shade.
    expect(CLOUD_DARKEN_GLSL).not.toContain('snow');
    expect(CLOUD_FRAGMENT_GLSL).not.toContain('snow');
    expect(CLOUD_FRAGMENT_GLSL).not.toContain('uSnowAmount');
  });
});

describe('createCloudShadeUniforms', () => {
  it('shares one uniforms object across patched materials', () => {
    const uniforms = createCloudShadeUniforms(1);
    const a = new THREE.MeshLambertMaterial();
    const b = new THREE.MeshLambertMaterial();
    applyCloudShade(a, uniforms);
    applyCloudShade(b, uniforms);
    expect(typeof a.onBeforeCompile).toBe('function');
    expect(typeof b.onBeforeCompile).toBe('function');
    // The patch wraps any existing onBeforeCompile instead of replacing it.
    expect(a.customProgramCacheKey?.()).toContain('+cloud');
    a.dispose();
    b.dispose();
  });

  it('builds a tileable noise texture', () => {
    const texture = createCloudNoiseTexture(64);
    expect(texture.image.width).toBe(64);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    texture.dispose();
  });
});

describe('CloudShadeController', () => {
  it('fades strength and drifts the offset', () => {
    const uniforms = createCloudShadeUniforms(0);
    const controller = new CloudShadeController(uniforms);
    controller.setStrength(1);
    controller.update(1);
    expect(uniforms.uCloudStrength.value).toBeGreaterThan(0);
    const offsetBefore = (uniforms.uCloudOffset.value as THREE.Vector2).clone();
    controller.update(2);
    const offsetAfter = uniforms.uCloudOffset.value as THREE.Vector2;
    expect(offsetAfter.length()).toBeGreaterThan(offsetBefore.length());
    expect('uSnowAmount' in uniforms).toBe(false);
    controller.dispose();
  });
});
