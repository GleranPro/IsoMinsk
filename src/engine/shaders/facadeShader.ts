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

/** Compile-time size of the `uPalette` uniform array (mirrors PIXEL_PALETTE). */
export const FACADE_PALETTE_SIZE = PIXEL_PALETTE_SIZE;

/** Program cache key for facade materials (identical GLSL for all instances). */
export const FACADE_PROGRAM_CACHE_KEY = 'isometric-minsk-facade-v1';

/** Float uniforms the facade shader exposes (for tests / renderer wiring). */
export const FACADE_FLOAT_UNIFORMS = [
  'uNight',
  'uDetailScale',
  'uPixelSize',
  'uPaletteMix',
  'uTimeHours',
] as const;

/** Vertex attributes the facade shader consumes. */
export const FACADE_VERTEX_ATTRIBUTES = ['aUV', 'aColor', 'aStyle', 'aFace'] as const;

export const FACADE_VERTEX_DECLARATIONS = /* glsl */ `
attribute vec2 aUV;
attribute vec3 aColor;
attribute vec4 aStyle;
attribute vec4 aFace;

varying vec2 vFacadeUV;
varying vec3 vFacadeColor;
varying vec4 vFacadeStyle;
varying vec4 vFacadeFace;
`;

export const FACADE_VERTEX_BODY = /* glsl */ `
vFacadeUV = aUV;
vFacadeColor = aColor;
vFacadeStyle = aStyle;
vFacadeFace = aFace;
`;

