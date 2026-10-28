/**
 * Minsk Gate towers ("Ворота Минска") — landmark procedural superstructure.
 *
 * The two 11-storey gate towers are the same OSM ensemble (relation 9383682):
 * one BuildingFeature carries broad base blocks plus two tall tower tiers as
 * building:part volumes. OSM has no data for the clock dials, the BSSR emblem
 * medallion, the flat parapet/attic or the four corner turret stars, so they
 * are generated here on top of the regular volume meshes. The real towers are
 * flat-topped pylons (no spires) — verified against the Wikimedia Commons photo
 * of the Privokzalnaya Square ensemble.
 *
 * This module is additive only: it appends triangles to the tile MeshSink after
 * the normal volume loop (walls/roofs of base blocks and tiers are meshed by
 * the regular builder). Owner/style attributes are inherited from the building,
 * so picking on the crown still resolves to the ensemble's FeatureId.
 *
 * Geometry is fully deterministic (no Math.random, no THREE objects): only
 * MeshSink.addQuad/addTriangle and plain number arrays.
 *
 * Units: metres. Local plan coords (x east, y north) are mapped to world space
 * as (x, height, -y) exactly like the rest of the building builder.
 */

import { FACE_KIND, ROOF_SHAPE_ID, STYLE_FLAG } from '../../shared/geometry';
import type { BuildingFeature, BuildingVolume } from '../../shared/types';
import type { MeshSink, SurfaceStyle } from './meshSink';
import {
  cleanRing,
  minAreaRect,
  pointInPolygon,
  polygonCentroid,
  signedArea,
  triangleSignedArea,
  type Point2,
} from './polygon2d';
import { offsetRing } from './palaceAccents';
import { srgbFromHex, type BuildingStyle } from './style';
import { boundaryNormalLocal, type RingInfo } from './walls';
import { triangulatePolygon } from './triangulate';

/** Shared landmark id for the two-tower ensemble. */
const MINSK_GATE_LANDMARK = 'minsk-gate';

// --- crown proportions (metres) -------------------------------------------
// Reference: the gate towers are flat-topped Stalinist pylons. Above the eave
// they carry a projecting cornice, a low attic/parapet block, one large round
// clock (east tower) or the round BSSR emblem medallion (west tower) set into
// the tower face, and four corner turrets with small gold stars. There is no
// spire on the real ensemble (verified against the Wikimedia Commons photo of
// the square), so this module deliberately emits a flat parapet crown.
const CORNICE_OUTSET = 0.5;
const CORNICE_DROP = 0.25;
const CORNICE_RISE = 0.75;
const ATTIC_INSET = 1.3;
const ATTIC_RISE = 2.6; // attic block above the cornice top
const MEDALLION_RADIUS = 1.62;
const MEDALLION_THICKNESS = 0.18;
const MEDALLION_SEGMENTS = 12;
/** Medallion centre below the tier eave: the dial sits high on the tower face. */
const MEDALLION_DROP = 1.95;
const PINNACLE_HALF = 0.5;
const PINNACLE_SHAFT_RISE = 1.1;
const PINNACLE_CAP_RISE = 0.55;
const PINNACLE_STAR_HALF_HEIGHT = 0.3;
const PINNACLE_STAR_RADIUS = 0.16;
const MIN_TIER_HEIGHT = 20;
const MIN_TIER_AREA = 40;
const MIN_WALL_WIDTH = 6;
const MAX_FEATURES_PER_TOWER = 4;
const MIN_ATTIC_AREA_RATIO = 0.3;

const SLATE = srgbFromHex('#46505A');
const GOLD = srgbFromHex('#C9A227');
const CLOCK_FACE = srgbFromHex('#22262B');

export interface GateTier {
  volume: BuildingVolume;
  /** Cleaned exterior ring of the tier footprint. */
  points: Point2[];
  centroid: Point2;
  area: number;
}

