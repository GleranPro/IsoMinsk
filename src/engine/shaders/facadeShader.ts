/**
 * Isometric Minsk — procedural facade GLSL.
 *
 * The facade material is a MeshLambertMaterial whose shaders are patched here
 * through `onBeforeCompile`. Keeping the three.js lighting/shadow/fog pipeline
 * means facades keep crisp sun shadows and fog for free; we only replace the
 * albedo/emissive computation and append a palette quantisation step.
 *
 * Vertex contract (see src/shared/geometry.ts):
 *   aUV    vec2  wall: u = metres along the facade, v = metres above base.
 *   aColor vec3  sRGB base colour of this face.
 *   aStyle vec4  archetype id, floor height (m), ground floor height (m), seed.
 *   aFace  vec4  face kind, style flags bitmask, trim intensity 0..1,
 *                detail hint 0..1 — EXCEPT on FACE_KIND.roof / roofRidge where
 *                geometry.ts defines aFace.w as ROOF_SHAPE_ID.
 *
 * The modules exports every injected chunk as a testable string constant; the
 * patch helpers are pure string functions so tests can apply them to three's
 * stock Lambert shader without a GPU.
 *
 * Ownership: facades / art-direction module.
 */

import { PIXEL_PALETTE_SIZE } from '../postprocess/palette';
import { ARCHETYPE_BY_ID } from '../../shared/geometry';
import { FACADE_PRESET_COUNT } from '../../shared/buildingStyles';

/** Compile-time size of the `uPalette` uniform array (mirrors PIXEL_PALETTE). */
export const FACADE_PALETTE_SIZE = PIXEL_PALETTE_SIZE;

/**
 * Compile-time number of archetype entries used for the broad-archetype
 * semantics (`aStyle.x`): palace/stadium material handling stays keyed on this.
 */
export const FACADE_ARCHETYPE_COUNT = ARCHETYPE_BY_ID.length;

/**
 * Compile-time number of preset rows in `uPresetA/B` and `uRecipeMotif`:
 * 27 family recipes + 11 legacy archetype presets + 3 renderer shells = 41,
 * indexed by the packed recipe id (bits 8..15 of `aFace.y`).
 */
export const FACADE_PRESET_ROWS = FACADE_PRESET_COUNT;

/** Program cache key for facade materials (identical GLSL for all instances). */
export const FACADE_PROGRAM_CACHE_KEY = 'isometric-minsk-facade-v4';

/** Float uniforms the facade shader exposes (for tests / renderer wiring). */
export const FACADE_FLOAT_UNIFORMS = [
  'uNight',
  'uDetailScale',
  'uPixelSize',
  'uPaletteMix',
  'uTimeHours',
  'uWinter',
  'uSnowCell',
  'uAutumn',
] as const;

/** Vertex attributes the facade shader consumes. */
export const FACADE_VERTEX_ATTRIBUTES = ['aUV', 'aColor', 'aStyle', 'aFace'] as const;

/**
 * Shader motif ids, matching `FACADE_MOTIFS` order in buildingStyles.ts.
 * `-1` marks a legacy archetype preset row (pre-recipe branches only).
 */
export const FACADE_MOTIF_IDS = {
  legacy: -1,
  monument: 0,
  historic: 1,
  grid: 2,
  loggia: 3,
  balcony_stack: 4,
  staircore: 5,
  ribbon: 6,
  clerestory: 7,
  blank_service: 8,
  assembly_hall: 9,
  church: 10,
} as const;

export const FACADE_VERTEX_DECLARATIONS = /* glsl */ `
attribute vec2 aUV;
attribute vec3 aColor;
attribute vec4 aStyle;
attribute vec4 aFace;

varying vec2 vFacadeUV;
varying vec3 vFacadeColor;
varying vec4 vFacadeStyle;
varying vec4 vFacadeFace;
varying vec3 vFacadeWorldPos;
varying float vFacadeWorldUp;
`;

export const FACADE_VERTEX_BODY = /* glsl */ `
vFacadeUV = aUV;
vFacadeColor = aColor;
vFacadeStyle = aStyle;
vFacadeFace = aFace;
vFacadeWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vFacadeWorldUp = normalize(mat3(modelMatrix) * objectNormal).y;
`;