export const FACADE_FRAGMENT_DECLARATIONS = /* glsl */ `
#define FACADE_PALETTE_SIZE ${FACADE_PALETTE_SIZE}
#define FACADE_ARCHETYPE_COUNT 9

uniform float uNight;
uniform float uDetailScale;
uniform float uPixelSize;
uniform float uPaletteMix;
uniform float uTimeHours;

uniform vec4 uPresetA[FACADE_ARCHETYPE_COUNT];
uniform vec4 uPresetB[FACADE_ARCHETYPE_COUNT];

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
    roof *= mix(1.0, mix(0.94, 1.05, tone), courseFade);
    roof *= mix(1.0, mix(0.86, 1.0, rowF), courseFade);
    float edge = facadeBand(rowF, 0.0, 0.16, 0.05) * courseFade;
    roof = mix(roof, roof * 1.12 + 0.012, edge * 0.55);
  } else {
    // Flat roof: two-tone patches plus gravel speckle, faded out at distance so
    // the roof stays a clean colour patch instead of shimmering noise.
    float patchFade = smoothstep(1.4, 3.0, 1.2 / px) * detail;
    vec2 patchCell = floor(uv / 1.2);
    float patchVal = facadeHash21(patchCell + seed * 13.0);
    vec3 detailed = baseSrgb
      * mix(0.94, 1.05, patchVal)
      * mix(0.97, 1.03, facadeHash21(floor(uv * 2.5) + seed));
    roof = mix(baseSrgb, detailed, patchFade);
    if (dome) {
      float bandFade = smoothstep(1.2, 3.0, 1.0 / px) * detail;
      float bands = 0.5 + 0.5 * sin(uv.y * 2.2 + seed * 6.283);
      roof *= mix(1.0, mix(0.94, 1.06, bands), bandFade);
    }
  }
  return roof;
}

// --------------------------------------------------------------------- trim

vec3 facadeTrimShade(vec2 uv, vec3 baseSrgb, float trimK, float seed, float mPerPx) {
  vec3 trim = baseSrgb * mix(1.0, 1.20, clamp(trimK, 0.0, 1.0));
  float px = max(mPerPx, 0.0001);
  float textureFade = smoothstep(1.2, 2.6, 0.5 / px);
  trim *= 1.0 + (facadeHash21(floor(uv * 2.0) + seed * 71.0) - 0.5) * 0.05 * textureFade;
  if (0.18 / px > 1.4) {
    float groove = facadeBand(fract(uv.y / 0.18), 0.0, 0.10, 0.03);
    trim *= 1.0 - groove * 0.10;
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
  float mPerPx,
  float detail,
  out vec3 emit
) {
  emit = vec3(0.0);
  float night = clamp(uNight, 0.0, 1.0);
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

  float aaU = max(0.8 * mPerPx, 0.002) / bay;
  float aaV = max(0.8 * mPerPx, 0.002) / fh;

  float colF = uv.x / bay;
  float col = floor(colF);
  float u = fract(colF);
  float yy = max(uv.y - gh, 0.0);
  float rowF = yy / fh;
  float row = floor(rowF);
  float v = fract(rowF);

  float bayPx = bay / max(mPerPx, 0.0001);
  float floorPx = fh / max(mPerPx, 0.0001);
  float crisp = smoothstep(2.0, 5.5, min(bayPx, floorPx));

  float winW = mix(winWRatio, 1.0, ribbon ? 1.0 : 0.0);
  vec2 winLo = vec2(0.5 - winW * 0.5, sillRatio);
  vec2 winHi = vec2(0.5 + winW * 0.5, sillRatio + winHRatio);

  float winCrisp = facadeRect(vec2(u, v), winLo, winHi, vec2(aaU, aaV));
  float winAverage = winW * winHRatio;
  float win = mix(winAverage, winCrisp, crisp) * detail;
  if (blank) win = 0.0;

  vec3 outWall = wallSrgb;
  float slab = facadeBand(v, 0.0, 0.045, aaV);
  outWall *= 1.0 - slab * 0.06 * detail;
  outWall *= 1.0 + (facadeHash21(vec2(col * 1.7 + seed * 31.0, row * 0.7 + 3.0)) - 0.5) * 0.03 * detail;

  if (pilasters && !blank) {
    float pilasterW = max(0.42, 1.4 * mPerPx);
    float pilasterMask = facadeBand(min(u, 1.0 - u), 0.0, pilasterW / bay, aaU * 1.6);
    pilasterMask *= (1.0 - win);
    outWall = mix(outWall, outWall * 1.10 + 0.010, pilasterMask * detail * 0.9);
    float cap = facadeBand(v, 0.94, 1.0, aaV) * pilasterMask * detail;
    outWall = mix(outWall, uTrimColor * 0.85, cap * 0.5);
  }

  // Daytime glass, with a warm low-sun reflection in the golden hour.
  float glassVar = facadeHash21(vec2(col, row) + seed * 7.0);
  vec3 glass = mix(uGlassColor, uGlassLightColor, 0.32 + 0.4 * glassVar);
  glass *= mix(0.85, 1.20, smoothstep(winLo.y, winHi.y, v));
  glass = mix(glass, glass * 1.10 + 0.010, ribbon ? 1.0 : 0.0);
  float hh = mod(uTimeHours, 24.0);
  float golden = smoothstep(15.5, 18.5, hh) * (1.0 - smoothstep(18.5, 21.5, hh));
  glass = mix(glass, glass * vec3(1.14, 1.0, 0.82), golden * 0.6);

  // Frames and sills: the two cues that keep windows readable at 1-2 pixels.
  float frameM = max(1.1 * mPerPx, 0.05);
  vec2 frameSize = vec2(frameM / bay, frameM / fh);
  float inner = facadeRect(vec2(u, v), winLo + frameSize, winHi - frameSize, vec2(aaU, aaV));
  float frameMask = clamp(winCrisp - inner, 0.0, 1.0) * crisp * detail;
  vec3 frameCol = mix(uTrimColor * 0.70, wallSrgb * 0.90, 0.35);

  float sillM = max(1.2 * mPerPx, 0.06);
  float sillLo = max(winLo.y - sillM / fh, 0.0);
  float sillMask = facadeBand(v, sillLo, winLo.y, aaV)
    * step(winLo.x, u) * (1.0 - step(winHi.x, u))
    * crisp * detail;
  vec3 sillCol = mix(uTrimColor, wallSrgb * 1.06, 0.30);

  vec3 glassNight = mix(glass, uNightDarkColor, night * 0.78);
  outWall = mix(outWall, glassNight, win * 0.92);
  outWall = mix(outWall, frameCol, frameMask * 0.70);
  outWall = mix(outWall, sillCol, sillMask * 0.65);

  if (ribbon) {
    float mullW = max(1.2 * mPerPx, 0.02) / bay;
    float mull = facadeBand(min(u, 1.0 - u), 0.0, mullW, aaU) * crisp * detail;
    outWall = mix(outWall, uTrimColor * 0.60, mull * win * 0.9);
  }

  // Balcony bands: a dark recess plus a light railing on alternate floors.
  if (balconies && !blank) {
    float bandLo = 0.02;
    float bandHi = 0.30;
    float panel = step(1.5, float(archetype)) * step(float(archetype), 2.5);
    float bayPick = mix(
      step(facadeHash21(vec2(col + 3.0, seed * 17.0)), 0.35 + 0.55 * clamp(balconyRatio, 0.0, 1.0)),
      1.0,
      panel
    );
    float floorPick = 1.0 - step(0.5, mod(row, 2.0));
    float band = facadeBand(v, bandLo, bandHi, aaV) * bayPick * floorPick * detail;
    outWall = mix(outWall, outWall * 0.76, band * 0.9);
    float railThick = max(1.2 * mPerPx, 0.015) / fh;
    float rail = facadeBand(v, bandHi - railThick, bandHi, aaV) * bayPick * floorPick * crisp * detail;
    outWall = mix(outWall, uTrimColor * 0.92, rail);
  }

  // Night: deterministic per-window lighting, some windows stay dark.
  if (night > 0.001) {
    float litHash = facadeHash21(vec2(col * 1.31 + seed * 53.0, row * 1.83 + seed * 29.0));
    float rowBias = 0.70 + 0.60 * facadeHash11(row * 3.7 + seed * 11.0);
    float lit = step(litHash, night * 0.82 * rowBias);
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
  float mPerPx,
  float detail,
  out vec3 emit
) {
  emit = vec3(0.0);
  float night = clamp(uNight, 0.0, 1.0);
  float gh = max(groundHeight, 1.0);
  float bay = max(presetA.x, 1.2);
  float fh = max(floorHeight, 1.8);
  bool shopfront = facadeFlag(flags, 4);
  bool blank = facadeFlag(flags, 64);

  float aaU = max(0.8 * mPerPx, 0.002) / bay;
  float aaM = max(0.8 * mPerPx, 0.008);

  vec3 outWall = wallSrgb;
  float colF = uv.x / bay;
  float col = floor(colF);
  float u = fract(colF);

  // Plinth band with faint rustication lines.
  float plinthTop = 0.6;
  float plinth = 1.0 - smoothstep(plinthTop - 0.75 * mPerPx, plinthTop + 0.75 * mPerPx, uv.y);
  outWall *= mix(1.0, 0.84, plinth);
  if (0.32 / max(mPerPx, 0.0001) > 1.4) {
    float rust = facadeBand(fract(uv.y / 0.32), 0.0, 0.06, 0.03) * plinth;
    outWall *= 1.0 - rust * 0.09;
  }

  // Entrances every few bays, deterministic from the building seed.
  float doorSpan = 4.0;
  float doorOffset = floor(facadeHash11(seed * 3.13 + 0.37) * doorSpan);
  float isDoor = step(mod(col - doorOffset, doorSpan), 0.5);
  float doorH = min(2.3, gh - 0.35);
  float doorMask = facadeRect(vec2(u, uv.y), vec2(0.39, 0.0), vec2(0.61, doorH), vec2(aaU, aaM)) * isDoor * detail;
  vec3 doorCol = mix(uNightDarkColor, wallSrgb * 0.32, 0.30);
  outWall = mix(outWall, doorCol, doorMask * 0.95);
  float doorInner = facadeRect(vec2(u, uv.y), vec2(0.42, 0.0), vec2(0.58, doorH - 0.06), vec2(aaU, aaM)) * isDoor * detail;
  float doorFrame = clamp(doorMask - doorInner, 0.0, 1.0);
  outWall = mix(outWall, uTrimColor * 0.82, doorFrame * 0.6);

  if (blank) {
    float seam = facadeBand(fract(uv.y / max(gh, 2.0)), 0.0, 0.02, 0.02) * detail;
    outWall *= 1.0 - seam * 0.08;
    return outWall;
  }

  if (shopfront) {
    // Shop window: one wide glazed bay with mullions and a sign fascia.
    float shopBottom = 0.55;
    float shopTop = max(gh - 0.65, shopBottom + 0.6);
    float shopMask = facadeRect(vec2(u, uv.y), vec2(0.04, shopBottom), vec2(0.96, shopTop), vec2(aaU, aaM)) * detail;
    shopMask *= 1.0 - doorMask;

    float mullPeriod = 1.4;
    float mullF = fract(uv.x / mullPeriod);
    float mull = facadeBand(min(mullF, 1.0 - mullF), 0.0, max(1.1 * mPerPx, 0.02) / mullPeriod, 0.02);
    float transom = facadeBand(uv.y, shopTop - max(1.2 * mPerPx, 0.06), shopTop, aaM);

    float interiorVar = facadeHash21(vec2(col * 0.7 + seed * 47.0, 3.1));
    vec3 shopDay = mix(uShopfrontColor, uGlassLightColor, 0.28 + 0.30 * interiorVar);
    vec3 interior = mix(uNightWarmColor, uNightLitColor, interiorVar);
    vec3 shopCol = mix(shopDay, interior, 0.18 + 0.62 * night);
    shopCol = mix(shopCol, uTrimColor * 0.68, mull * 0.85 + transom * 0.7);
    outWall = mix(outWall, shopCol, shopMask * 0.96);

    float fasciaTop = min(shopTop + 0.5, gh - 0.04);
    float fascia = facadeBand(uv.y, shopTop, fasciaTop, aaM) * detail;
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
    float gWin = facadeRect(vec2(u, uv.y), gLo, gHi, vec2(aaU, aaM)) * detail;

    vec3 gGlass = mix(uGlassColor, uGlassLightColor, 0.30);
    vec3 gGlassNight = mix(gGlass, uNightDarkColor, night * 0.78);
    outWall = mix(outWall, gGlassNight, gWin * 0.9);

    float litHash = facadeHash21(vec2(col * 1.9 + seed * 61.0, seed * 7.0));
    float lit = step(litHash, night * 0.40);
    vec3 litCol = mix(uNightLitColor, uNightWarmColor, facadeHash21(vec2(litHash, seed * 5.0)));
    outWall = mix(outWall, litCol, gWin * lit * 0.9);
    emit += facadeSrgbToLinear(litCol) * gWin * lit * night * 0.45;

    float lintel = facadeBand(uv.y, gHi.y, gHi.y + max(1.2 * mPerPx, 0.06), aaM) * detail;
    outWall = mix(outWall, uTrimColor * 0.86, lintel * 0.45);
  }

  return outWall;
}

// -------------------------------------------------------------- main shading

void facadeShade(out vec3 outAlbedo, out vec3 outEmissive) {
  outAlbedo = vec3(0.5, 0.5, 0.5);
  outEmissive = vec3(0.0);

  float archetypeF = clamp(vFacadeStyle.x, 0.0, 8.0);
  int archetype = int(archetypeF + 0.5);
  vec4 presetA = uPresetA[archetype];
  vec4 presetB = uPresetB[archetype];
  float styleGround = vFacadeStyle.z;
  // aStyle.z < -0.5 marks elevated building:part volumes (no ground floor).
  bool hasGround = styleGround > -0.5;
  float floorHeight = vFacadeStyle.y > 1.2 ? vFacadeStyle.y : presetB.x;
  float groundHeight = styleGround > 1.2 ? styleGround : presetB.y;
  float balconyRatio = clamp(presetB.z, 0.0, 1.0);
  float seed = fract(vFacadeStyle.w * 1.618 + 0.137);

  float faceKind = vFacadeFace.x;
  int flags = int(clamp(vFacadeFace.y, 0.0, 255.0) + 0.5);
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
    return;
  }
  if (faceKind > 4.5 && faceKind < 5.5) {
    // FACE_KIND.roofRidge: sloped roof surface, always shingle-ish.
    outAlbedo = facadeRoof(uv, baseSrgb, faceW, 1.0, seed, mPerPx, detail);
    return;
  }
  if (faceKind > 2.5 && faceKind < 3.5) {
    outAlbedo = facadeTrimShade(uv, baseSrgb, trimK, seed, mPerPx);
    return;
  }
  if (faceKind > 3.5 && faceKind < 4.5) {
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
    seed, flags, archetype, mPerPx, detail, upperEmit
  );
  vec3 ground = facadeGroundFloor(
    uv, baseSrgb, groundHeight, presetA, floorHeight,
    seed, flags, mPerPx, detail, groundEmit
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

diffuseColor.rgb = facadeSrgbToLinear(clamp(facadeAlbedoSrgb, 0.0, 1.0)) * diffuse.rgb;
totalEmissiveRadiance += facadeSrgbToLinear(clamp(facadeEmissiveSrgb, 0.0, 3.0));
`;

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
