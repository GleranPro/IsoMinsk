/**
 * Facade material + GLSL source tests.
 *
 * The shader cannot be compiled without a GPU, so these tests pin the parts
 * that *can* be verified in Node: the exported GLSL contains the uniforms and
 * attributes it claims, the string patch helpers apply cleanly to three's stock
 * Lambert shaders (balanced, single-include chunks), the uniform set is wired
 * from the shared presets/palette, and the public update/dispose helpers are
 * safe on foreign materials. Actual shader compilation is verified in a real
 * browser by qa-dev / the Lead's screenshot pass.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  createEnvironmentMaterial,
  createFacadeMaterial,
  createFacadeUniforms,
  createMaterialSet,
  disposeFacadeMaterial,
  updateFacadeUniforms,
  type FacadeUniformSet,
} from '../../../src/engine/materials/facadeMaterial';
import {
  FACADE_ARCHETYPE_COUNT,
  FACADE_FLOAT_UNIFORMS,
  FACADE_FRAGMENT_GLSL,
  FACADE_MOTIF_IDS,
  FACADE_PALETTE_SIZE,
  FACADE_PRESET_ROWS,
  FACADE_VERTEX_ATTRIBUTES,
  FACADE_VERTEX_GLSL,
  patchFacadeFragmentShader,
  patchFacadeVertexShader,
} from '../../../src/engine/shaders/facadeShader';
import { ARCHETYPE_BY_ID, ARCHETYPE_ID } from '../../../src/shared/geometry';
import { FACADE_PRESETS, motifRowsForUniforms, presetForRecipe } from '../../../src/city/facades/presets';
import { FACADE_PRESET_COUNT, LEGACY_RECIPE_OFFSET, SHELL_RECIPE_COUNT, STYLE_RECIPES, legacyRecipeFor } from '../../../src/shared/buildingStyles';
import { PIXEL_PALETTE, PIXEL_PALETTE_SIZE, hexToRgbUnit } from '../../../src/engine/postprocess/palette';

function uniformsOf(material: THREE.Material): FacadeUniformSet {
  return (material.userData as { facadeUniforms: FacadeUniformSet }).facadeUniforms;
}

function stripCommentsAndIncludes(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/#include\s*<[^>]*>/g, ' ');
}

function assertBalanced(source: string, label: string): void {
  const count = (char: string): number => source.split(char).length - 1;
  expect(count('{'), `${label}: unbalanced braces`).toBe(count('}'));
  expect(count('('), `${label}: unbalanced parens`).toBe(count(')'));
}

describe('facade GLSL source', () => {
  it('declares the vertex attribute contract', () => {
    expect(FACADE_VERTEX_GLSL.length).toBeGreaterThan(100);
    for (const attribute of FACADE_VERTEX_ATTRIBUTES) {
      expect(FACADE_VERTEX_GLSL).toContain(attribute);
    }
    expect(FACADE_VERTEX_GLSL).toContain('attribute vec2 aUV');
    expect(FACADE_VERTEX_GLSL).toContain('attribute vec3 aColor');
    expect(FACADE_VERTEX_GLSL).toContain('attribute vec4 aStyle');
    expect(FACADE_VERTEX_GLSL).toContain('attribute vec4 aFace');
    for (const varying of ['vFacadeUV', 'vFacadeColor', 'vFacadeStyle', 'vFacadeFace',
      'vFacadeWorldPos', 'vFacadeWorldUp']) {
      expect(FACADE_VERTEX_GLSL).toContain(varying);
    }
    expect(FACADE_VERTEX_GLSL).toContain('vFacadeUV = aUV;');
    expect(FACADE_VERTEX_GLSL).toContain('vFacadeWorldUp = normalize(');
  });

  it('declares every uniform the renderer pushes', () => {
    expect(FACADE_FRAGMENT_GLSL.length).toBeGreaterThan(1000);
    for (const uniform of FACADE_FLOAT_UNIFORMS) {
      expect(FACADE_FRAGMENT_GLSL, `missing uniform ${uniform}`).toContain(
        `uniform float ${uniform};`,
      );
    }
    expect(FACADE_FRAGMENT_GLSL).toContain('#define FACADE_PALETTE_SIZE');
    expect(FACADE_FRAGMENT_GLSL).toContain(`uniform vec3 uPalette[FACADE_PALETTE_SIZE];`);
    expect(FACADE_PALETTE_SIZE).toBe(PIXEL_PALETTE_SIZE);
    for (const uniform of ['uPresetA', 'uPresetB', 'uGlassColor', 'uNightLitColor', 'uTrimColor']) {
      expect(FACADE_FRAGMENT_GLSL).toContain(uniform);
    }
  });

  it('implements the facade features it advertises', () => {
    for (const feature of [
      'facadeShade',
      'facadeUpperFloors',
      'facadeGroundFloor',
      'facadeRoof',
      'facadeTrimShade',
      'facadeGlazing',
      'facadeQuantise',
      'facadeFlag',
    ]) {
      expect(FACADE_FRAGMENT_GLSL).toContain(feature);
    }
    // Window rhythm, balconies, ribbon mullions, night lighting, LOD.
    expect(FACADE_FRAGMENT_GLSL).toContain('winCrisp');
    expect(FACADE_FRAGMENT_GLSL).toContain('balconies');
    expect(FACADE_FRAGMENT_GLSL).toContain('ribbon');
    expect(FACADE_FRAGMENT_GLSL).toContain('uNight');
    expect(FACADE_FRAGMENT_GLSL).toContain('uPixelSize');
    expect(FACADE_FRAGMENT_GLSL).toContain('FACADE_PALETTE_SIZE');
  });

  it('snows roofs, roof ridges and trim only — never walls, glass or plinths', () => {
    // One call per snow-capable early-return branch: roof, roofRidge, trim.
    expect(FACADE_FRAGMENT_GLSL.match(/facadeApplySnow\(outAlbedo/g)).toHaveLength(3);
    expect(FACADE_FRAGMENT_GLSL).toContain('float isRoof = step(0.5, faceKind)');
    expect(FACADE_FRAGMENT_GLSL).toContain('float isTrim = step(2.5, faceKind)');
    expect(FACADE_FRAGMENT_GLSL).toContain('facadeSnowCover');
  });

  it('keeps the recipe preset uniform arrays in sync with the shared contract', () => {
    // 27 family recipes + 11 legacy archetype presets + 3 renderer shells = 41
    // preset rows, indexed by the packed recipe id. The broad archetype count
    // stays 11.
    expect(FACADE_PRESET_ROWS).toBe(FACADE_PRESET_COUNT);
    expect(FACADE_PRESET_COUNT).toBe(
      STYLE_RECIPES.length + ARCHETYPE_BY_ID.length + SHELL_RECIPE_COUNT,
    );
    expect(FACADE_PRESET_ROWS).toBe(41);
    expect(FACADE_ARCHETYPE_COUNT).toBe(ARCHETYPE_BY_ID.length);
    expect(FACADE_FRAGMENT_GLSL).toContain(`#define FACADE_PRESET_ROWS ${FACADE_PRESET_COUNT}`);
    expect(FACADE_FRAGMENT_GLSL).toContain('uniform vec4 uPresetA[FACADE_PRESET_ROWS];');
    expect(FACADE_FRAGMENT_GLSL).toContain('uniform vec4 uPresetB[FACADE_PRESET_ROWS];');
    expect(FACADE_FRAGMENT_GLSL).toContain('uniform float uRecipeMotif[FACADE_PRESET_ROWS];');
    expect(ARCHETYPE_ID.palace).toBe(9);
    expect(ARCHETYPE_ID.stadium).toBe(10);
  });

  it('unpacks the flag byte and the recipe byte from aFace.y in the shader', () => {
    // The shader must mask the low byte for flags and read the high byte for the
    // preset row; a plain `int(aFace.y)` would select the wrong preset.
    expect(FACADE_FRAGMENT_GLSL).toContain('mod(floor(packedStyle), 256.0)');
    expect(FACADE_FRAGMENT_GLSL).toContain('floor(packedStyle / 256.0)');
    expect(FACADE_FRAGMENT_GLSL).toContain('uPresetA[recipe]');
    expect(FACADE_FRAGMENT_GLSL).toContain('uRecipeMotif[recipe]');
    expect(FACADE_FRAGMENT_GLSL).toContain('FACADE_MOTIF_LOGGIA');
    expect(FACADE_FRAGMENT_GLSL).toContain('FACADE_MOTIF_STAIRCORE');
    expect(FACADE_FRAGMENT_GLSL).toContain('FACADE_MOTIF_CLERESTORY');
    expect(FACADE_FRAGMENT_GLSL).toContain('FACADE_MOTIF_BLANK_SERVICE');
    expect(FACADE_FRAGMENT_GLSL).toContain('FACADE_MOTIF_ASSEMBLY_HALL');
    // Legacy rows keep the pre-recipe branches (motif -1 never enters them).
    expect(FACADE_FRAGMENT_GLSL).toContain('if (motif >= 0 && !blank)');
    // Blank facades must not keep painted window surrounds: the glass is zeroed
    // above, so an ungated frame/sill/lintel would read as an empty window.
    expect(FACADE_FRAGMENT_GLSL).toContain('float blankFade = blank ? 0.0 : 1.0;');
    expect(FACADE_FRAGMENT_GLSL).toContain('frameMask *= churchFade * blankFade;');
    expect(FACADE_FRAGMENT_GLSL).toContain('sillMask *= churchFade * blankFade;');
    expect(FACADE_FRAGMENT_GLSL).toContain('lintelMask *= churchFade * blankFade;');
    expect(FACADE_FRAGMENT_GLSL).toContain('float doorAllowed = blank ? 0.0 : 1.0;');
    // Halls / service volumes replace the residential ground-floor grid with a
    // solid base wall and a sparse utility door.
    expect(FACADE_FRAGMENT_GLSL).toContain(
      'motif == FACADE_MOTIF_ASSEMBLY_HALL || motif == FACADE_MOTIF_BLANK_SERVICE',
    );
  });

  it('implements the palace colonnade/loggia look and the stadium fallback', () => {
    // Palace (id 9): paired tall windows between pilasters, loggia ground floor,
    // double-line cornice/attic.
    expect(FACADE_FRAGMENT_GLSL).toContain('palaceity');
    expect(FACADE_FRAGMENT_GLSL).toContain('winPitch');
    expect(FACADE_FRAGMENT_GLSL).toContain('loggia');
    expect(FACADE_FRAGMENT_GLSL).toContain('double-line');
    // Stadium (id 10): blank concrete plus one clerestory glazing band.
    expect(FACADE_FRAGMENT_GLSL).toContain('stadiumity');
    expect(FACADE_FRAGMENT_GLSL).toContain('clerestory');
  });

  it('does not use GLSL reserved words as identifiers', () => {
    // `patch` is a tessellation reserved word in GLSL ES 3.00 and once broke the
    // shader in the browser; guard the whole family of common reserved words.
    const reserved = [
      'patch',
      'sample',
      'filter',
      'partition',
      'resource',
      'superp',
      'namespace',
      'using',
      'goto',
      'inline',
      'noinline',
      'volatile',
      'public',
      'static',
      'extern',
      'external',
      'interface',
      'long',
      'short',
      'half',
      'fixed',
      'unsigned',
      'sizeof',
      'cast',
      'typedef',
      'template',
      'packed',
      'row_major',
      'precise',
      'subroutine',
      'class',
      'union',
      'enum',
      'asm',
    ];
    const stripped = stripCommentsAndIncludes(FACADE_VERTEX_GLSL + '\n' + FACADE_FRAGMENT_GLSL);
    for (const word of reserved) {
      expect(new RegExp(`\\b${word}\\b`).test(stripped), `reserved word used: ${word}`).toBe(false);
    }
  });

  it('has balanced braces and parentheses', () => {
    assertBalanced(FACADE_VERTEX_GLSL, 'vertex');
    assertBalanced(FACADE_FRAGMENT_GLSL, 'fragment');
  });
});

describe('Lambert shader patching', () => {
  const vertexSource = THREE.ShaderLib.lambert.vertexShader;
  const fragmentSource = THREE.ShaderLib.lambert.fragmentShader;

  it('applies the vertex patch to the stock Lambert shader', () => {
    const patched = patchFacadeVertexShader(vertexSource);
    expect(patched).not.toBe(vertexSource);
    expect(patched).toContain('attribute vec2 aUV;');
    expect(patched).toContain('vFacadeUV = aUV;');
    expect(patched).toContain('#include <begin_vertex>');
    expect(patched).toContain('void main()');
    assertBalanced(patched, 'patched vertex');
  });

  it('replaces the colour chunk exactly once in the fragment shader', () => {
    const patched = patchFacadeFragmentShader(fragmentSource);
    expect(patched).not.toBe(fragmentSource);
    expect(patched).toContain('facadeShade(');
    expect(patched).toContain('facadeQuantise(');
    // The stock chunks must be replaced, not duplicated (double sRGB encoding).
    const count = (source: string, chunk: string): number =>
      source.split(chunk).length - 1;
    expect(count(patched, '#include <color_fragment>')).toBe(1);
    expect(count(patched, '#include <colorspace_fragment>')).toBe(1);
    expect(patched).toContain('gl_FragColor.rgb = facadeQuantise(gl_FragColor.rgb);');
    expect(patched).toContain('#include <fog_fragment>');
    assertBalanced(patched, 'patched fragment');
  });

  it('is idempotent enough for a second shader variant (near/far materials)', () => {
    const once = patchFacadeFragmentShader(fragmentSource);
    const twice = patchFacadeFragmentShader(fragmentSource);
    expect(once).toBe(twice);
  });
});

describe('createFacadeMaterial', () => {
  it('returns a Lambert material that keeps debug switches working', () => {
    const material = createFacadeMaterial({ detail: true, night: 0 });
    expect(material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(material).toBeInstanceOf(THREE.Material);
    expect(material.name).toBe('IsometricMinskFacade');
    const lambert = material as THREE.MeshLambertMaterial;
    expect(lambert.fog).toBe(true);
    expect(lambert.vertexColors).toBe(false);
    expect(lambert.flatShading).toBe(true);
    // wireframe is a built-in Lambert property used by the debug control.
    expect('wireframe' in lambert).toBe(true);
    disposeFacadeMaterial(material);
  });

  it('maps the options onto the uniforms', () => {
    const detailOn = createFacadeMaterial({ detail: true, night: 0.25 });
    expect(uniformsOf(detailOn).uDetailScale.value).toBe(1);
    expect(uniformsOf(detailOn).uNight.value).toBe(0.25);
    expect(uniformsOf(detailOn).uPaletteMix.value).toBe(1); // quantise defaults on
    expect(uniformsOf(detailOn).uPixelSize.value).toBeGreaterThan(0);
    expect(uniformsOf(detailOn).uTimeHours.value).toBe(13);

    const detailOff = createFacadeMaterial({ detail: false, night: 0, quantise: false });
    expect(uniformsOf(detailOff).uDetailScale.value).toBe(0);
    expect(uniformsOf(detailOff).uPaletteMix.value).toBe(0);

    const clamped = createFacadeMaterial({ detail: true, night: 4 });
    expect(uniformsOf(clamped).uNight.value).toBe(1);

    disposeFacadeMaterial(detailOn);
    disposeFacadeMaterial(detailOff);
    disposeFacadeMaterial(clamped);
  });

  it('uploads the 41 recipe preset rows as vec4 arrays', () => {
    const material = createFacadeMaterial({ detail: true, night: 0 });
    const uniforms = uniformsOf(material);
    expect(uniforms.uPresetA.value.length).toBe(FACADE_PRESET_COUNT * 4);
    expect(uniforms.uPresetB.value.length).toBe(FACADE_PRESET_COUNT * 4);
    expect(uniforms.uRecipeMotif.value.length).toBe(FACADE_PRESET_COUNT);
    // Family rows 0..26 come from the catalog + motif overrides.
    STYLE_RECIPES.forEach((recipe, index) => {
      const preset = presetForRecipe(recipe);
      expect(uniforms.uPresetA.value[index * 4]).toBeCloseTo(preset.bayWidth, 5);
      expect(uniforms.uPresetA.value[index * 4 + 1]).toBeCloseTo(preset.windowWidthRatio, 5);
      expect(uniforms.uPresetA.value[index * 4 + 2]).toBeCloseTo(preset.windowHeightRatio, 5);
      expect(uniforms.uPresetA.value[index * 4 + 3]).toBeCloseTo(preset.sillRatio, 5);
      expect(uniforms.uPresetB.value[index * 4]).toBeCloseTo(preset.floorHeight, 5);
      expect(uniforms.uPresetB.value[index * 4 + 1]).toBeCloseTo(preset.groundFloorHeight, 5);
      expect(uniforms.uPresetB.value[index * 4 + 2]).toBeCloseTo(preset.balconyRatio, 5);
      expect(uniforms.uPresetB.value[index * 4 + 3]).toBeCloseTo(preset.corniceHeight, 5);
    });
    // Legacy rows 27..37 must be byte-for-byte the previous archetype presets.
    ARCHETYPE_BY_ID.forEach((archetype, index) => {
      const row = LEGACY_RECIPE_OFFSET + index;
      const preset = FACADE_PRESETS[archetype];
      expect(uniforms.uPresetA.value[row * 4]).toBeCloseTo(preset.bayWidth, 5);
      expect(uniforms.uPresetA.value[row * 4 + 1]).toBeCloseTo(preset.windowWidthRatio, 5);
      expect(uniforms.uPresetA.value[row * 4 + 2]).toBeCloseTo(preset.windowHeightRatio, 5);
      expect(uniforms.uPresetA.value[row * 4 + 3]).toBeCloseTo(preset.sillRatio, 5);
      expect(uniforms.uPresetB.value[row * 4]).toBeCloseTo(preset.floorHeight, 5);
      expect(uniforms.uPresetB.value[row * 4 + 1]).toBeCloseTo(preset.groundFloorHeight, 5);
      expect(uniforms.uPresetB.value[row * 4 + 2]).toBeCloseTo(preset.balconyRatio, 5);
      expect(uniforms.uPresetB.value[row * 4 + 3]).toBeCloseTo(preset.corniceHeight, 5);
      expect(uniforms.uRecipeMotif.value[row]).toBe(FACADE_MOTIF_IDS.legacy);
    });
    // Explicit checks for the protected/legacy archetypes named by the plan.
    for (const archetype of ['palace', 'stadium', 'small', 'panel'] as const) {
      const row = LEGACY_RECIPE_OFFSET + ARCHETYPE_ID[archetype];
      const preset = FACADE_PRESETS[archetype];
      expect(uniforms.uPresetA.value[row * 4]).toBeCloseTo(preset.bayWidth, 5);
      expect(uniforms.uPresetB.value[row * 4]).toBeCloseTo(preset.floorHeight, 5);
      expect(uniforms.uPresetB.value[row * 4 + 1]).toBeCloseTo(preset.groundFloorHeight, 5);
      expect(presetForRecipe(legacyRecipeFor(archetype)).colors).toEqual([...preset.colors]);
    }
    // Motif rows: family rows carry their motif id, legacy rows carry -1.
    const motifs = motifRowsForUniforms();
    expect(motifs.length).toBe(FACADE_PRESET_COUNT);
    expect(motifs[0]).toBe(FACADE_MOTIF_IDS.monument);
    expect(motifs[18]).toBe(FACADE_MOTIF_IDS.clerestory);
    expect(motifs[26]).toBe(FACADE_MOTIF_IDS.assembly_hall);
    expect(motifs[27]).toBe(FACADE_MOTIF_IDS.legacy);
    // Renderer-only shells: church / monument / assembly hall.
    expect(motifs[38]).toBe(FACADE_MOTIF_IDS.church);
    expect(motifs[39]).toBe(FACADE_MOTIF_IDS.monument);
    expect(motifs[40]).toBe(FACADE_MOTIF_IDS.assembly_hall);
    disposeFacadeMaterial(material);
  });

  it('uploads the canonical palette as raw sRGB vec3 data', () => {
    const material = createFacadeMaterial({ detail: true, night: 0 });
    const values = uniformsOf(material).uPalette.value;
    expect(values.length).toBe(PIXEL_PALETTE.length * 3);
    PIXEL_PALETTE.forEach((hex, index) => {
      const unit = hexToRgbUnit(hex);
      expect(values[index * 3]).toBeCloseTo(unit.r, 5);
      expect(values[index * 3 + 1]).toBeCloseTo(unit.g, 5);
      expect(values[index * 3 + 2]).toBeCloseTo(unit.b, 5);
    });
    disposeFacadeMaterial(material);
  });

  it('patches Lambert shaders and merges its uniforms through onBeforeCompile', () => {
    const material = createFacadeMaterial({ detail: true, night: 0.5, quantise: true });
    const shader = {
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
      uniforms: {} as Record<string, THREE.IUniform>,
    };
    material.onBeforeCompile(
      shader as unknown as Parameters<THREE.Material['onBeforeCompile']>[0],
      {} as THREE.WebGLRenderer,
    );
    expect(shader.vertexShader).toContain('vFacadeUV = aUV;');
    expect(shader.fragmentShader).toContain('facadeShade(');
    for (const name of Object.keys(uniformsOf(material))) {
      expect(shader.uniforms[name], `uniform ${name} not merged`).toBeDefined();
    }
    disposeFacadeMaterial(material);
  });
});

describe('updateFacadeUniforms', () => {
  it('updates every documented uniform and clamps the values', () => {
    const material = createFacadeMaterial({ detail: true, night: 0 });
    updateFacadeUniforms(material, {
      night: 0.5,
      detailScale: 0.25,
      pixelSize: 1.5,
      paletteMix: 0.75,
      timeHours: 21.5,
    });
    const uniforms = uniformsOf(material);
    expect(uniforms.uNight.value).toBe(0.5);
    expect(uniforms.uDetailScale.value).toBe(0.25);
    expect(uniforms.uPixelSize.value).toBe(1.5);
    expect(uniforms.uPaletteMix.value).toBe(0.75);
    expect(uniforms.uTimeHours.value).toBe(21.5);

    updateFacadeUniforms(material, { night: 5, detailScale: -2, pixelSize: 0, paletteMix: 9, timeHours: -1 });
    expect(uniforms.uNight.value).toBe(1);
    expect(uniforms.uDetailScale.value).toBe(0);
    expect(uniforms.uPixelSize.value).toBeGreaterThan(0);
    expect(uniforms.uPaletteMix.value).toBe(1);
    expect(uniforms.uTimeHours.value).toBe(23);
    disposeFacadeMaterial(material);
  });

  it('parses time-of-day hours into 0..24 and keeps NaN out', () => {
    const material = createFacadeMaterial({ detail: true, night: 0 });
    updateFacadeUniforms(material, { timeHours: 25.5 });
    expect(uniformsOf(material).uTimeHours.value).toBe(1.5);
    updateFacadeUniforms(material, { timeHours: Number.NaN, night: Number.NaN });
    expect(Number.isFinite(uniformsOf(material).uNight.value)).toBe(true);
    expect(Number.isFinite(uniformsOf(material).uTimeHours.value)).toBe(true);
    disposeFacadeMaterial(material);
  });

  it('is a safe no-op on materials without facade uniforms', () => {
    const plain = new THREE.MeshLambertMaterial({ vertexColors: true });
    expect(() => updateFacadeUniforms(plain, { night: 0.4 })).not.toThrow();
    expect(() => updateFacadeUniforms(plain, {})).not.toThrow();
    expect(() => updateFacadeUniforms(plain, { unknownUniform: 1 } as never)).not.toThrow();
    expect(() =>
      updateFacadeUniforms({ userData: {} } as unknown as THREE.Material, { night: 0.4 }),
    ).not.toThrow();
    expect(() =>
      updateFacadeUniforms(undefined as unknown as THREE.Material, { night: 0.4 }),
    ).not.toThrow();
  });

  it('ignores unknown update keys on a real facade material', () => {
    const material = createFacadeMaterial({ detail: true, night: 0.2 });
    expect(() =>
      updateFacadeUniforms(material, { unknownUniform: 1 } as never),
    ).not.toThrow();
    expect(uniformsOf(material).uNight.value).toBeCloseTo(0.2, 5);
    disposeFacadeMaterial(material);
  });
});

describe('createFacadeUniforms', () => {
  it('can be built independently for tests and advanced wiring', () => {
    const uniforms = createFacadeUniforms({ detail: false, night: 0.1, quantise: false });
    expect(uniforms.uDetailScale.value).toBe(0);
    expect(uniforms.uPaletteMix.value).toBe(0);
    expect(uniforms.uPresetA.value.length).toBeGreaterThan(0);
    expect(uniforms.uPalette.value.length).toBe(PIXEL_PALETTE_SIZE * 3);
    expect(uniforms.uTrimColor.value).toBeInstanceOf(THREE.Vector3);
  });
});

describe('disposeFacadeMaterial', () => {
  it('disposes facade materials and is safe on plain / missing materials', () => {
    const material = createFacadeMaterial({ detail: true, night: 0 });
    expect(() => disposeFacadeMaterial(material)).not.toThrow();
    expect(() => disposeFacadeMaterial(material)).not.toThrow();
    expect(() => disposeFacadeMaterial(new THREE.MeshLambertMaterial())).not.toThrow();
    expect(() => disposeFacadeMaterial(undefined as unknown as THREE.Material)).not.toThrow();
  });
});

describe('createEnvironmentMaterial', () => {
  it('is plain stock Lambert: the environment colour must be multiplied once', () => {
    const material = createEnvironmentMaterial();
    expect(material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(material.name).toBe('IsometricMinskEnvironment');
    const lambert = material as THREE.MeshLambertMaterial;
    expect(lambert.vertexColors).toBe(true);
    expect(lambert.flatShading).toBe(true);
    // No onBeforeCompile override: stock <color_fragment> applies the vertex
    // colour exactly once (a custom patch previously squared it).
    expect(material.onBeforeCompile).toBe(THREE.Material.prototype.onBeforeCompile);
    material.dispose();
  });
});

describe('createMaterialSet', () => {
  it('creates a facade + environment pair with one dispose()', () => {
    const set = createMaterialSet({ detail: true, night: 0 });
    expect(set.facade).toBeInstanceOf(THREE.Material);
    expect(set.environment).toBeInstanceOf(THREE.Material);
    expect(set.facade).not.toBe(set.environment);
    expect(() => set.dispose()).not.toThrow();
  });
});