export const FACADE_FRAGMENT_DECLARATIONS = /* glsl */ `
#define FACADE_PALETTE_SIZE ${FACADE_PALETTE_SIZE}
#define FACADE_ARCHETYPE_COUNT ${FACADE_ARCHETYPE_COUNT}
#define FACADE_PRESET_ROWS ${FACADE_PRESET_ROWS}

// Motif ids, matching FACADE_MOTIFS order in src/shared/buildingStyles.ts.
#define FACADE_MOTIF_LEGACY -1
#define FACADE_MOTIF_MONUMENT 0
#define FACADE_MOTIF_HISTORIC 1
#define FACADE_MOTIF_GRID 2
#define FACADE_MOTIF_LOGGIA 3
#define FACADE_MOTIF_BALCONY_STACK 4
#define FACADE_MOTIF_STAIRCORE 5
#define FACADE_MOTIF_RIBBON 6
#define FACADE_MOTIF_CLERESTORY 7
#define FACADE_MOTIF_BLANK_SERVICE 8
#define FACADE_MOTIF_ASSEMBLY_HALL 9
#define FACADE_MOTIF_CHURCH 10

uniform float uNight;
uniform float uDetailScale;
uniform float uPixelSize;
uniform float uPaletteMix;
uniform float uTimeHours;
// Seasons P1: snow on roofs and horizontal trim only (walls stay clean).
uniform float uWinter;
uniform float uSnowCell;
// Seasons P3: autumn/winter wetness for streaks and a dark plinth.
uniform float uAutumn;

uniform vec4 uPresetA[FACADE_PRESET_ROWS];
uniform vec4 uPresetB[FACADE_PRESET_ROWS];
// Per-recipe-row motif id (-1 = legacy archetype preset row).
uniform float uRecipeMotif[FACADE_PRESET_ROWS];

uniform vec3 uGlassColor;
uniform vec3 uGlassLightColor;
uniform vec3 uNightDarkColor;
uniform vec3 uNightLitColor;
uniform vec3 uNightWarmColor;
uniform vec3 uShopfrontColor;
uniform vec3 uTrimColor;
uniform vec3 uPalette[FACADE_PALETTE_SIZE];

varying vec2 vFacadeUV;
varying vec3 vFacadeColor;
varying vec4 vFacadeStyle;
varying vec4 vFacadeFace;
varying vec3 vFacadeWorldPos;
varying float vFacadeWorldUp;

// ---------------------------------------------------------------- utilities

float facadeHash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float facadeHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 facadeSrgbToLinear(vec3 c) {
  return sRGBTransferEOTF(vec4(clamp(c, 0.0, 8.0), 1.0)).rgb;
}

bool facadeFlag(int flags, int bit) {
  return (flags & bit) != 0;
}

float facadeRect(vec2 p, vec2 lo, vec2 hi, vec2 aa) {
  vec2 a = smoothstep(lo - aa, lo + aa, p);
  vec2 b = 1.0 - smoothstep(hi - aa, hi + aa, p);
  return a.x * b.x * a.y * b.y;
}

float facadeBand(float x, float lo, float hi, float aa) {
  float w = max(aa, 0.00001);
  return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
}

// Fixed world-anchored snow octaves; uSnowCell cross-fades them so roof snow
// stays pinned to the building while zooming (no sideways "scroll").
float facadeSnowNoise(vec2 world) {
  float fine = facadeHash21(floor(world / 2.0) + 17.0);
  float coarse = facadeHash21(floor(world / 8.0) + 29.0);
  return mix(fine, coarse, smoothstep(4.0, 12.0, uSnowCell));
}

// --------------------------------------------------------------------- snow
// Seasons P1: snow is a property of the face, not a screen filter.
//   roof / roofRidge: cover by world-up slope (flat roofs solid, steep slopes
//     shed it); trim: a light cap on cornices and parapets.
//   walls / ground / glass: gate 0 — the rejected winter whitened walls and
//   windows too, which is exactly what must never happen again.
// Colours are display sRGB and match the cold entries in PIXEL_PALETTE.

const vec3 FACADE_SNOW_THIN = vec3(0.812, 0.855, 0.882);   // #cfdae1
const vec3 FACADE_SNOW_DEEP = vec3(0.933, 0.957, 0.969);   // #eef4f7
const vec3 FACADE_SNOW_SHADOW = vec3(0.576, 0.643, 0.698); // #93a4b2

float facadeSnowCover(float faceKind, float up) {
  if (uWinter < 0.001) return 0.0;
  float u = clamp(up, 0.0, 1.0);
  float isRoof = step(0.5, faceKind) * step(faceKind, 1.5)
    + step(4.5, faceKind) * step(faceKind, 5.5);
  float isTrim = step(2.5, faceKind) * step(faceKind, 3.5);
  float gate = clamp(isRoof + isTrim * 0.45, 0.0, 1.0);
  if (gate < 0.001) return 0.0;
  float slope = smoothstep(0.50, 0.80, u);
  float n = facadeSnowNoise(vFacadeWorldPos.xz);
  float cover = gate * slope * smoothstep(0.30, 0.55, n * 0.6 + 0.55 * u);
  // Keep a fifth of the roofing colour: a fully white slab loses the tile
  // material and merges the roof into the snowy ground.
  cover *= 0.80;
  return clamp(cover * uWinter, 0.0, 1.0);
}

vec3 facadeApplySnow(vec3 albedo, float faceKind, float up) {
  float cover = facadeSnowCover(faceKind, up);
  if (cover < 0.001) return albedo;
  float u = clamp(up, 0.0, 1.0);
  vec3 snow = mix(FACADE_SNOW_SHADOW, FACADE_SNOW_THIN, smoothstep(0.0, 0.55, u));
  snow = mix(snow, FACADE_SNOW_DEEP, smoothstep(0.55, 0.95, u));
  return mix(albedo, snow, cover);
}

// -------------------------------------------------------------------- roofs

vec3 facadeRoof(vec2 uv, vec3 baseSrgb, float shape, float ridge, float seed, float mPerPx, float detail) {
  vec3 roof = baseSrgb;
  float px = max(mPerPx, 0.0001);
  bool dome = shape > 4.5 && shape < 5.5;
  bool courses = !dome && (
    ridge > 0.5                         // FACE_KIND.roofRidge: any sloped roof surface
    || (shape > 0.5 && shape < 4.5)     // gabled / hipped / pyramidal / skillion
    || shape > 5.5                      // complex roof
  );

  if (courses) {
    // Shingle / metal-rib courses; fade to the flat roof tint when sub-pixel.
    float course = 0.34;
    float courseFade = smoothstep(1.3, 3.2, course / px) * detail;
    float rowF = fract(uv.y / course);
    float row = floor(uv.y / course);
    float tone = facadeHash21(vec2(row, seed * 47.0));
    roof *= mix(1.0, mix(0.96, 1.04, tone), courseFade);
    roof *= mix(1.0, mix(0.90, 1.0, rowF), courseFade);
    float edge = facadeBand(rowF, 0.0, 0.16, 0.05) * courseFade;
    roof = mix(roof, roof * 1.08 + 0.008, edge * 0.5);
  } else {
    // Flat roof: very subtle two-tone patches + gravel speckle, faded out at
    // distance. Kept low-contrast: at close zoom large flat roofs must read as
    // quiet surfaces, not checkerboards.
    float patchFade = smoothstep(1.4, 3.0, 1.2 / px) * detail;
    vec2 patchCell = floor(uv / 2.0);
    float patchVal = facadeHash21(patchCell + seed * 13.0);
    vec3 detailed = baseSrgb
      * mix(0.975, 1.025, patchVal)
      * mix(0.99, 1.01, facadeHash21(floor(uv * 2.5) + seed));
    roof = mix(baseSrgb, detailed, patchFade);
    if (dome) {
      float bandFade = smoothstep(1.2, 3.0, 1.0 / px) * detail;
      float bands = 0.5 + 0.5 * sin(uv.y * 2.2 + seed * 6.283);
      roof *= mix(1.0, mix(0.975, 1.025, bands), bandFade);
    }
  }
  return roof;
}

// --------------------------------------------------------------------- trim

vec3 facadeTrimShade(vec2 uv, vec3 baseSrgb, float trimK, float seed, float mPerPx, int archetype) {
  // Strong, light cornice/parapet: trim faces are often sub-pixel at overview
  // zoom, so they need clear value contrast against the wall to dither in as a
  // visible cornice line rather than disappearing.
  vec3 trim = baseSrgb * mix(1.0, 1.47, clamp(trimK, 0.0, 1.0));
  float px = max(mPerPx, 0.0001);
  float textureFade = smoothstep(1.2, 2.6, 0.5 / px);
  trim *= 1.0 + (facadeHash21(floor(uv * 2.0) + seed * 71.0) - 0.5) * 0.05 * textureFade;
  if (0.18 / px > 1.4) {
    float groove = facadeBand(fract(uv.y / 0.18), 0.0, 0.10, 0.03);
    trim *= 1.0 - groove * 0.10;
  }
  // Palace of the Republic: a strong double-line cornice/attic. The trim band is
  // corniceHeight (~1.4 m) tall, so two ~0.7 m courses read as double lines at
  // close/medium zoom and dither into a bright cap at overview zoom.
  float palaceity = step(8.5, float(archetype)) * step(float(archetype), 9.5);
  if (palaceity > 0.5) {
    float course = 0.7;
    float f = fract(uv.y / course);
    float line = facadeBand(f, 0.0, 0.22, 0.05);
    trim = mix(trim, trim * 1.32 + 0.022, line * 0.9);
    float shadowLine = facadeBand(f, 0.30, 0.42, 0.05);
    trim *= 1.0 - shadowLine * 0.28;
  }
  return trim;
}

// ------------------------------------------------------- continuous glazing
// FACE_KIND.glass: shopfronts on the ground floor, ribbon office glazing above.

vec3 facadeGlazing(vec2 uv, vec3 baseSrgb, float groundHeight, float seed, float mPerPx, float detail, out vec3 emit) {
  emit = vec3(0.0);
  float night = clamp(uNight, 0.0, 1.0);
  float px = max(mPerPx, 0.0001);
  float gh = max(groundHeight, 0.9);
  // 0 at overview zoom (averaged glass band), 1 when the glazing grid is legible.
  float fine = smoothstep(2.6, 5.5, gh / px) * detail;

  float shop = 1.0 - smoothstep(gh * 0.7, gh * 1.02, uv.y);
  float interiorVar = facadeHash21(vec2(floor(uv.x / 1.5), floor(uv.y / 2.9)) + seed * 37.0);
  vec3 interior = mix(uShopfrontColor, uNightWarmColor, 0.35 + 0.45 * interiorVar);

  vec3 glass = mix(uGlassColor, uGlassLightColor, 0.36 + 0.28 * facadeHash21(uv * 0.37 + seed));
  glass *= mix(0.84, 1.18, smoothstep(0.0, 14.0, uv.y));
  // Glassy teal cast shared by shopfronts and office glazing.
  glass = mix(glass, glass * vec3(0.88, 1.02, 1.08), 0.6);

  // Mullions/transoms are kept at >= ~2 px pitch so they never alias to noise.
  float mullPeriod = max(1.5, 2.0 * px);
  float mullF = fract(uv.x / mullPeriod);
  float mull = facadeBand(min(mullF, 1.0 - mullF), 0.0, max(1.2 * px, 0.02) / mullPeriod, 0.02) * fine;
  float transomPeriod = max(2.9, 2.2 * px);
  float transomF = fract(uv.y / transomPeriod);
  float transom = facadeBand(min(transomF, 1.0 - transomF), 0.0, max(1.2 * px, 0.02) / transomPeriod, 0.02) * fine;
  float frame = max(mull, transom);
  vec3 dayGlass = mix(glass, uTrimColor * 0.55, frame * 0.8);

  vec3 nightGlass = mix(dayGlass, uNightDarkColor, night * 0.72);
  nightGlass = mix(nightGlass, interior, night * shop * 0.6);

  float cell = floor(uv.x / mullPeriod) * 1.7 + floor(uv.y / transomPeriod) * 3.1 + seed * 37.0;
  float litHash = facadeHash21(vec2(cell, seed * 13.0));
  float lit = step(litHash, night * (0.3 + 0.5 * shop));
  vec3 litCol = mix(uNightLitColor, uNightWarmColor, facadeHash21(vec2(litHash * 91.0, seed * 7.0)));
  float pane = (1.0 - frame) * detail;

  vec3 outGlass = mix(dayGlass, nightGlass, night);
  outGlass = mix(outGlass, litCol, lit * pane * night * 0.9);

  // Far LOD: one averaged glass band with a dark reveal at its top, so the
  // ground floor still reads as a distinct band at overview zoom.
  vec3 avgGlass = mix(uShopfrontColor, uGlassColor, 0.35);
  avgGlass = mix(avgGlass, interior, night * (0.3 + 0.4 * shop));
  outGlass = mix(avgGlass, outGlass, fine);
  float reveal = facadeBand(uv.y, gh - max(1.6 * px, 0.08), gh, max(0.7 * px, 0.02)) * (1.0 - fine);
  outGlass = mix(outGlass, uTrimColor * 0.72, reveal * 0.45);

  // Shopfronts glow a bit even when no individual cell is "lit".
  emit += facadeSrgbToLinear(interior) * night * shop * detail * mix(0.30, 0.16, fine);
  emit += facadeSrgbToLinear(litCol) * lit * pane * night * (0.4 + 0.45 * shop);

  return mix(baseSrgb, outGlass, detail);
}

// ------------------------------------------------------------- upper floors

vec3 facadeUpperFloors(
  vec2 uv,
  vec3 wallSrgb,
  float floorHeight,
  float groundHeight,
  vec4 presetA,
  float balconyRatio,
  float seed,
  int flags,
  int archetype,
  int motif,
  float mPerPx,
  float detail,
  float trimK,
  out vec3 emit
) {
  emit = vec3(0.0);
  float night = clamp(uNight, 0.0, 1.0);
  float px = max(mPerPx, 0.0001);
  float bay = max(presetA.x, 1.2);
  float fh = max(floorHeight, 1.8);
  float gh = max(groundHeight, 0.8);
  float winWRatio = clamp(presetA.y, 0.04, 1.0);
  float winHRatio = clamp(presetA.z, 0.04, 0.94);
  float sillRatio = clamp(presetA.w, 0.0, 0.7);

  bool blank = facadeFlag(flags, 64);
  bool ribbon = facadeFlag(flags, 32);
  bool pilasters = facadeFlag(flags, 16);
  bool balconies = facadeFlag(flags, 2);

  // --- screen-space LOD ---------------------------------------------------
  // At the default overview zoom (orthoHeight ~420 m, 320 px tall => ~0.38
  // px/m) a real 2.8 m floor is barely 1 px. Keep the facade texture at a
  // minimum pitch of ~2.5 px by merging floors/bays (screen-space LOD, common
  // pixel-art practice) instead of letting windows alias to noise. At street
  // zoom (>= ~5 px per floor/bay) the real metrics are used unchanged.
  float baseMinPx = min(bay / px, fh / px);
  float lodFade = smoothstep(1.6, 4.5, baseMinPx);
  float bayLod = mix(max(bay, 2.5 * px), bay, lodFade);
  float fhLod = mix(max(fh, 2.6 * px), fh, lodFade);
  float textureFade = smoothstep(1.4, 3.0, baseMinPx);
  float panelity = step(1.5, float(archetype)) * step(float(archetype), 2.5);
  float modernity = step(2.5, float(archetype)) * step(float(archetype), 3.5);
  // Palace of the Republic (id 9): colonnade rhythm, paired tall windows.
  float palaceity = step(8.5, float(archetype)) * step(float(archetype), 9.5);
  // Stadium (id 10): blank concrete bowl with a sparse horizontal glazing band.
  float stadiumity = step(9.5, float(archetype)) * step(float(archetype), 10.5);

  float colF = uv.x / bayLod;
  float col = floor(colF);
  float u = fract(colF);
  float yy = max(uv.y - gh, 0.0);
  float rowF = yy / fhLod;
  float row = floor(rowF);
  float v = fract(rowF);

  // Palace bays between pilasters hold a symmetric pair of tall windows, so the
  // window lattice uses a half-bay pitch while pilasters/balconies stay on the
  // full bay pitch.
  float winPitch = mix(bayLod, bayLod * 0.5, palaceity);
  float colWinF = uv.x / winPitch;
  float colWin = floor(colWinF);
  float uWin = fract(colWinF);

  float bayPx = bayLod / px;
  float floorPx = fhLod / px;
  // The LOD above guarantees a >= ~2.5 px pitch, so windows can stay crisp
  // (hard-edged 1-3 px rectangles) at every zoom; the old cross-fade to a flat
  // averaged tone was what turned distant facades into speckled mush.
  float crisp = smoothstep(1.2, 2.3, min(bayPx, floorPx));

  // Windows are enlarged to at least ~1.6 px so each one stays a readable dark
  // pixel against a light wall even after the low-res frame is upscaled.
  float winW = mix(winWRatio, 1.0, ribbon ? 1.0 : 0.0);
  winW = clamp(max(winW, 1.60 * px / winPitch), 0.05, 0.97);
  float winH = winHRatio;
  winH = clamp(max(winH, 1.70 * px / fhLod), 0.05, 0.94);
  float sillR = min(sillRatio, max(1.0 - winH - 0.02, 0.0));
  vec2 winLo = vec2(0.5 - winW * 0.5, sillR);
  vec2 winHi = vec2(0.5 + winW * 0.5, sillR + winH);

  float aaU = max(0.35 * px, 0.0015) / bayLod;
  float aaV = max(0.35 * px, 0.0015) / fhLod;
  float aaWin = max(0.35 * px, 0.0015) / winPitch;

  float winCrisp = facadeRect(vec2(uWin, v), winLo, winHi, vec2(aaWin, aaV));
  float winAverage = winW * winH;
  float win = mix(winAverage, winCrisp, crisp) * detail;
  if (blank) win = 0.0;
  // Stadium: replace punched windows with one continuous clerestory glazing band
  // per stand level (the geometry builder tags stadium walls as blank).
  if (stadiumity > 0.5) {
    float band = facadeRect(vec2(uWin, v), vec2(0.03, 0.58), vec2(0.97, 0.74), vec2(aaWin, aaV));
    win = band * detail;
  }

  vec3 outWall = wallSrgb;
  // Slab / spandrel line: the floor rhythm. Panel blocks get a stronger, darker
  // joint band so their precast structure reads at overview zoom.
  float slab = facadeBand(v, 0.0, 0.05, aaV);
  float slabStrength = mix(0.12, 0.06, textureFade) * mix(1.0, 1.75, panelity);
  outWall *= 1.0 - slab * slabStrength * detail;
  outWall *= 1.0 + (facadeHash21(vec2(col * 1.7 + seed * 31.0, row * 0.7 + 3.0)) - 0.5)
    * 0.03 * detail * textureFade;
  // Stadium concrete: faint horizontal formwork joints instead of window rows.
  if (stadiumity > 0.5) {
    float joint = facadeBand(fract(uv.y / 2.4), 0.0, 0.03, 0.02) * 0.10 * detail;
    outWall *= 1.0 - joint;
  }

  // --------------------------------------------------------- motif grammar
  // Recipe-driven facade families. Every branch reuses the same real-metre
  // coordinates as the punched windows, so painted openings and the geometry
  // frames added by the detail modules stay aligned. Legacy preset rows
  // (motif < 0) never enter these branches, so old tiles are unchanged.
  if (motif >= 0 && !blank) {
    if (motif == FACADE_MOTIF_LOGGIA) {
      // Whole-bay loggia: dark recessed band bounded by a slab and a rail.
      float bayRun = step(0.34, facadeHash11(col * 1.7 + seed * 13.0));
      float band = facadeRect(vec2(u, v), vec2(0.05, 0.14), vec2(0.95, 0.88), vec2(aaU, aaV));
      band *= bayRun * crisp * detail;
      vec3 loggiaGlass = mix(uShopfrontColor, uGlassColor, 0.42);
      loggiaGlass = mix(loggiaGlass, uGlassLightColor, 0.16);
      outWall = mix(outWall, loggiaGlass, band * 0.94);
      float loggiaSlab = facadeBand(v, 0.02, 0.13, aaV) * bayRun * detail;
      outWall = mix(outWall, uTrimColor * 0.94, loggiaSlab * 0.85);
      float loggiaRail = facadeBand(v, 0.88, 0.93, aaV) * bayRun * crisp * detail;
      outWall = mix(outWall, uTrimColor * 0.80, loggiaRail * 0.75);
      win *= 1.0 - band;
    } else if (motif == FACADE_MOTIF_STAIRCORE) {
      // One continuous glazed stair core against subdued panel bands.
      float coreCol = floor(facadeHash11(seed * 3.71 + 0.19) * 4.0);
      float core = step(abs(col - coreCol), 0.5) * detail;
      float coreGlass = facadeRect(vec2(u, v), vec2(0.26, 0.0), vec2(0.74, 1.0), vec2(aaU, aaV));
      coreGlass *= core * mix(0.55, 1.0, crisp);
      vec3 coreDay = mix(uGlassColor, uGlassLightColor, 0.34);
      outWall = mix(outWall, coreDay, coreGlass * 0.92);
      float coreMullF = fract(v * 2.4);
      float coreMull = facadeBand(min(coreMullF, 1.0 - coreMullF), 0.0, max(0.9 * px, 0.02), 0.02) * core;
      outWall = mix(outWall, uTrimColor * 0.6, coreMull * 0.5);
      win *= 1.0 - coreGlass;
    } else if (motif == FACADE_MOTIF_RIBBON) {
      // Continuous ribbon glazing: the slab line is painted, not carved.
      float spandrel = facadeBand(v, 0.0, 0.16, aaV) * detail;
      outWall *= 1.0 - spandrel * 0.10;
    } else if (motif == FACADE_MOTIF_CLERESTORY) {
      // Industrial halls: tall openings in the upper band over a solid sill.
      float clerestoryTop = min(0.60 + 0.28, 0.96);
      float clerestory = facadeRect(vec2(uWin, v), vec2(0.02, 0.60), vec2(0.98, clerestoryTop), vec2(aaWin, aaV));
      clerestory *= crisp * detail;
      outWall = mix(outWall, mix(uGlassColor, uGlassLightColor, 0.3), clerestory * 0.88);
      win = mix(win, clerestory, 0.85);
    } else if (motif == FACADE_MOTIF_BLANK_SERVICE) {
      // Bounded blank service zones, never a fully windowless facade.
      float zone = step(0.55, u) * step(0.5, facadeHash11(col * 1.31 + seed * 5.0));
      win *= 1.0 - zone * 0.9;
    } else if (motif == FACADE_MOTIF_ASSEMBLY_HALL) {
      // Higher blank wall mass with sparse high glazing only.
      float highGlazing = facadeRect(vec2(uWin, v), vec2(0.18, 0.72), vec2(0.82, 0.90), vec2(aaWin, aaV));
      highGlazing *= step(0.5, mod(row, 2.0)) * crisp * detail;
      win = highGlazing;
    } else if (motif == FACADE_MOTIF_CHURCH) {
      // Tall, narrow, round-headed openings on alternating bays. Three stacked
      // rects read as an arch at 2-4 px; the stone springing line keeps the
      // rhythm readable when the opening itself collapses to one pixel.
      float bayPick = step(0.38, facadeHash11(col * 1.7 + seed * 9.0));
      float body = facadeRect(vec2(uWin, v), vec2(0.35, 0.24), vec2(0.65, 0.80), vec2(aaWin, aaV));
      float shoulder = facadeRect(vec2(uWin, v), vec2(0.38, 0.80), vec2(0.62, 0.86), vec2(aaWin, aaV));
      float crown = facadeRect(vec2(uWin, v), vec2(0.44, 0.86), vec2(0.56, 0.91), vec2(aaWin, aaV));
      win = max(max(body, shoulder), crown) * bayPick * detail * mix(0.45, 1.0, crisp);
      float spring = facadeBand(v, 0.78, 0.82, aaV) * bayPick * crisp * detail;
      outWall = mix(outWall, uTrimColor * 0.82, spring * 0.22);
    } else if (
      motif == FACADE_MOTIF_MONUMENT
      || motif == FACADE_MOTIF_GRID
      || motif == FACADE_MOTIF_HISTORIC
    ) {
      // Ordered accents on the same rows as the openings.
      float course = facadeBand(v, 0.0, 0.05, aaV) * detail;
      outWall *= 1.0 - course * 0.06;
      float pier = facadeBand(min(u, 1.0 - u), 0.0, 0.05, aaU) * detail;
      pier *= (motif == FACADE_MOTIF_MONUMENT) ? 0.5 : 0.3;
      outWall = mix(outWall, uTrimColor * 0.86, pier * 0.35);
    }
  }

  if (pilasters && !blank) {
    // Palace of the Republic: a full-height colonnade — wider, lighter stone
    // pilaster strips at every bay edge, with a capital line per storey.
    float pilasterW = mix(max(0.42, 1.3 * px), max(1.15, 2.0 * px), palaceity);
    float pilasterMask = facadeBand(min(u, 1.0 - u), 0.0, pilasterW / bayLod, aaU * 1.6);
    pilasterMask *= (1.0 - win);
    vec3 pilasterCol = mix(outWall * 1.10 + 0.010, mix(uTrimColor * 0.94, outWall * 1.05, 0.25), palaceity);
    outWall = mix(outWall, pilasterCol, pilasterMask * detail * mix(0.55, 0.9, textureFade));
    float cap = facadeBand(v, 0.94, 1.0, aaV) * pilasterMask * detail;
    outWall = mix(outWall, uTrimColor * 0.85, cap * mix(0.5, 0.8, palaceity));
  }

  // Daytime glass, with a warm low-sun reflection in the golden hour. Modern
  // towers get a glassy teal cast; per-window brightness variation is faded out
  // with distance so a 2 px window grid stays a clean grid instead of speckle.
  float glassVar = mix(0.5, facadeHash21(vec2(colWin, row) + seed * 7.0), lodFade);
  vec3 glass = mix(uGlassColor, uGlassLightColor, 0.32 + 0.4 * glassVar);
  glass *= mix(0.85, 1.20, smoothstep(winLo.y, winHi.y, v));
  glass = mix(glass, glass * 1.10 + 0.010, ribbon ? 1.0 : 0.0);
  glass = mix(glass, glass * vec3(0.84, 1.04, 1.14), modernity);
  float hh = mod(uTimeHours, 24.0);
  float golden = smoothstep(15.5, 18.5, hh) * (1.0 - smoothstep(18.5, 21.5, hh));
  glass = mix(glass, glass * vec3(1.14, 1.0, 0.82), golden * 0.6);

  // Frames and sills. These must NOT dominate the window: at overview/close
  // distances a light frame + sill can turn a dark window into a white block.
  // Frames stay dark and only appear when the window is large enough. The light
  // sill/lintel is gated by the recipe trim intensity, so a plain residential
  // family gets almost none of it while a Stalinist ensemble or a palace keeps
  // the stone surrounds.
  float windowPx = min(winW * winPitch, winH * fhLod) / px;
  float trimFade = clamp(trimK, 0.0, 1.0);
  float frameFade = smoothstep(3.2, 5.5, windowPx) * (1.0 - stadiumity);
  float sillFade = smoothstep(2.4, 4.0, windowPx) * (1.0 - stadiumity);
  float frameM = max(0.45 * px, 0.03);
  frameM = min(frameM, 0.13 * winW * winPitch);
  frameM = min(frameM, 0.13 * winH * fhLod);
  vec2 frameSize = vec2(frameM / winPitch, frameM / fhLod);
  float inner = facadeRect(vec2(uWin, v), winLo + frameSize, winHi - frameSize, vec2(aaWin, aaV));
  float frameMask = clamp(winCrisp - inner, 0.0, 1.0) * crisp * detail * frameFade;
  vec3 frameCol = mix(uGlassColor * 0.80, wallSrgb * 0.62, 0.30);

  float sillM = max(0.8 * px, 0.04);
  sillM = min(sillM, 0.16 * winH * fhLod);
  float sillLo = max(winLo.y - sillM / fhLod, 0.0);
  float sillMask = facadeBand(v, sillLo, winLo.y, aaV)
    * step(winLo.x, uWin) * (1.0 - step(winHi.x, uWin))
    * crisp * detail * sillFade * mix(0.25, 1.0, trimFade);
  vec3 sillCol = mix(wallSrgb * 1.05, uTrimColor, 0.25);

  // Subtle lighter lintel above the window (only when resolvable).
  float lintelM = min(max(0.6 * px, 0.03), 0.14 * winH * fhLod);
  float lintelMask = facadeBand(v, winHi.y, winHi.y + lintelM / fhLod, aaV)
    * step(winLo.x, uWin) * (1.0 - step(winHi.x, uWin))
    * crisp * detail * frameFade * trimFade;

  // Churches carry their own stone springing line and arched openings: the
  // residential frame/sill/lintel treatment must not be painted on them. Blank
  // facades (stadium bowls, monuments, curated brick walls) must not get window
  // outlines either — the glass is zeroed above, so the surrounds would read as
  // empty window frames.
  float blankFade = blank ? 0.0 : 1.0;
  float churchFade = (motif == FACADE_MOTIF_CHURCH) ? 0.0 : 1.0;
  frameMask *= churchFade * blankFade;
  sillMask *= churchFade * blankFade;
  lintelMask *= churchFade * blankFade;

  vec3 glassNight = mix(glass, uNightDarkColor, night * 0.78);
  float contrast = mix(0.88, 0.95, lodFade);
  outWall = mix(outWall, glassNight, win * contrast);
  outWall = mix(outWall, frameCol, frameMask * 0.70);
  outWall = mix(outWall, sillCol, sillMask * 0.45);
  outWall = mix(outWall, uTrimColor * 0.86, lintelMask * 0.20);

  // Wet seasons: a dirty streak runs down the wall below each sill. Kept at
  // ~9% and faded out at overview zoom (crisp), so it adds weathering without
  // becoming a pattern of vertical stripes.
  float facadeWet = clamp(uWinter + uAutumn, 0.0, 1.0);
  if (facadeWet > 0.001) {
    float streakDepth = clamp(1.4 / fhLod, 0.04, 0.28);
    float belowSill = facadeBand(v, winLo.y - streakDepth, winLo.y, aaV);
    float across = step(winLo.x, uWin) * (1.0 - step(winHi.x, uWin));
    float wetVar = 0.55 + 0.45 * facadeHash11(colWin * 3.7 + seed * 17.0);
    float wetStreak = belowSill * across * wetVar * crisp * detail;
    outWall *= 1.0 - wetStreak * 0.09 * facadeWet;
  }

  if (ribbon) {
    float mullW = max(1.2 * px, 0.02) / bayLod;
    float mull = facadeBand(min(u, 1.0 - u), 0.0, mullW, aaU) * crisp * detail;
    outWall = mix(outWall, uTrimColor * 0.60, mull * win * 0.9);
  }

  // Balcony bands: a dark recess plus a light railing on alternate floors.
  // Band thickness is clamped to >= ~1.2 px so it never flickers sub-pixel.
  if (balconies && !blank) {
    float bandLo = 0.02;
    float bandThick = clamp(1.2 * px / fhLod, 0.28, 0.46);
    float bandHi = bandLo + bandThick;
    float panel = step(1.5, float(archetype)) * step(float(archetype), 2.5);
    float bayPick = mix(
      step(facadeHash21(vec2(col + 3.0, seed * 17.0)), 0.35 + 0.55 * clamp(balconyRatio, 0.0, 1.0)),
      1.0,
      panel
    );
    float floorPick = 1.0 - step(0.5, mod(row, 2.0));
    float band = facadeBand(v, bandLo, bandHi, aaV) * bayPick * floorPick * detail;
    outWall = mix(outWall, outWall * mix(0.76, 0.64, panelity), band * 0.9);
    float railThick = max(1.1 * px, 0.015) / fhLod;
    float rail = facadeBand(v, bandHi - railThick, bandHi, aaV) * bayPick * floorPick * crisp * detail;
    outWall = mix(outWall, uTrimColor * 0.92, rail);
  }

  // Night: deterministic per-window lighting, most windows stay dark (a sparse
  // hand-placed look reads better than a fully lit office wall).
  if (night > 0.001) {
    float litHash = facadeHash21(vec2(colWin * 1.31 + seed * 53.0, row * 1.83 + seed * 29.0));
    float rowBias = 0.60 + 0.55 * facadeHash11(row * 3.7 + seed * 11.0);
    float lit = step(litHash, night * 0.52 * rowBias);
    float warm = facadeHash21(vec2(litHash * 71.0, seed * 9.0));
    vec3 litCol = mix(uNightLitColor, uNightWarmColor, warm);
    outWall = mix(outWall, litCol, lit * win * 0.95);
    emit += facadeSrgbToLinear(litCol) * lit * win * night * (0.35 + 0.65 * warm);
  }

  return outWall;
}

// ------------------------------------------------------------- ground floor

vec3 facadeGroundFloor(
  vec2 uv,
  vec3 wallSrgb,
  float groundHeight,
  vec4 presetA,
  float floorHeight,
  float seed,
  int flags,
  int archetype,
  int motif,
  float mPerPx,
  float detail,
  float trimK,
  out vec3 emit
) {
  emit = vec3(0.0);
  float night = clamp(uNight, 0.0, 1.0);
  float px = max(mPerPx, 0.0001);
  float gh = max(groundHeight, 1.0);
  float bay = max(presetA.x, 1.2);
  float fh = max(floorHeight, 1.8);
  bool shopfront = facadeFlag(flags, 4);
  bool blank = facadeFlag(flags, 64);
  // Palace of the Republic: tall glazed loggia between stone columns.
  float palaceity = step(8.5, float(archetype)) * step(float(archetype), 9.5);
  // 0 at overview zoom (one averaged plinth band + reveal line), 1 when the
  // ground floor is tall enough on screen for doors and shop windows.
  float groundDetail = smoothstep(3.2, 6.5, gh / px) * detail;

  float aaU = max(0.4 * px, 0.002) / bay;
  float aaM = max(0.4 * px, 0.008);

  vec3 outWall = wallSrgb;
  // The whole ground floor reads as a distinct, slightly darker band under the
  // upper facade (8-15% darker), even when every other detail is unresolvable.
  outWall *= mix(0.92, 0.86, clamp(mPerPx * 0.8, 0.0, 1.0));
  float colF = uv.x / bay;
  float col = floor(colF);
  float u = fract(colF);

  // Plinth band with faint rustication lines.
  float plinthTop = 0.6;
  float plinth = 1.0 - smoothstep(plinthTop - 0.75 * px, plinthTop + 0.75 * px, uv.y);
  outWall *= mix(1.0, 0.84, plinth);
  if (0.32 / px > 1.4) {
    float rust = facadeBand(fract(uv.y / 0.32), 0.0, 0.06, 0.03) * plinth;
    outWall *= 1.0 - rust * 0.09;
  }

  // Entrances every few bays, deterministic from the building seed. Blank
  // facades (stadium bowls, monuments, curated brick walls) stay solid: no
  // generic door, no reveal.
  float doorAllowed = blank ? 0.0 : 1.0;
  float doorSpan = 4.0;
  float doorOffset = floor(facadeHash11(seed * 3.13 + 0.37) * doorSpan);
  float isDoor = step(mod(col - doorOffset, doorSpan), 0.5);
  float doorH = min(2.3, gh - 0.35);
  float doorMask = facadeRect(vec2(u, uv.y), vec2(0.39, 0.0), vec2(0.61, doorH), vec2(aaU, aaM)) * isDoor * groundDetail * doorAllowed;
  vec3 doorCol = mix(uNightDarkColor, wallSrgb * 0.32, 0.30);
  outWall = mix(outWall, doorCol, doorMask * 0.95);
  float doorInner = facadeRect(vec2(u, uv.y), vec2(0.42, 0.0), vec2(0.58, doorH - 0.06), vec2(aaU, aaM)) * isDoor * groundDetail * doorAllowed;
  float doorFrame = clamp(doorMask - doorInner, 0.0, 1.0);
  outWall = mix(outWall, uTrimColor * 0.82, doorFrame * 0.6 * mix(0.3, 1.0, clamp(trimK, 0.0, 1.0)));

  if (blank) {
    float seam = facadeBand(fract(uv.y / max(gh, 2.0)), 0.0, 0.02, 0.02) * groundDetail;
    outWall *= 1.0 - seam * 0.08;
  } else if (motif == FACADE_MOTIF_CHURCH) {
    // Arched portal in the entrance bay; the rest of the base stays stone.
    float portalH = min(2.9, gh - 0.4);
    float portal = facadeRect(vec2(u, uv.y), vec2(0.40, 0.0), vec2(0.60, portalH), vec2(aaU, aaM));
    float portalHead = facadeRect(
      vec2(u, uv.y), vec2(0.44, portalH), vec2(0.56, min(portalH + 0.32, gh - 0.1)), vec2(aaU, aaM)
    );
    portal = max(portal, portalHead) * isDoor * groundDetail;
    outWall = mix(outWall, mix(uNightDarkColor, wallSrgb * 0.30, 0.30), portal * 0.95);
    float surround = clamp(
      facadeRect(
        vec2(u, uv.y), vec2(0.36, 0.0), vec2(0.64, min(portalH + 0.40, gh - 0.05)), vec2(aaU, aaM)
      ) - portal,
      0.0,
      1.0
    ) * isDoor * groundDetail;
    outWall = mix(outWall, uTrimColor * 0.84, surround * 0.45);
  } else if (palaceity > 0.5) {
    // Palace loggia: a tall dark glazed wall recessed between the pilaster
    // columns, with stone columns/entablature and a regular entrance rhythm.
    float glassBottom = 0.9;
    float glassTop = max(gh - 1.2, glassBottom + 1.5);
    float glassMask = facadeRect(vec2(u, uv.y), vec2(0.02, glassBottom), vec2(0.98, glassTop), vec2(aaU, aaM));
    float colW = max(0.9, 1.8 * px);
    float columnMask = facadeBand(min(u, 1.0 - u), 0.0, (colW * 0.5) / bay, aaU * 1.2);
    glassMask *= 1.0 - columnMask;

    float cellVar = facadeHash21(vec2(col * 0.7 + seed * 47.0, 5.1));
    vec3 loggiaGlass = mix(uShopfrontColor, uGlassColor, 0.35);
    loggiaGlass = mix(loggiaGlass, uGlassLightColor, 0.12 + 0.10 * cellVar);
    loggiaGlass = mix(loggiaGlass, uNightWarmColor, night * 0.35);
    outWall = mix(outWall, loggiaGlass, glassMask * groundDetail * 0.95);

    // Vertical stone columns at every bay edge + a heavy entablature over the
    // glazing (both stay visible when the band is only 2-3 px tall).
    vec3 columnCol = mix(uTrimColor * 0.92, wallSrgb * 1.05, 0.25);
    outWall = mix(outWall, columnCol, columnMask * detail);
    float entab = facadeBand(uv.y, glassTop, min(glassTop + max(0.6, 1.4 * px), gh - 0.04), aaM);
    outWall = mix(outWall, uTrimColor * 0.88, entab * 0.9 * detail);

    // Entrance doors centred in alternating bays.
    float doorBay = step(0.5, fract(seed * 7.0 + col * 0.5));
    float doorMask = facadeRect(vec2(u, uv.y), vec2(0.43, 0.0), vec2(0.57, 2.8), vec2(aaU, aaM));
    doorMask *= groundDetail * doorBay;
    outWall = mix(outWall, mix(uNightDarkColor, wallSrgb * 0.30, 0.30), doorMask * 0.92);

    emit += facadeSrgbToLinear(mix(uNightWarmColor, uNightLitColor, 0.4)) * glassMask * night * 0.30;
  } else if (motif == FACADE_MOTIF_ASSEMBLY_HALL || motif == FACADE_MOTIF_BLANK_SERVICE) {
    // Halls and service volumes: a solid base wall with a single utility door
    // every few bays. Without this branch the generic residential windows below
    // would still paint a full ground-floor grid (the circus drum ring).
    float utility = facadeRect(
      vec2(u, uv.y), vec2(0.34, 0.0), vec2(0.66, min(2.6, gh - 0.4)), vec2(aaU, aaM)
    ) * groundDetail;
    float gate = step(0.7, facadeHash11(col * 0.7 + seed * 3.1));
    outWall = mix(outWall, mix(uNightDarkColor, wallSrgb * 0.34, 0.3), utility * gate * 0.9);
  } else if (shopfront) {
    // Shop window: one wide glazed bay with mullions and a sign fascia.
    float shopBottom = 0.55;
    float shopTop = max(gh - 0.65, shopBottom + 0.6);
    float shopMask = facadeRect(vec2(u, uv.y), vec2(0.04, shopBottom), vec2(0.96, shopTop), vec2(aaU, aaM)) * groundDetail;
    shopMask *= 1.0 - doorMask;

    float mullPeriod = max(1.4, 2.0 * px);
    float mullF = fract(uv.x / mullPeriod);
    float mull = facadeBand(min(mullF, 1.0 - mullF), 0.0, max(1.1 * px, 0.02) / mullPeriod, 0.02);
    float transom = facadeBand(uv.y, shopTop - max(1.2 * px, 0.06), shopTop, max(0.7 * px, 0.02));

    float interiorVar = facadeHash21(vec2(col * 0.7 + seed * 47.0, 3.1));
    vec3 shopDay = mix(uShopfrontColor, uGlassLightColor, 0.28 + 0.30 * interiorVar);
    vec3 interior = mix(uNightWarmColor, uNightLitColor, interiorVar);
    vec3 shopCol = mix(shopDay, interior, 0.18 + 0.62 * night);
    shopCol = mix(shopCol, uTrimColor * 0.68, mull * 0.85 + transom * 0.7);
    outWall = mix(outWall, shopCol, shopMask * 0.96);

    float fasciaTop = min(shopTop + 0.5, gh - 0.04);
    float fascia = facadeBand(uv.y, shopTop, fasciaTop, aaM) * groundDetail;
    float signVar = facadeHash21(vec2(col, seed * 23.0));
    vec3 fasciaCol = mix(uTrimColor * 0.72, wallSrgb * 0.82, 0.35 + 0.30 * signVar);
    outWall = mix(outWall, fasciaCol, fascia * 0.85);

    float glow = shopMask * (1.0 - mull) * (1.0 - transom);
    emit += facadeSrgbToLinear(interior) * glow * (0.20 + 0.80 * night);
  } else {
    // Residential ground floor: same punched windows plus a lintel.
    float winH = clamp(presetA.z * fh, 0.9, gh - 1.0);
    float sillM = clamp(presetA.w * fh, 0.30, 1.1);
    float winW = clamp(presetA.y * 1.02, 0.2, 0.8);
    vec2 gLo = vec2(0.5 - winW * 0.5, sillM);
    vec2 gHi = vec2(0.5 + winW * 0.5, sillM + winH);
    float gWin = facadeRect(vec2(u, uv.y), gLo, gHi, vec2(aaU, aaM)) * groundDetail;

    vec3 gGlass = mix(uGlassColor, uGlassLightColor, 0.30);
    vec3 gGlassNight = mix(gGlass, uNightDarkColor, night * 0.78);
    outWall = mix(outWall, gGlassNight, gWin * 0.9);

    float litHash = facadeHash21(vec2(col * 1.9 + seed * 61.0, seed * 7.0));
    float lit = step(litHash, night * 0.40);
    vec3 litCol = mix(uNightLitColor, uNightWarmColor, facadeHash21(vec2(litHash, seed * 5.0)));
    outWall = mix(outWall, litCol, gWin * lit * 0.9);
    emit += facadeSrgbToLinear(litCol) * gWin * lit * night * 0.45;

    float lintel = facadeBand(uv.y, gHi.y, gHi.y + max(1.2 * px, 0.06), aaM) * groundDetail;
    outWall = mix(outWall, uTrimColor * 0.86, lintel * 0.45 * clamp(trimK, 0.0, 1.0));
  }

  // Recipe motif ground treatment: a bounded recessed/loggia or service band.
  // Elevated parts never reach here (aStyle.z = -1 forces groundBlend 0 upstream).
  if (motif == FACADE_MOTIF_LOGGIA && !blank) {
    float recess = facadeRect(
      vec2(u, uv.y), vec2(0.06, 0.9), vec2(0.94, max(gh - 1.2, 1.8)), vec2(aaU, aaM)
    ) * groundDetail;
    outWall = mix(outWall, mix(uShopfrontColor, uGlassColor, 0.4), recess * 0.9);
  }

  // Far LOD: an averaged ground-floor band with a light reveal at its top edge,
  // so the building always reads as "shopfront/base + upper floors". The band
  // contrast is deliberately strong: 1-2 px of ground floor is all that
  // survives at overview zoom.
  vec3 average = wallSrgb * mix(1.0, 0.80, plinth);
  if (
    blank
    || motif == FACADE_MOTIF_ASSEMBLY_HALL
    || motif == FACADE_MOTIF_BLANK_SERVICE
  ) {
    average = wallSrgb * mix(1.0, 0.82, plinth);
  } else if (palaceity > 0.5) {
    // Palace: averaged dark loggia + light column/entablature mix.
    vec3 loggiaAvg = mix(mix(uShopfrontColor, uGlassColor, 0.35), uNightWarmColor, night * 0.35);
    average = mix(average, mix(loggiaAvg, uTrimColor * 0.82, 0.28), 0.78);
  } else if (shopfront) {
    vec3 shopAvg = mix(mix(uShopfrontColor, uGlassColor, 0.40), uNightWarmColor, night * 0.45);
    average = mix(average, shopAvg, 0.72);
  } else {
    average = mix(average, uGlassColor, 0.22);
  }
  float reveal = facadeBand(uv.y, gh - max(1.5 * px, 0.08), gh, max(0.7 * px, 0.02));
  average *= 0.88; // ground floors sit in shadow under the facade above
  average = mix(average, uTrimColor * 0.90, reveal * 0.85);
  outWall = mix(average, outWall, groundDetail);

  if (night > 0.001 && !blank) {
    // Keep a faint warm shop band at night even when the detail is too small
    // to show individual openings.
    emit += facadeSrgbToLinear(mix(uNightWarmColor, uNightLitColor, 0.3))
      * night * (1.0 - groundDetail) * (shopfront ? 0.30 : 0.06);
  }

  // Wet seasons: the plinth is the first 1-1.5 m — darker and slightly colder
  // from splash-back. Not a global darkening: it fades with height.
  float facadeWetGround = clamp(uWinter + uAutumn, 0.0, 1.0);
  float plinthWet = facadeWetGround * (1.0 - smoothstep(0.12, 1.1, uv.y));
  outWall *= 1.0 - plinthWet * 0.06;
  outWall = mix(outWall, outWall * vec3(0.94, 0.97, 1.03), plinthWet * 0.4);

  return outWall;
}

// -------------------------------------------------------------- main shading

void facadeShade(out vec3 outAlbedo, out vec3 outEmissive) {
  outAlbedo = vec3(0.5, 0.5, 0.5);
  outEmissive = vec3(0.0);

  float archetypeF = clamp(vFacadeStyle.x, 0.0, float(FACADE_ARCHETYPE_COUNT - 1));
  int archetype = int(archetypeF + 0.5);
  // aFace.y packs the style flag byte and the recipe id byte (schema 1):
  //   flags = packed & 255, recipe = packed >> 8 (clamped to the preset rows).
  float packedStyle = max(vFacadeFace.y, 0.0) + 0.5;
  int flags = int(mod(floor(packedStyle), 256.0));
  int recipe = int(clamp(floor(packedStyle / 256.0), 0.0, float(FACADE_PRESET_ROWS - 1)));
  vec4 presetA = uPresetA[recipe];
  vec4 presetB = uPresetB[recipe];
  // Motif id of the selected row (-1 = legacy archetype preset: old branches).
  int motif = int(floor(uRecipeMotif[recipe] + 0.5));
  float styleGround = vFacadeStyle.z;
  // aStyle.z < -0.5 marks elevated building:part volumes (no ground floor).
  bool hasGround = styleGround > -0.5;
  float floorHeight = vFacadeStyle.y > 1.2 ? vFacadeStyle.y : presetB.x;
  float groundHeight = styleGround > 1.2 ? styleGround : presetB.y;
  float balconyRatio = clamp(presetB.z, 0.0, 1.0);
  float seed = fract(vFacadeStyle.w * 1.618 + 0.137);

  float faceKind = vFacadeFace.x;
  float trimK = clamp(vFacadeFace.z, 0.0, 1.0);
  float faceW = clamp(vFacadeFace.w, 0.0, 10.0);

  vec2 uv = vFacadeUV;
  vec3 baseSrgb = max(vFacadeColor, vec3(0.0));
  // Subtle per-building cast so adjacent facades stay distinguishable.
  baseSrgb *= 1.0 + (facadeHash21(vec2(seed * 191.0, 13.0)) - 0.5) * 0.055;

  // World metres per screen pixel: renderer-supplied, with a derivative fallback.
  float mPerPx = clamp(uPixelSize, 0.0002, 3.0);
  mPerPx = max(mPerPx, max(fwidth(uv.x), fwidth(uv.y)) * 0.6);
  mPerPx = clamp(mPerPx, 0.0002, 3.0);

  float detail = clamp(uDetailScale, 0.0, 1.0);
  float hintMix = step(0.001, faceW);
  detail *= mix(1.0, clamp(faceW, 0.0, 1.0), hintMix);

  // Roof / trim / glazing face kinds are handled separately.
  if (faceKind > 0.5 && faceKind < 1.5) {
    // FACE_KIND.roof: aFace.w carries ROOF_SHAPE_ID here, not a detail hint.
    outAlbedo = facadeRoof(uv, baseSrgb, faceW, 0.0, seed, mPerPx, detail);
    outAlbedo = facadeApplySnow(outAlbedo, faceKind, vFacadeWorldUp);
    // Snowy roofs catch a little sky light at night; never a self-glow.
    outEmissive += FACADE_SNOW_DEEP * facadeSnowCover(faceKind, vFacadeWorldUp)
      * clamp(uNight, 0.0, 1.0) * 0.025;
    return;
  }
  if (faceKind > 4.5 && faceKind < 5.5) {
    // FACE_KIND.roofRidge: sloped roof surface, always shingle-ish.
    outAlbedo = facadeRoof(uv, baseSrgb, faceW, 1.0, seed, mPerPx, detail);
    outAlbedo = facadeApplySnow(outAlbedo, faceKind, vFacadeWorldUp);
    outEmissive += FACADE_SNOW_DEEP * facadeSnowCover(faceKind, vFacadeWorldUp)
      * clamp(uNight, 0.0, 1.0) * 0.025;
    return;
  }
  if (faceKind > 2.5 && faceKind < 3.5) {
    outAlbedo = facadeTrimShade(uv, baseSrgb, trimK, seed, mPerPx, archetype);
    // Cornices, ledges and parapet caps hold a light dusting; the vertical
    // sides of the same trim geometry have up≈0 and stay clean.
    outAlbedo = facadeApplySnow(outAlbedo, faceKind, vFacadeWorldUp);
    outEmissive += FACADE_SNOW_DEEP * facadeSnowCover(faceKind, vFacadeWorldUp)
      * clamp(uNight, 0.0, 1.0) * 0.02;
    return;
  }
  if (faceKind > 3.5 && faceKind < 4.5) {
    // Palace of the Republic: the geometry builder emits the glazed ground floor
    // as FACE_KIND.glass because the palace preset carries the shopfront flag.
    // Route it through the ground treatment so it gets the loggia + columns.
    if (archetype == 9) {
      vec3 palaceGroundEmit;
      outAlbedo = facadeGroundFloor(
        uv, baseSrgb, groundHeight, presetA, floorHeight,
        seed, flags, archetype, motif, mPerPx, detail, trimK, palaceGroundEmit
      );
      outEmissive = palaceGroundEmit;
      return;
    }
    vec3 emit;
    outAlbedo = facadeGlazing(uv, baseSrgb, groundHeight, seed, mPerPx, detail, emit);
    outEmissive = emit;
    return;
  }

  // Wall (0) and ground band (2). Ground faces are fully ground floor; wall
  // faces blend to the ground treatment at aStyle.z with a one-pixel seam.
  vec3 upperEmit;
  vec3 groundEmit;
  vec3 upper = facadeUpperFloors(
    uv, baseSrgb, floorHeight, groundHeight, presetA, balconyRatio,
    seed, flags, archetype, motif, mPerPx, detail, trimK, upperEmit
  );
  vec3 ground = facadeGroundFloor(
    uv, baseSrgb, groundHeight, presetA, floorHeight,
    seed, flags, archetype, motif, mPerPx, detail, trimK, groundEmit
  );

  float groundBlend;
  if (faceKind > 1.5 && faceKind < 2.5) {
    groundBlend = hasGround ? 1.0 : 0.0;
  } else if (hasGround) {
    float aaM = max(0.8 * mPerPx, 0.008);
    groundBlend = 1.0 - smoothstep(groundHeight - aaM, groundHeight + aaM, uv.y);
  } else {
    // Elevated part: no plinth / shopfront treatment at its underside.
    groundBlend = 0.0;
  }
  outAlbedo = mix(upper, ground, groundBlend);
  outEmissive = mix(upperEmit, groundEmit, groundBlend);
}

// -------------------------------------------------------------- quantisation

vec3 facadeQuantise(vec3 color) {
  float amount = clamp(uPaletteMix, 0.0, 1.0);
  if (amount < 0.001) return color;
  vec3 best = uPalette[0];
  float bestDist = 1e20;
  for (int i = 0; i < FACADE_PALETTE_SIZE; i++) {
    vec3 candidate = uPalette[i];
    vec3 d = color - candidate;
    float dist = dot(d * vec3(0.95, 1.10, 0.85), d);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return mix(color, best, amount);
}
`;

