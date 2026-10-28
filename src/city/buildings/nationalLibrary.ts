/**
 * National Library of Belarus ("алмаз") — curated landmark geometry.
 *
 * The real building is a rhombicuboctahedron ("diamond", edge ≈24.67 m) sitting
 * on a large light-stone terraced podium/stylobate. OSM maps the podium as one
 * building way (outline, ~89 points) and the diamond faces as malformed
 * `building:part` polygons, so this landmark is rebuilt from
 * `BuildingFeature.outline` plus the measured constants below — the generic
 * volume extrusion is skipped by the curated-landmark registry.
 *
 * Reference: measured Blender model (155×164 m plan, 71.6 m total), diamond
 * span 11.0 m .. 70.7 m, podium deck 13.9 m.
 *
 * Deterministic: pure arithmetic on numbers and MeshSink, no THREE objects, no
 * randomness. Never throws; problems are reported through `onWarning`.
 */

import { FACE_KIND, ROOF_SHAPE_ID, STYLE_FLAG } from '../../shared/geometry';
import type { BuildingFeature, BuildingVolume, Polygon, Ring } from '../../shared/types';
import type { MeshSink, SurfaceStyle } from './meshSink';
import {
  cleanRing,
  polygonCentroid,
  signedArea,
  triangleSignedArea,
  type Point2,
} from './polygon2d';
import { offsetRing } from './palaceAccents';
import { srgbFromHex, type BuildingStyle } from './style';
import { boundaryNormalLocal, boundaryRings, type RingInfo } from './walls';
import { addVolumeWalls } from './walls';
import { triangulatePolygon } from './triangulate';

// --- measured dimensions --------------------------------------------------
export const NATIONAL_LIBRARY_PODIUM_TOP = 13.9;
export const NATIONAL_LIBRARY_CORNICE_BOTTOM = 11.5;
export const NATIONAL_LIBRARY_DIAMOND_EDGE = 24.67;
export const NATIONAL_LIBRARY_DIAMOND_BOTTOM = 11.0;
export const NATIONAL_LIBRARY_DIAMOND_TOP = 70.7;
export const NATIONAL_LIBRARY_DIAMOND_CENTRE =
  (NATIONAL_LIBRARY_DIAMOND_BOTTOM + NATIONAL_LIBRARY_DIAMOND_TOP) / 2;
/** World heights where the three glass bands meet (mullion rims). */
export const NATIONAL_LIBRARY_BAND_HEIGHTS = [25.5, 40.85, 56.2] as const;

const PODIUM_CORNICE_OUTSET = 0.6;
const TERRACE_SKIRT_OUTSET = 0.9;
const TERRACE_SKIRT_TOP = 1.8;
const MULLION_BAND_THICKNESS = 0.36;
const MULLION_BAND_OUTSET = 0.12;
const MIN_OUTLINE_AREA = 100;

/** Blue-glass band palette (measured from the reference model/photos). */
const BELT = srgbFromHex('#35607E');
const UPPER = srgbFromHex('#7FB2CF');
const LOWER = srgbFromHex('#6FA0BC');
const TOP_GLASS = srgbFromHex('#D3E2EA');
const ALUMINIUM = srgbFromHex('#B9C4CC');

// Podium palette: warm light stone with a darker terraced step, a dark glazed
// skirt band and a slightly darker roof deck so the stylobate does not read as
// a washed-out white cylinder at city zoom.
export const NATIONAL_LIBRARY_PODIUM_STONE = srgbFromHex('#D8CDB8');
export const NATIONAL_LIBRARY_CORNICE_STONE = srgbFromHex('#CFC3AE');
export const NATIONAL_LIBRARY_SKIRT_STONE = srgbFromHex('#B3A894');
export const NATIONAL_LIBRARY_DECK_STONE = srgbFromHex('#BDB4A2');
export const NATIONAL_LIBRARY_GLASS_BAND = srgbFromHex('#2F4753');