/** True when the feature is the Minsk Gate ensemble (both towers). */
export function isCityGateBuilding(building: BuildingFeature): boolean {
  return (building?.landmark as string | undefined) === MINSK_GATE_LANDMARK;
}

function ringInfoOf(points: Point2[]): RingInfo {
  const area = signedArea(points);
  return { points, isHole: false, area, ccw: area > 0 };
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/** Vertex-attribute payload with optional extra style flags / roof shape id. */
function crownSurface(
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
    face: [
      kind,
      style.flags | extraFlags,
      style.trimIntensity,
      roofShapeId ?? style.detailScale,
    ],
  };
}

/**
 * Emission helper that guarantees the triangle winding matches the requested
 * normal (MeshSink.addTriangle trusts its caller for winding).
 */
function addOrientedTriangle(
  sink: MeshSink,
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  normal: [number, number, number],
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
  const crossX = aby * acz - abz * acy;
  const crossY = abz * acx - abx * acz;
  const crossZ = abx * acy - aby * acx;
  if (crossX * normal[0] + crossY * normal[1] + crossZ * normal[2] >= 0) {
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

/** Flat polygon facing up (roof deck / clock tier cap). */
function addFlatDeck(
  sink: MeshSink,
  points: readonly Point2[],
  height: number,
  surface: SurfaceStyle,
): void {
  const triangulation = triangulatePolygon([points as Point2[]]);
  for (const triangle of triangulation.triangles) {
    const { a, b, c } = triangle;
    const signed = triangleSignedArea(a, b, c);
    if (Math.abs(signed) < 1e-6) continue;
    const ax = a[0];
    const az = -a[1];
    const bx = b[0];
    const bz = -b[1];
    const cx = c[0];
    const cz = -c[1];
    // Local CCW winding maps to world +Y normal.
    if (signed > 0) {
      sink.addTriangle(ax, height, az, bx, height, bz, cx, height, cz, 0, 1, 0, a[0], a[1], b[0], b[1], c[0], c[1], surface);
    } else {
      sink.addTriangle(ax, height, az, cx, height, cz, bx, height, bz, 0, 1, 0, a[0], a[1], c[0], c[1], b[0], b[1], surface);
    }
  }
}

/**
 * Deterministic tier selection: the tall building:part volumes of the
 * ensemble, sorted by footprint centroid x then y.
 */
export function selectGateTiers(building: BuildingFeature): GateTier[] {
  const volumes: readonly BuildingVolume[] = Array.isArray(building?.volumes)
    ? building.volumes
    : [];
  const tiers: GateTier[] = [];
  for (const volume of volumes) {
    if (!volume || volume.isPart !== true) continue;
    if (!(Number.isFinite(volume.height) && volume.height >= 30)) continue;
    const points = cleanRing(volume.footprint?.[0]);
    if (points.length < 4) continue;
    const area = Math.abs(signedArea(points));
    if (!(area >= MIN_TIER_AREA)) continue;
    tiers.push({ volume, points, centroid: polygonCentroid([points]), area });
  }
  tiers.sort((a, b) => {
    if (a.centroid[0] !== b.centroid[0]) return a.centroid[0] - b.centroid[0];
    if (a.centroid[1] !== b.centroid[1]) return a.centroid[1] - b.centroid[1];
    return b.volume.height - a.volume.height;
  });
  return tiers;
}

/**
 * Append the landmark superstructure (one crown per tall tier: first = clock,
 * second = BSSR emblem). Never throws; reports problems through `onWarning`.
 */
export function addCityGateCrown(
  sink: MeshSink,
  building: BuildingFeature,
  style: BuildingStyle,
  onWarning?: (message: string) => void,
): void {
  const warn = onWarning ?? (() => {});
  try {
    if (!isCityGateBuilding(building)) return;
    const tiers = selectGateTiers(building);
    if (!tiers.length) {
      warn('city gate: no usable tier volumes (building:part, height >= 30 m, footprint >= 40 m²)');
      return;
    }
    const maxTowers = Math.min(2, tiers.length);
    for (let index = 0; index < maxTowers; index++) {
      // Smallest-x tier carries the clock, the second one the BSSR emblem;
      // a single-tier data variant still gets the clock treatment.
      const isClock = index === 0;
      try {
        addTowerCrown(sink, tiers[index], style, isClock, warn);
      } catch (error) {
        warn(`city gate tower ${index} failed: ${describeError(error)}`);
      }
    }
  } catch (error) {
    warn(`city gate crown failed: ${describeError(error)}`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build the crown of one gate tower above its tier eave. */
function addTowerCrown(
  sink: MeshSink,
  tier: GateTier,
  style: BuildingStyle,
  isClock: boolean,
  warn: (message: string) => void,
): void {
  const volume = tier.volume;
  const tierTop = volume.height;
  const base = Number.isFinite(volume.minHeight) ? volume.minHeight : 0;
  if (!(Number.isFinite(tierTop) && tierTop >= MIN_TIER_HEIGHT)) {
    warn(`city gate: tier eave ${tierTop} m is below ${MIN_TIER_HEIGHT} m; crown skipped`);
    return;
  }
  if (!(tier.area >= MIN_TIER_AREA)) {
    warn(`city gate: tier footprint ${tier.area.toFixed(1)} m² is too small; crown skipped`);
    return;
  }
  const tierRect = minAreaRect(tier.points);
  if (!tierRect || !(tierRect.halfWidth > 4.5) || !(tierRect.halfLength > 4.5)) {
    warn('city gate: tier footprint is not a usable rectangle; crown skipped');
    return;
  }

  const tierRing = ringInfoOf(tier.points);
  const cornicePoints = offsetRing(tierRing, CORNICE_OUTSET);
  const atticPoints = offsetRing(tierRing, -ATTIC_INSET);
  const atticArea = Math.abs(signedArea(atticPoints));
  if (
    atticPoints.length !== tier.points.length ||
    !(atticArea >= Math.max(20, tier.area * MIN_ATTIC_AREA_RATIO))
  ) {
    warn('city gate: attic inset collapses the footprint; crown skipped');
    return;
  }
  for (const point of atticPoints) {
    if (!pointInPolygon([tier.points], point[0], point[1])) {
      warn('city gate: attic inset is invalid; crown skipped');
      return;
    }
  }
  const atticRing = ringInfoOf(atticPoints);
  const atticRect = minAreaRect(atticPoints);
  if (!atticRect) {
    warn('city gate: attic rectangle unavailable; crown skipped');
    return;
  }

  const trimSurface = crownSurface(style, FACE_KIND.trim, style.trimColor);
  const atticWallSurface = crownSurface(style, FACE_KIND.trim, style.trimColor, STYLE_FLAG.blank);
  const parapetSurface = crownSurface(style, FACE_KIND.roof, SLATE, 0, ROOF_SHAPE_ID.flat);

  const corniceBottom = tierTop - CORNICE_DROP;
  const corniceTop = tierTop + CORNICE_RISE;
  const atticTop = corniceTop + ATTIC_RISE;
  const pinnacleBase = atticTop;
  const pinnacleTop = pinnacleBase + PINNACLE_SHAFT_RISE;
  const pinnacleCap = pinnacleTop + PINNACLE_CAP_RISE;

  const n = tier.points.length;
  // --- cornice: projecting band + top ledge + underside --------------------
  let uCornice = 0;
  for (let i = 0; i < n; i++) {
    const p0 = tier.points[i];
    const p1 = tier.points[(i + 1) % n];
    const o0 = cornicePoints[i];
    const o1 = cornicePoints[(i + 1) % n];
    const a0 = atticPoints[i];
    const a1 = atticPoints[(i + 1) % n];
    const edgeLength = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const u0 = uCornice;
    const u1 = uCornice + edgeLength;
    uCornice = u1;
    if (edgeLength < 1e-3) continue;
    const [nlx, nly] = boundaryNormalLocal(tierRing, i);
    const nx = nlx;
    const nz = -nly;
    // Outer vertical band.
    sink.addQuad(
      o0[0], corniceBottom, -o0[1],
      o1[0], corniceBottom, -o1[1],
      o1[0], corniceTop, -o1[1],
      o0[0], corniceTop, -o0[1],
      u0, corniceBottom - base, u1, corniceBottom - base,
      u1, corniceTop - base, u0, corniceTop - base,
      nx, 0, nz, trimSurface,
    );
    // Top ledge: outset ring -> attic wall base.
    sink.addQuad(
      o0[0], corniceTop, -o0[1],
      o1[0], corniceTop, -o1[1],
      a1[0], corniceTop, -a1[1],
      a0[0], corniceTop, -a0[1],
      u0, corniceTop - base, u1, corniceTop - base,
      u1, corniceTop - base, u0, corniceTop - base,
      0, 1, 0, trimSurface,
    );
    // Underside ledge (wall -> outset), facing down.
    sink.addQuad(
      p0[0], corniceBottom, -p0[1],
      p1[0], corniceBottom, -p1[1],
      o1[0], corniceBottom, -o1[1],
      o0[0], corniceBottom, -o0[1],
      u0, corniceBottom - base, u1, corniceBottom - base,
      u1, corniceBottom - base, u0, corniceBottom - base,
      0, -1, 0, trimSurface,
    );
  }

  // --- attic / parapet block + flat deck -----------------------------------
  let uAttic = 0;
  for (let i = 0; i < atticRing.points.length; i++) {
    const a0 = atticRing.points[i];
    const a1 = atticRing.points[(i + 1) % atticRing.points.length];
    const edgeLength = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
    const u0 = uAttic;
    const u1 = uAttic + edgeLength;
    uAttic = u1;
    if (edgeLength < 1e-3) continue;
    const [nlx, nly] = boundaryNormalLocal(atticRing, i);
    sink.addQuad(
      a0[0], corniceTop, -a0[1],
      a1[0], corniceTop, -a1[1],
      a1[0], atticTop, -a1[1],
      a0[0], atticTop, -a0[1],
      u0, corniceTop - base, u1, corniceTop - base,
      u1, atticTop - base, u0, atticTop - base,
      nlx, 0, -nly, atticWallSurface,
    );
  }
  addFlatDeck(sink, atticPoints, atticTop, parapetSurface);

  // --- round medallion on the tower face (clock or BSSR emblem) -----------
  // The dial sits high on the main tower wall, just below the projecting
  // cornice, exactly like the real ensemble.
  const featureEdges: { a: Point2; b: Point2; normal: [number, number] }[] = [];
  for (let i = 0; i < n; i++) {
    const a = tier.points[i];
    const b = tier.points[(i + 1) % n];
    const width = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (width < MIN_WALL_WIDTH) continue;
    const [nlx, nly] = boundaryNormalLocal(tierRing, i);
    featureEdges.push({ a, b, normal: [nlx, -nly] });
    if (featureEdges.length >= MAX_FEATURES_PER_TOWER) break;
  }
  for (const edge of featureEdges) {
    addMedallion(sink, style, edge.a, edge.b, edge.normal, tierTop - MEDALLION_DROP, isClock);
  }

  // --- four corner turrets with small gold stars --------------------------
  // The real towers are framed by small ornamental turrets with star finials;
  // they are the only vertical accents above the flat parapet.
  const corners: Point2[] = [
    [atticRect.cx + atticRect.ux * atticRect.halfLength + -atticRect.uy * atticRect.halfWidth,
     atticRect.cy + atticRect.uy * atticRect.halfLength + atticRect.ux * atticRect.halfWidth],
    [atticRect.cx + atticRect.ux * atticRect.halfLength - -atticRect.uy * atticRect.halfWidth,
     atticRect.cy + atticRect.uy * atticRect.halfLength - atticRect.ux * atticRect.halfWidth],
    [atticRect.cx - atticRect.ux * atticRect.halfLength + -atticRect.uy * atticRect.halfWidth,
     atticRect.cy - atticRect.uy * atticRect.halfLength + atticRect.ux * atticRect.halfWidth],
    [atticRect.cx - atticRect.ux * atticRect.halfLength - -atticRect.uy * atticRect.halfWidth,
     atticRect.cy - atticRect.uy * atticRect.halfLength - atticRect.ux * atticRect.halfWidth],
  ];
  for (const corner of corners) {
    addPinnacle(sink, style, corner, atticRect.ux, atticRect.uy, pinnacleBase, pinnacleTop, pinnacleCap);
    addStar(
      sink,
      style,
      corner,
      pinnacleCap + PINNACLE_STAR_HALF_HEIGHT * 0.4,
      GOLD,
      PINNACLE_STAR_HALF_HEIGHT,
      PINNACLE_STAR_RADIUS,
    );
  }
}

/**
 * Round medallion proud of the tower wall: the large clock on one tower, the
 * round BSSR emblem on the other. `isClock` adds the two gold clock hands.
 */
function addMedallion(
  sink: MeshSink,
  style: BuildingStyle,
  a: Point2,
  b: Point2,
  normal: [number, number],
  centreHeight: number,
  isClock: boolean,
): void {
  const ax = a[0];
  const az = -a[1];
  const bx = b[0];
  const bz = -b[1];
  const dx = bx - ax;
  const dz = bz - az;
  const width = Math.hypot(dx, dz);
  if (!(width > 1e-3)) return;
  const tx = dx / width;
  const tz = dz / width;
  const nx = normal[0];
  const nz = normal[1];
  const mx = (ax + bx) / 2 + nx * (MEDALLION_THICKNESS / 2);
  const mz = (az + bz) / 2 + nz * (MEDALLION_THICKNESS / 2);
  const cy = centreHeight;
  const rimSurface = crownSurface(style, FACE_KIND.trim, style.trimColor);
  const faceSurface = isClock
    ? crownSurface(style, FACE_KIND.glass, CLOCK_FACE)
    : crownSurface(style, FACE_KIND.trim, GOLD);

  const back: [number, number, number][] = [];
  const front: [number, number, number][] = [];
  for (let i = 0; i < MEDALLION_SEGMENTS; i++) {
    const angle = (i / MEDALLION_SEGMENTS) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const px = mx + tx * MEDALLION_RADIUS * cos;
    const pz = mz + tz * MEDALLION_RADIUS * cos;
    const py = cy + MEDALLION_RADIUS * sin;
    back.push([px - nx * (MEDALLION_THICKNESS / 2), py, pz - nz * (MEDALLION_THICKNESS / 2)]);
    front.push([px + nx * (MEDALLION_THICKNESS / 2), py, pz + nz * (MEDALLION_THICKNESS / 2)]);
  }
  // Rim ring (painted trim): outward radial faces.
  for (let i = 0; i < MEDALLION_SEGMENTS; i++) {
    const j = (i + 1) % MEDALLION_SEGMENTS;
    const angle = ((i + 0.5) / MEDALLION_SEGMENTS) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rx = tx * cos;
    const ry = sin;
    const rz = tz * cos;
    const u0 = (i / MEDALLION_SEGMENTS) * Math.PI * 2 * MEDALLION_RADIUS;
    const u1 = ((i + 1) / MEDALLION_SEGMENTS) * Math.PI * 2 * MEDALLION_RADIUS;
    sink.addQuad(
      back[i][0], back[i][1], back[i][2],
      back[j][0], back[j][1], back[j][2],
      front[j][0], front[j][1], front[j][2],
      front[i][0], front[i][1], front[i][2],
      u0, 0, u1, 0, u1, MEDALLION_THICKNESS, u0, MEDALLION_THICKNESS,
      rx, ry, rz, rimSurface,
    );
  }
  // Face: 12-gon fan facing out along the wall normal.
  const faceNormal: [number, number, number] = [nx, 0, nz];
  for (let i = 1; i + 1 < MEDALLION_SEGMENTS; i++) {
    const p0 = front[0];
    const p1 = front[i];
    const p2 = front[i + 1];
    addOrientedTriangle(
      sink, p0, p1, p2, faceNormal,
      Math.cos(0) * MEDALLION_RADIUS, Math.sin(0) * MEDALLION_RADIUS,
      Math.cos((i / MEDALLION_SEGMENTS) * Math.PI * 2) * MEDALLION_RADIUS,
      Math.sin((i / MEDALLION_SEGMENTS) * Math.PI * 2) * MEDALLION_RADIUS,
      Math.cos(((i + 1) / MEDALLION_SEGMENTS) * Math.PI * 2) * MEDALLION_RADIUS,
      Math.sin(((i + 1) / MEDALLION_SEGMENTS) * Math.PI * 2) * MEDALLION_RADIUS,
      faceSurface,
    );
  }
  if (isClock) addClockHands(sink, style, mx, cy, mz, tx, tz, faceNormal);
}

/** Two flat gold hands on the clock face (fixed 10:10 pose). */
function addClockHands(
  sink: MeshSink,
  style: BuildingStyle,
  faceX: number,
  faceY: number,
  faceZ: number,
  tx: number,
  tz: number,
  normal: [number, number, number],
): void {
  const surface = crownSurface(style, FACE_KIND.trim, GOLD);
  const offsets = [
    { angle: Math.PI / 3, length: 1.16, halfBase: 0.08, halfTip: 0.035 },
    { angle: -Math.PI * 0.28, length: 0.82, halfBase: 0.085, halfTip: 0.045 },
  ];
  const proud = MEDALLION_THICKNESS / 2 + 0.02;
  const baseX = faceX + normal[0] * proud;
  const baseY = faceY;
  const baseZ = faceZ + normal[2] * proud;
  for (const hand of offsets) {
    const dirX = Math.sin(hand.angle) * tx;
    const dirY = Math.cos(hand.angle);
    const dirZ = Math.sin(hand.angle) * tz;
    const perpX = Math.cos(hand.angle) * tx;
    const perpY = -Math.sin(hand.angle);
    const perpZ = Math.cos(hand.angle) * tz;
    const p0: [number, number, number] = [
      baseX + perpX * hand.halfBase,
      baseY + perpY * hand.halfBase,
      baseZ + perpZ * hand.halfBase,
    ];
    const p1: [number, number, number] = [
      baseX - perpX * hand.halfBase,
      baseY - perpY * hand.halfBase,
      baseZ - perpZ * hand.halfBase,
    ];
    const t0: [number, number, number] = [
      baseX + dirX * hand.length + perpX * hand.halfTip,
      baseY + dirY * hand.length + perpY * hand.halfTip,
      baseZ + dirZ * hand.length + perpZ * hand.halfTip,
    ];
    const t1: [number, number, number] = [
      baseX + dirX * hand.length - perpX * hand.halfTip,
      baseY + dirY * hand.length - perpY * hand.halfTip,
      baseZ + dirZ * hand.length - perpZ * hand.halfTip,
    ];
    addOrientedTriangle(sink, p0, p1, t1, normal, 0, 0, 0, 0.2, 1, 1, surface);
    addOrientedTriangle(sink, p0, t1, t0, normal, 0, 0, 1, 1, 1, 0.2, surface);
  }
}

/** Squat corner pinnacle: blank shaft + small pyramid cap. */
function addPinnacle(
  sink: MeshSink,
  style: BuildingStyle,
  centre: Point2,
  ux: number,
  uy: number,
  baseY: number,
  topY: number,
  capTopY: number,
): void {
  const vx = -uy;
  const vy = ux;
  const half = PINNACLE_HALF;
  const offsets: [number, number][] = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
  const surface = crownSurface(style, FACE_KIND.trim, style.trimColor);
  const bottom: [number, number, number][] = [];
  const top: [number, number, number][] = [];
  for (const [u, v] of offsets) {
    const x = centre[0] + ux * u + vx * v;
    const yLocal = centre[1] + uy * u + vy * v;
    bottom.push([x, baseY, -yLocal]);
    top.push([x, topY, -yLocal]);
  }
  const cx = centre[0];
  const cz = -centre[1];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const midU = (offsets[i][0] + offsets[j][0]) / 2;
    const midV = (offsets[i][1] + offsets[j][1]) / 2;
    const normal = normalize3(ux * midU + vx * midV, 0, -(uy * midU + vy * midV));
    sink.addQuad(
      bottom[i][0], bottom[i][1], bottom[i][2],
      bottom[j][0], bottom[j][1], bottom[j][2],
      top[j][0], top[j][1], top[j][2],
      top[i][0], top[i][1], top[i][2],
      0, 0, 0.7, 0, 0.7, topY - baseY, 0, topY - baseY,
      normal[0], normal[1], normal[2], surface,
    );
  }
  const apex: [number, number, number] = [cx, capTopY, cz];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const a = top[i];
    const b = top[j];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const aax = apex[0] - a[0];
    const aay = apex[1] - a[1];
    const aaz = apex[2] - a[2];
    let normal = normalize3(aby * aaz - abz * aay, abz * aax - abx * aaz, abx * aay - aby * aax);
    // Outward: the pyramid face must point away from the pinnacle axis.
    const triCentroidX = (a[0] + b[0] + apex[0]) / 3 - cx;
    const triCentroidZ = (a[2] + b[2] + apex[2]) / 3 - cz;
    const outward = triCentroidX * normal[0] + triCentroidZ * normal[2];
    if (outward < 0) normal = [-normal[0], -normal[1], -normal[2]] as [number, number, number];
    addOrientedTriangle(sink, a, b, apex, normal, 0, 0, 0.7, 0, 0.35, 0.8, surface);
  }
}

/** Gold octahedral star finial (corner turrets, pinpoints on the parapet). */
function addStar(
  sink: MeshSink,
  style: BuildingStyle,
  centre: Point2,
  centreY: number,
  color: SurfaceStyle['color'],
  halfHeight: number,
  radius: number,
): void {
  const surface = crownSurface(style, FACE_KIND.trim, color);
  const cx = centre[0];
  const cz = -centre[1];
  const top: [number, number, number] = [cx, centreY + halfHeight, cz];
  const bottom: [number, number, number] = [cx, centreY - halfHeight, cz];
  const ring: [number, number, number][] = [];
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    ring.push([cx + Math.cos(angle) * radius, centreY, cz + Math.sin(angle) * radius]);
  }
  const faces: [number, number, number][][] = [];
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    faces.push([a, b, top]);
    faces.push([b, a, bottom]);
  }
  let u = 0;
  for (const [a, b, apex] of faces) {
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const ax = apex[0] - a[0];
    const ay = apex[1] - a[1];
    const az = apex[2] - a[2];
    const normal = normalize3(aby * az - abz * ay, abz * ax - abx * az, abx * ay - aby * ax);
    // Outward = away from the octahedron centre.
    const triCentroidX = (a[0] + b[0] + apex[0]) / 3 - cx;
    const triCentroidY = (a[1] + b[1] + apex[1]) / 3 - centreY;
    const triCentroidZ = (a[2] + b[2] + apex[2]) / 3 - cz;
    const outward =
      triCentroidX * normal[0] + triCentroidY * normal[1] + triCentroidZ * normal[2];
    const oriented =
      outward >= 0 ? normal : ([-normal[0], -normal[1], -normal[2]] as [number, number, number]);
    addOrientedTriangle(sink, a, b, apex, oriented, u, 0, u + 0.5, 0, u + 0.25, 1, surface);
    u += 0.5;
  }
}