/** Injection that replaces three's albedo computed from maps/vertex colours. */
export const FACADE_FRAGMENT_ALBEDO = /* glsl */ `
#include <color_fragment>

vec3 facadeAlbedoSrgb;
vec3 facadeEmissiveSrgb;
facadeShade(facadeAlbedoSrgb, facadeEmissiveSrgb);

vec3 facadeAlbedoLinear = facadeSrgbToLinear(clamp(facadeAlbedoSrgb, 0.0, 1.0)) * diffuse.rgb;
diffuseColor.rgb = facadeAlbedoLinear;
totalEmissiveRadiance += facadeSrgbToLinear(clamp(facadeEmissiveSrgb, 0.0, 3.0));

// Stylised ambient fill: real Lambert lighting leaves unlit facades nearly black
// at a low winter sun, which destroys window readability. A small albedo-
// proportional, cool-tinted emissive term keeps shadowed facades readable while
// staying subtle at night (small cool moonlit fill), so lamp light still dominates.
float facadeNightAmount = clamp(uNight, 0.0, 1.0);
vec3 facadeAmbientFill = mix(
  vec3(0.070, 0.080, 0.105),
  vec3(0.026, 0.029, 0.036),
  facadeNightAmount
);
totalEmissiveRadiance += facadeAlbedoLinear * facadeAmbientFill;
`;