/** Podium glazed skirt band (metres, absolute heights). */
export const NATIONAL_LIBRARY_GLASS_BOTTOM = 3.0;
export const NATIONAL_LIBRARY_GLASS_TOP = 5.5;
const GLASS_BAND_PROUD = 0.06;

export const NATIONAL_LIBRARY_DIAMOND_COLOURS = [BELT, UPPER, LOWER, TOP_GLASS] as const;

type Vec3 = [number, number, number];

/** True when the feature is the National Library landmark. */
export function isNationalLibraryBuilding(building: BuildingFeature): boolean {
  return building?.landmark === 'national-library';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ringInfoOf(points: Point2[]): RingInfo {
  const area = signedArea(points);
  return { points, isHole: false, area, ccw: area > 0 };
}

/** Vertex-attribute payload with optional style flag / roof-shape overrides. */
function landmarkSurface(
  style: BuildingStyle,
  kind: number,
  color: SurfaceStyle['color'],
  extraFlags = 0,
  roofShapeId?: number,
): SurfaceStyle {
  return {
    owner: style.owner,
    color,
    style: style.style,
    face: [kind, style.flags | extraFlags, style.trimIntensity, roofShapeId ?? style.detailScale],
  };
}

function normalize3(x: number, y: number, z: number): Vec3 {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/**
 * Emit a world-space triangle, flipping the winding if it does not match the
 * supplied normal (MeshSink.addTriangle trusts its caller for winding).
 */
function addOrientedTriangle(
  sink: MeshSink,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  normal: Vec3,
  ua: number,
  va: number,
  ub: number,
  vb: number,
  uc: number,
  vc: number,
  surface: SurfaceStyle,
): void {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  if (cx * normal[0] + cy * normal[1] + cz * normal[2] >= 0) {
    sink.addTriangle(
      a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2],
      normal[0], normal[1], normal[2], ua, va, ub, vb, uc, vc, surface,
    );
  } else {
    sink.addTriangle(
      a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2],
      normal[0], normal[1], normal[2], ua, va, uc, vc, ub, vb, surface,
    );
  }
}

/** Append the whole National Library massing (podium + diamond) to the sink. */
export function addNationalLibrary(
  sink: MeshSink,
  building: BuildingFeature,
  style: BuildingStyle,
  onWarning?: (message: string) => void,
): void {
  const warn = onWarning ?? (() => {});
  try {
    if (!building) {
      warn('national library: missing building feature');
      return;
    }
    const rings = prepareOutline(building.outline);
    if (!rings) {
      warn('national library: missing or unusable outline; landmark skipped');
      return;
    }
    const trianglesBefore = sink.triangles;
    addPodium(sink, rings, style);
    addDiamond(sink, rings, style, warn);
    if (sink.triangles === trianglesBefore) {
      warn('national library: landmark produced no geometry');
    }
  } catch (error) {
    warn(`national library failed: ${describeError(error)}`);
  }
}

/** Clean and validate the outline rings; null when unusable. */
function prepareOutline(outline: Polygon | undefined): Ring[] | null {
  if (!outline || !outline.length) return null;
  const rings: Point2[][] = [];
  for (const ring of outline) {
    const cleaned = cleanRing(ring);
    if (cleaned.length >= 3) rings.push(cleaned);
  }
  if (!rings.length) return null;
  let area = Math.abs(signedArea(rings[0]));
  for (let i = 1; i < rings.length; i++) area -= Math.abs(signedArea(rings[i]));
  if (!(area >= MIN_OUTLINE_AREA) || !Number.isFinite(area)) return null;
  return rings as Ring[];
}

/** Warm light-stone terraced podium with a glazed skirt band and a roof deck. */
function addPodium(sink: MeshSink, rings: readonly Ring[], style: BuildingStyle): void {
  const podium: BuildingVolume = {
    footprint: rings as Polygon,
    minHeight: 0,
    height: NATIONAL_LIBRARY_PODIUM_TOP,
    roofShape: 'flat',
    roofHeight: 0,
    heightSource: 'osm_height',
  };
  const podiumRings = boundaryRings(podium);
  if (!podiumRings.length) return;
  // Walls reuse the regular wall generator (procedural civic windows, ground
  // band and accumulated-metre aUV) but with the explicit warm light-stone
  // palette so the stylobate does not read as generic/washed-out white.
  const podiumStyle: BuildingStyle = {
    ...style,
    baseColor: NATIONAL_LIBRARY_PODIUM_STONE,
    trimColor: NATIONAL_LIBRARY_CORNICE_STONE,
  };
  addVolumeWalls(sink, podium, podiumRings, podiumStyle, 0);

  const exterior = podiumRings[0];
  const skirtSurface = landmarkSurface(
    style,
    FACE_KIND.trim,
    NATIONAL_LIBRARY_SKIRT_STONE,
    STYLE_FLAG.blank,
  );
  const corniceSurface = landmarkSurface(
    style,
    FACE_KIND.trim,
    NATIONAL_LIBRARY_CORNICE_STONE,
    STYLE_FLAG.blank,
  );
  const roofSurface = landmarkSurface(
    style,
    FACE_KIND.roof,
    NATIONAL_LIBRARY_DECK_STONE,
    STYLE_FLAG.blank,
    ROOF_SHAPE_ID.flat,
  );

  // Terraced skirt (one 0.9 m step) around the base: darker stone step.
  const skirtRing = offsetRing(exterior, TERRACE_SKIRT_OUTSET);
  addProjectingBand(
    sink,
    exterior,
    skirtRing,
    0,
    TERRACE_SKIRT_TOP,
    skirtSurface,
    true,
    true,
    style,
  );

  // Projecting cornice band below the roof deck: stays light stone.
  const corniceRing = offsetRing(exterior, PODIUM_CORNICE_OUTSET);
  addProjectingBand(
    sink,
    exterior,
    corniceRing,
    NATIONAL_LIBRARY_CORNICE_BOTTOM,
    NATIONAL_LIBRARY_PODIUM_TOP,
    corniceSurface,
    true,
    true,
    style,
  );

  // Dark glazed skirt band around the stylobate base (3.0..5.5 m), slightly
  // proud of the wall so it reads as continuous glazing at city zoom.
  addPodiumGlassBand(sink, podiumRings, style);

  // Flat roof deck at 13.9 m (holes preserved), slightly darker stone.
  const deck = triangulatePolygon(podiumRings.map((ring) => ring.points));
  for (const triangle of deck.triangles) {
    const { a, b, c } = triangle;
    const signed = triangleSignedArea(a, b, c);
    if (Math.abs(signed) < 1e-6) continue;
    const height = NATIONAL_LIBRARY_PODIUM_TOP;
    const ax = a[0];
    const az = -a[1];
    const bx = b[0];
    const bz = -b[1];
    const cx = c[0];
    const cz = -c[1];
    if (signed > 0) {
      sink.addTriangle(ax, height, az, bx, height, bz, cx, height, cz, 0, 1, 0, a[0], a[1], b[0], b[1], c[0], c[1], roofSurface);
    } else {
      sink.addTriangle(ax, height, az, cx, height, cz, bx, height, bz, 0, 1, 0, a[0], a[1], c[0], c[1], b[0], b[1], roofSurface);
    }
  }
}

/**
 * Dark glazed band wrapped around the podium base (3.0..5.5 m). It sits a few
 * centimetres proud of the stone wall so it reads as continuous glazing instead
 * of z-fighting with the procedural facade.
 */