/**
 * Tail of the facade albedo block: cloud shades anchor here so they darken the
 * finished wall albedo (lit windows stay lit — see cloudShade.ts).
 */
export const FACADE_FRAGMENT_ALBEDO_TAIL =
  'totalEmissiveRadiance += facadeAlbedoLinear * facadeAmbientFill;';

/** Injection after output encoding: snap facade pixels to the shared palette. */
export const FACADE_FRAGMENT_QUANTISE = /* glsl */ `
#include <colorspace_fragment>
gl_FragColor.rgb = facadeQuantise(gl_FragColor.rgb);
`;

/** Whole GLSL injected into the Lambert vertex shader (declarations + body). */
export const FACADE_VERTEX_GLSL = FACADE_VERTEX_DECLARATIONS + FACADE_VERTEX_BODY;

/** Whole GLSL injected into the Lambert fragment shader (all stages). */
export const FACADE_FRAGMENT_GLSL =
  FACADE_FRAGMENT_DECLARATIONS + FACADE_FRAGMENT_ALBEDO + FACADE_FRAGMENT_QUANTISE;

// ------------------------------------------------------------------- patching

const VERTEX_COMMON_ANCHOR = '#include <common>';
const VERTEX_BEGIN_ANCHOR = '#include <begin_vertex>';
const MAIN_ANCHOR = 'void main() {';
const FRAGMENT_COMMON_ANCHOR = '#include <common>';
const FRAGMENT_COLOR_ANCHOR = '#include <color_fragment>';
const FRAGMENT_COLORSPACE_ANCHOR = '#include <colorspace_fragment>';
const FRAGMENT_FOG_ANCHOR = '#include <fog_fragment>';
const FRAGMENT_LIGHTS_END_ANCHOR = '#include <lights_fragment_end>';