function addPodiumGlassBand(
  sink: MeshSink,
  rings: readonly RingInfo[],
  style: BuildingStyle,
): void {
  const surface = landmarkSurface(
    style,
    FACE_KIND.glass,
    NATIONAL_LIBRARY_GLASS_BAND,
    STYLE_FLAG.blank,
  );
  const bottom = NATIONAL_LIBRARY_GLASS_BOTTOM;
  const top = NATIONAL_LIBRARY_GLASS_TOP;
  for (const ring of rings) {
    const outer = offsetRing(ring, GLASS_BAND_PROUD);
    const n = Math.min(ring.points.length, outer.length);
    if (n < 3) continue;
    let uCursor = 0;
    for (let i = 0; i < n; i++) {
      const p0 = ring.points[i];
      const p1 = ring.points[(i + 1) % n];
      const o0 = outer[i];
      const o1 = outer[(i + 1) % n];
      const edgeLength = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const u0 = uCursor;
      const u1 = uCursor + edgeLength;
      uCursor = u1;
      if (edgeLength < 1e-3) continue;
      const [nlx, nly] = boundaryNormalLocal(ring, i);
      sink.addQuad(
        o0[0], bottom, -o0[1],
        o1[0], bottom, -o1[1],
        o1[0], top, -o1[1],
        o0[0], top, -o0[1],
        u0, bottom, u1, bottom, u1, top, u0, top,
        nlx, 0, -nly, surface,
      );
    }
  }
}

/**
 * Vertical projecting band (outer face + top ledge) from an offset ring,
 * used for the terrace skirt and the cornice.
 */
function addProjectingBand(
  sink: MeshSink,
  wallRing: RingInfo,
  outerPoints: Point2[],
  bottom: number,
  top: number,
  surface: SurfaceStyle,
  topLedge: boolean,
  bottomFace: boolean,
  style: BuildingStyle,
): void {
  void style;
  const wallPoints = wallRing.points;
  const n = Math.min(wallPoints.length, outerPoints.length);
  if (n < 3) return;
  let uCursor = 0;
  for (let i = 0; i < n; i++) {
    const p0 = wallPoints[i];
    const p1 = wallPoints[(i + 1) % n];
    const o0 = outerPoints[i];
    const o1 = outerPoints[(i + 1) % n];
    const edgeLength = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const u0 = uCursor;
    const u1 = uCursor + edgeLength;
    uCursor = u1;
    if (edgeLength < 1e-3) continue;
    const [nlx, nly] = boundaryNormalLocal(wallRing, i);
    const nx = nlx;
    const nz = -nly;
    sink.addQuad(
      o0[0], bottom, -o0[1],
      o1[0], bottom, -o1[1],
      o1[0], top, -o1[1],
      o0[0], top, -o0[1],
      u0, bottom, u1, bottom, u1, top, u0, top,
      nx, 0, nz, surface,
    );
    if (topLedge) {
      sink.addQuad(
        o0[0], top, -o0[1],
        o1[0], top, -o1[1],
        p1[0], top, -p1[1],
        p0[0], top, -p0[1],
        u0, top, u1, top, u1, top, u0, top,
        0, 1, 0, surface,
      );
    }
    if (bottomFace) {
      sink.addQuad(
        p0[0], bottom, -p0[1],
        p1[0], bottom, -p1[1],
        o1[0], bottom, -o1[1],
        o0[0], bottom, -o0[1],
        u0, bottom, u1, bottom, u1, bottom, u0, bottom,
        0, -1, 0, surface,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Diamond: rhombicuboctahedron
// ---------------------------------------------------------------------------

interface DiamondFace {
  /** Outward unit normal in model space (model Z is vertical). */
  normal: Vec3;
  /** Model-space vertices, ordered CCW around the normal. */
  points: Vec3[];
}

/** Build the 24 vertices + 26 faces of the rhombicuboctahedron. */
export function buildDiamondFaces(edge: number): DiamondFace[] {
  const s = edge / 2;
  const big = (1 + Math.SQRT2) * s;
  const vertices: Vec3[] = [];
  for (let bigAxis = 0; bigAxis < 3; bigAxis++) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const signs = [sx, sy, sz];
          const vertex = signs.map((sign, axis) => sign * (axis === bigAxis ? big : s)) as Vec3;
          vertices.push(vertex);
        }
      }
    }
  }
  const normals: Vec3[] = [];
  // 6 axis faces.
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const n: Vec3 = [0, 0, 0];
      n[axis] = sign;
      normals.push(n);
    }
  }
  // 12 edge faces: permutations of (±1, ±1, 0) / sqrt(2).
  for (let zeroAxis = 0; zeroAxis < 3; zeroAxis++) {
    for (const s1 of [-1, 1]) {
      for (const s2 of [-1, 1]) {
        const n: Vec3 = [0, 0, 0];
        const axes = [0, 1, 2].filter((axis) => axis !== zeroAxis);
        n[axes[0]] = s1 / Math.SQRT2;
        n[axes[1]] = s2 / Math.SQRT2;
        normals.push(n);
      }
    }
  }
  // 8 corner faces: (±1, ±1, ±1) / sqrt(3).
  const third = 1 / Math.sqrt(3);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        normals.push([sx * third, sy * third, sz * third]);
      }
    }
  }

  const faces: DiamondFace[] = [];
  for (const normal of normals) {
    let maxDot = -Infinity;
    for (const vertex of vertices) {
      const dot = normal[0] * vertex[0] + normal[1] * vertex[1] + normal[2] * vertex[2];
      if (dot > maxDot) maxDot = dot;
    }
    const onFace: Vec3[] = [];
    for (const vertex of vertices) {
      const dot = normal[0] * vertex[0] + normal[1] * vertex[1] + normal[2] * vertex[2];
      if (maxDot - dot < 1e-6) onFace.push(vertex);
    }
    if (onFace.length < 3) continue;
    // Order CCW around the outward normal.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const point of onFace) {
      cx += point[0];
      cy += point[1];
      cz += point[2];
    }
    cx /= onFace.length;
    cy /= onFace.length;
    cz /= onFace.length;
    const helper: Vec3 = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let e1 = normalize3(
      normal[1] * helper[2] - normal[2] * helper[1],
      normal[2] * helper[0] - normal[0] * helper[2],
      normal[0] * helper[1] - normal[1] * helper[0],
    );
    if (!Number.isFinite(e1[0]) || Math.hypot(e1[0], e1[1], e1[2]) < 0.5) {
      e1 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    }
    const e2: Vec3 = [
      normal[1] * e1[2] - normal[2] * e1[1],
      normal[2] * e1[0] - normal[0] * e1[2],
      normal[0] * e1[1] - normal[1] * e1[0],
    ];
    const ordered = onFace
      .map((point) => {
        const px = point[0] - cx;
        const py = point[1] - cy;
        const pz = point[2] - cz;
        return {
          point,
          angle: Math.atan2(px * e2[0] + py * e2[1] + pz * e2[2], px * e1[0] + py * e1[1] + pz * e1[2]),
        };
      })
      .sort((a, b) => a.angle - b.angle)
      .map((entry) => entry.point);
    faces.push({ normal, points: ordered });
  }
  return faces;
}