/** Insert `insert` immediately after `anchor`; returns null when absent. */
function insertAfter(source: string, anchor: string, insert: string): string | null {
  const index = source.indexOf(anchor);
  if (index < 0) return null;
  const at = index + anchor.length;
  return source.slice(0, at) + '\n' + insert + '\n' + source.slice(at);
}

/** Insert `insert` immediately before `anchor`; returns null when absent. */
function insertBefore(source: string, anchor: string, insert: string): string | null {
  const index = source.indexOf(anchor);
  if (index < 0) return null;
  return source.slice(0, index) + insert + '\n' + source.slice(index);
}

/** Replace `anchor` with `replacement`; returns null when absent. */
function replaceAnchor(source: string, anchor: string, replacement: string): string | null {
  const index = source.indexOf(anchor);
  if (index < 0) return null;
  return source.slice(0, index) + replacement + '\n' + source.slice(index + anchor.length);
}

/** Patch three's Lambert vertex shader with facade attribute declarations + varyings. */
export function patchFacadeVertexShader(source: string): string {
  let patched = insertAfter(source, VERTEX_COMMON_ANCHOR, FACADE_VERTEX_DECLARATIONS);
  if (patched === null) patched = FACADE_VERTEX_DECLARATIONS + '\n' + source;

  let withBody = insertAfter(patched, VERTEX_BEGIN_ANCHOR, FACADE_VERTEX_BODY);
  if (withBody === null) withBody = insertAfter(patched, MAIN_ANCHOR, FACADE_VERTEX_BODY);
  if (withBody === null) withBody = patched + '\n' + FACADE_VERTEX_BODY;
  return withBody;
}