function bandColour(normalZ: number): SurfaceStyle['color'] {
  if (normalZ > 0.99) return TOP_GLASS;
  if (normalZ >= 0.2) return UPPER;
  if (normalZ <= -0.2) return LOWER;
  return BELT;
}

/** The blue-glass diamond placed on the podium centroid. */
function addDiamond(
  sink: MeshSink,
  rings: readonly Ring[],
  style: BuildingStyle,
  warn: (message: string) => void,
): void {
  const exterior = cleanRing(rings[0]);
  if (exterior.length < 3) {
    warn('national library: podium outline unusable for the diamond');
    return;
  }
  const centre = polygonCentroid([exterior]);
  if (!Number.isFinite(centre[0]) || !Number.isFinite(centre[1])) {
    warn('national library: podium centroid is not finite');
    return;
  }
  const faces = buildDiamondFaces(NATIONAL_LIBRARY_DIAMOND_EDGE);
  if (faces.length !== 26) {
    warn(`national library: expected 26 diamond faces, built ${faces.length}`);
  }

  const centreY = NATIONAL_LIBRARY_DIAMOND_CENTRE;
  const baseSurface = (colour: SurfaceStyle['color']): SurfaceStyle =>
    landmarkSurface(style, FACE_KIND.wall, colour, STYLE_FLAG.blank);
  const surfaceByColour = new Map<string, SurfaceStyle>();

  // Model (x, y, z) -> world (centreX + x, centreY + z, -centreY - y).
  const toWorld = (point: Vec3): Vec3 => [
    centre[0] + point[0],
    centreY + point[2],
    -centre[1] - point[1],
  ];

  for (const face of faces) {
    const colour = bandColour(face.normal[2]);
    const key = colour.join(',');
    let surface = surfaceByColour.get(key);
    if (!surface) {
      surface = baseSurface(colour);
      surfaceByColour.set(key, surface);
    }
    const worldNormal = normalize3(face.normal[0], face.normal[2], -face.normal[1]);
    const worldPoints = face.points.map(toWorld);
    // Accumulated u along this face's perimeter; v = absolute world height.
    let uCursor = 0;
    for (let i = 1; i + 1 < worldPoints.length; i++) {
      const a = worldPoints[0];
      const b = worldPoints[i];
      const c = worldPoints[i + 1];
      const ua = uCursor;
      const ub = uCursor + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const uc = ub + Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
      uCursor = uc;
      addOrientedTriangle(
        sink, a, b, c, worldNormal,
        ua, a[1], ub, b[1], uc, c[1],
        surface,
      );
    }
  }

  // Aluminium mullion rims where the three glass bands meet.
  addMullionBands(sink, faces, toWorld, style);
}

/** Clip a convex 3D polygon by a model-space Z half-space. */
function clipByZ(
  polygon: Vec3[],
  z: number,
  keepGreater: boolean,
): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    const currentInside = keepGreater ? current[2] >= z : current[2] <= z;
    const nextInside = keepGreater ? next[2] >= z : next[2] <= z;
    if (currentInside) out.push(current);
    if (currentInside !== nextInside) {
      const t = (z - current[2]) / (next[2] - current[2]);
      out.push([
        current[0] + (next[0] - current[0]) * t,
        current[1] + (next[1] - current[1]) * t,
        z,
      ]);
    }
  }
  return out;
}

/** Thin aluminium rims lying on the diamond surface at the band boundaries. */
function addMullionBands(
  sink: MeshSink,
  faces: readonly DiamondFace[],
  toWorld: (point: Vec3) => Vec3,
  style: BuildingStyle,
): void {
  const surface = landmarkSurface(style, FACE_KIND.trim, ALUMINIUM, STYLE_FLAG.blank);
  const half = MULLION_BAND_THICKNESS / 2;
  for (const face of faces) {
    if (Math.abs(face.normal[2]) > 0.99) continue; // horizontal top/bottom faces
    for (const bandHeight of NATIONAL_LIBRARY_BAND_HEIGHTS) {
      const modelZ = bandHeight - NATIONAL_LIBRARY_DIAMOND_CENTRE;
      let polygon = clipByZ(face.points, modelZ - half, true);
      if (polygon.length < 3) continue;
      polygon = clipByZ(polygon, modelZ + half, false);
      if (polygon.length < 3) continue;
      // Slightly proud of the glass so the rim reads at close zoom.
      const offsetPoints = polygon.map((point): Vec3 => [
        point[0] + face.normal[0] * MULLION_BAND_OUTSET,
        point[1] + face.normal[1] * MULLION_BAND_OUTSET,
        point[2] + face.normal[2] * MULLION_BAND_OUTSET,
      ]);
      const worldNormal = normalize3(face.normal[0], face.normal[2], -face.normal[1]);
      const worldPoints = offsetPoints.map(toWorld);
      let uCursor = 0;
      for (let i = 1; i + 1 < worldPoints.length; i++) {
        const a = worldPoints[0];
        const b = worldPoints[i];
        const c = worldPoints[i + 1];
        const ua = uCursor;
        const ub = uCursor + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        const uc = ub + Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
        uCursor = uc;
        addOrientedTriangle(sink, a, b, c, worldNormal, ua, a[1], ub, b[1], uc, c[1], surface);
      }
    }
  }
}

/** Re-exported types for tests. */
export type { DiamondFace };