/** Patch three's Lambert fragment shader: facade shading + palette quantisation. */
export function patchFacadeFragmentShader(source: string): string {
  let patched = insertAfter(source, FRAGMENT_COMMON_ANCHOR, FACADE_FRAGMENT_DECLARATIONS);
  if (patched === null) patched = FACADE_FRAGMENT_DECLARATIONS + '\n' + source;

  let withAlbedo = replaceAnchor(patched, FRAGMENT_COLOR_ANCHOR, FACADE_FRAGMENT_ALBEDO);
  if (withAlbedo === null) {
    withAlbedo = insertAfter(patched, 'vec3 totalEmissiveRadiance = emissive;', FACADE_FRAGMENT_ALBEDO);
  }
  if (withAlbedo === null) {
    withAlbedo = insertAfter(patched, FRAGMENT_LIGHTS_END_ANCHOR, FACADE_FRAGMENT_ALBEDO);
  }
  if (withAlbedo === null) withAlbedo = patched;

  // Quantise after output encoding, but before fog (fog must stay atmospheric).
  // The replacement chunk includes the stock colours-pace conversion exactly once.
  let withQuantise = replaceAnchor(withAlbedo, FRAGMENT_COLORSPACE_ANCHOR, FACADE_FRAGMENT_QUANTISE);
  if (withQuantise === null) withQuantise = insertBefore(withAlbedo, FRAGMENT_FOG_ANCHOR, FACADE_FRAGMENT_QUANTISE);
  if (withQuantise === null) withQuantise = withAlbedo;
  return withQuantise;
}
