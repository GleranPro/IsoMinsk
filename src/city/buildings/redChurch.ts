/**
 * Church of Sts Simon and Helena ("Чырвоны касцёл" / Red Church, Independence
 * Square) — curated landmark geometry.
 *
 * The real building is a red-brick neo-gothic church: a gabled nave with a
 * large rose window, a symmetrical front facade with two tall towers (square
 * brick shafts, steep eight-sided spires, small gold crosses) and a taller
 * crossing bell tower (OSM: 50 m). OSM maps the church as one way plus detailed
 * `building:part` volumes: nave 25 m gabled (eave 22 + 3 roof), facade towers
 * 36 m pyramidal, crossing tower 50 m gabled, low side annexes.
 *
 * This module replaces the generic extrusion completely (curated landmark):
 *   - nave: the curated `outline` polygon extruded to 22 m with a gable roof
 *     (ridge along the longest min-area-rect axis, ~9 m rise) clipped to the
 *     real plan, plus a brick plinth, cream cornice and brick buttress strips;
 *   - front facade: two substantial 7.2 x 7.2 m twin towers placed in plan
 *     space either side of the front gable centreline (the OSM tall-part
 *     cluster marks which nave end is the entrance): brick shafts to 36 m with
 *     cream string courses, projecting stone cornice to 37 m, steep eight-sided
 *     slate spires to 50 m and small gold crosses (+2 m);
 *   - a rose window (glass 12-gon + cream trim ring) centred in the front gable
 *     between the two towers;
 *   - the crossing bell tower from the tallest OSM `building:part` (the 50 m
 *     part), capped with a steep slate roof and a gold cross.
 * The tiny OSM spire-tip parts (~4x5 m) are used only as a location hint; they
 * are never rendered as separate needle towers.
 *
 * Geometry is fully deterministic (no Math.random, no THREE objects): only
 * MeshSink.addQuad/addTriangle and plain number arrays. Units: metres; local
 * plan coords (x east, y north) map to world (x, height, -y).
 */

import { FACE_KIND, ROOF_SHAPE_ID, STYLE_FLAG } from '../../shared/geometry';
import type { BuildingFeature } from '../../shared/types';
import type { MeshSink, SurfaceStyle } from './meshSink';
import { offsetRing } from './palaceAccents';
import {
  cleanRing,
  minAreaRect,
  signedArea,
  triangleSignedArea,
  type Point2,
} from './polygon2d';
import { srgbFromHex, type BuildingStyle } from './style';
import { triangulatePolygon } from './triangulate';
import { boundaryNormalLocal, type RingInfo } from './walls';

/** Shared landmark id (src/shared/types.ts `LandmarkId`). */
const RED_CHURCH_LANDMARK = 'red-church';

// --- palette (sRGB, linearised by the facade shader) -----------------------
const BRICK = srgbFromHex('#8C3B2E'); // red-brick walls
const STONE = srgbFromHex('#D8CBB4'); // cream stone accents (plinth, cornices, window surrounds)
const SLATE = srgbFromHex('#3A3F45'); // dark slate roof
const GOLD = srgbFromHex('#D4AF37'); // gold crosses
const GLASS = srgbFromHex('#A9C4CE'); // rose-window glass

// --- module constants (metres) --------------------------------------------
/** Nave eave height: OSM nave parts are 22 m eave + 3 m roof (25 m top). */
const NAVE_EAVE = 22;
/** Gable roof rise above the nave eave (the reference roof is steep). */
const NAVE_ROOF_RISE = 9;
/** Base width used when no wall-parallel eave line can be inferred. */
const MIN_ROOF_HALF_WIDTH = 4;
/** Front facade tower: square brick shaft footprint (7.2 x 7.2 m). */
const FRONT_TOWER_HALF = 3.6;
/** Front facade tower centres sit this far either side of the facade centreline. */
const FRONT_TOWER_SPACING = 8;
/** The tower front faces stand this far proud of the nave front wall. */
const FRONT_TOWER_PROUD = 1.5;
/** Inward shift of the tower centres so their front faces are only `PROUD` out. */
const FRONT_TOWER_INSET = FRONT_TOWER_HALF - FRONT_TOWER_PROUD;
/** Front facade tower: brick shaft height (base of the stone cornice). */
const FRONT_TOWER_SHAFT_TOP = 36;
/** Front facade tower: top of the stone cornice (base of the spire). */
const FRONT_TOWER_CORNICE_TOP = 37;
/** Front facade tower: outward projection of the stone cornice. */
const FRONT_TOWER_CORNICE_OUTSET = 0.4;
/** Front facade tower: cream string courses on the brick shaft (heights, m). */
const FRONT_TOWER_STRING_COURSES: readonly number[] = [12, 24];
const FRONT_TOWER_STRING_COURSE_HEIGHT = 0.5;
const FRONT_TOWER_STRING_COURSE_OUTSET = 0.16;
/** Front facade tower: apex of the steep eight-sided slate spire. */
const FRONT_TOWER_TOP = 50;
/** Crossing bell tower: projecting stone cornice below/above its eave. */
const TOWER_CORNICE_DROP = 0.8;
const TOWER_CORNICE_RISE = 0.2;
const TOWER_CORNICE_OUTSET = 0.4;
/** Gold cross height above a tower top. */
const CROSS_HEIGHT = 2;
/** A building:part volume counts as a tall tower part at this OSM top height. */
const MIN_TOWER_TOP = 30;
/** Facade twin parts differ by at most this height... */
const TWIN_MAX_HEIGHT_DIFF = 1;
/** ...and stand at most this far apart. */
const TWIN_MAX_SPACING = 35;
/** Brick plinth band. */
const PLINTH_HEIGHT = 1.4;
const PLINTH_OUTSET = 0.18;
/** Cream cornice / string course just below the eave. */
const CORNICE_HEIGHT = 0.7;
const CORNICE_OUTSET = 0.3;
/** Rose window. */
const ROSE_RADIUS = 2.6;
const ROSE_SEGMENTS = 12;
const ROSE_CENTER_HEIGHT = 26;
const ROSE_RING_WIDTH = 0.5;
/** Buttress strips along the long nave walls. */
const BUTTRESS_HALF_WIDTH = 0.55;
const BUTTRESS_DEPTH = 0.55;
const BUTTRESS_HEIGHT = 15.5;
const BUTTRESS_MAX_COUNT = 10;

type Vec3 = [number, number, number];

/** True when the feature is the Red Church landmark. */
export function isRedChurchBuilding(building: BuildingFeature): boolean {
  return building?.landmark === RED_CHURCH_LANDMARK;
}

// --- generic emission helpers (same conventions as the other owners) -------

function world(x: number, y: number, height: number): Vec3 {
  return [x, height, -y];
}

function ringInfoOf(points: Point2[]): RingInfo {
  const area = signedArea(points);
  return { points, isHole: false, area, ccw: area > 0 };
}

function surface(
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

/** Emit one quad: explicit normal, or the geometric normal of its first corners. */
function emitQuad(
  sink: MeshSink,
  corners: readonly Vec3[],
  uv: readonly [number, number][],
  style: SurfaceStyle,
  normal?: Vec3,
): void {
  if (corners.length !== 4 || uv.length !== 4) return;
  let n = normal;
  if (!n) {
    const abx = corners[1][0] - corners[0][0];
    const aby = corners[1][1] - corners[0][1];
    const abz = corners[1][2] - corners[0][2];
    const acx = corners[2][0] - corners[0][0];
    const acy = corners[2][1] - corners[0][1];
    const acz = corners[2][2] - corners[0][2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    if (Math.hypot(nx, ny, nz) < 1e-9) return;
    n = normalize3(nx, ny, nz);
  }
  sink.addQuad(
    corners[0][0], corners[0][1], corners[0][2],
    corners[1][0], corners[1][1], corners[1][2],
    corners[2][0], corners[2][1], corners[2][2],
    corners[3][0], corners[3][1], corners[3][2],
    uv[0][0], uv[0][1], uv[1][0], uv[1][1],
    uv[2][0], uv[2][1], uv[3][0], uv[3][1],
    n[0], n[1], n[2], style,
  );
}

/** Emit one triangle with an explicit normal. */
function emitTriangle(
  sink: MeshSink,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  normal: Vec3,
  uv: readonly [number, number][],
  style: SurfaceStyle,
): void {
  sink.addTriangle(
    a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2],
    normal[0], normal[1], normal[2],
    uv[0][0], uv[0][1], uv[1][0], uv[1][1], uv[2][0], uv[2][1],
    style,
  );
}

/** Flat polygon deck at constant height (upward facing). */
function emitDeck(
  sink: MeshSink,
  points: readonly Point2[],
  height: number,
  style: SurfaceStyle,
): void {
  const triangulation = triangulatePolygon([points as Point2[]]);
  for (const triangle of triangulation.triangles) {
    const { a, b, c } = triangle;
    const signed = triangleSignedArea(a, b, c);
    if (Math.abs(signed) < 1e-6) continue;
    if (signed > 0) {
      emitTriangle(
        sink,
        world(a[0], a[1], height),
        world(b[0], b[1], height),
        world(c[0], c[1], height),
        [0, 1, 0],
        [[a[0], a[1]], [b[0], b[1]], [c[0], c[1]]],
        style,
      );
    } else {
      emitTriangle(
        sink,
        world(a[0], a[1], height),
        world(c[0], c[1], height),
        world(b[0], b[1], height),
        [0, 1, 0],
        [[a[0], a[1]], [c[0], c[1]], [b[0], b[1]]],
        style,
      );
    }
  }
}

/** Vertical wall band around a ring (aUV u accumulates along the ring). */
function emitRingWalls(
  sink: MeshSink,
  ring: RingInfo,
  yBottom: number,
  yTop: number,
  style: SurfaceStyle,
): void {
  const points = ring.points;
  const count = points.length;
  let u = 0;
  for (let i = 0; i < count; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % count];
    const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const u0 = u;
    const u1 = u + length;
    u = u1;
    if (length < 1e-3) continue;
    const [nlx, nly] = boundaryNormalLocal(ring, i);
    emitQuad(
      sink,
      [
        world(p0[0], p0[1], yBottom),
        world(p1[0], p1[1], yBottom),
        world(p1[0], p1[1], yTop),
        world(p0[0], p0[1], yTop),
      ],
      [[u0, yBottom], [u1, yBottom], [u1, yTop], [u0, yTop]],
      style,
      [nlx, 0, -nly],
    );
  }
}

/** A projecting band (plinth / cornice) around a ring: outer face + top ledge. */
function emitProjectingBand(
  sink: MeshSink,
  ring: RingInfo,
  yBottom: number,
  yTop: number,
  outset: number,
  outerStyle: SurfaceStyle,
  ledgeStyle: SurfaceStyle,
): void {
  const points = ring.points;
  const outer = offsetRing(ring, outset);
  const count = Math.min(points.length, outer.length);
  let u = 0;
  for (let i = 0; i < count; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % count];
    const o0 = outer[i];
    const o1 = outer[(i + 1) % count];
    const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const u0 = u;
    const u1 = u + length;
    u = u1;
    if (length < 1e-3) continue;
    const [nlx, nly] = boundaryNormalLocal(ring, i);
    emitQuad(
      sink,
      [
        world(o0[0], o0[1], yBottom),
        world(o1[0], o1[1], yBottom),
        world(o1[0], o1[1], yTop),
        world(o0[0], o0[1], yTop),
      ],
      [[u0, yBottom], [u1, yBottom], [u1, yTop], [u0, yTop]],
      outerStyle,
      [nlx, 0, -nly],
    );
    // Top ledge from the projecting face back to the wall line.
    emitQuad(
      sink,
      [
        world(p0[0], p0[1], yTop),
        world(p1[0], p1[1], yTop),
        world(o1[0], o1[1], yTop),
        world(o0[0], o0[1], yTop),
      ],
      [[u0, yTop], [u1, yTop], [u1, yTop], [u0, yTop]],
      ledgeStyle,
      [0, 1, 0],
    );
  }
}

/** Square ring (CCW) from a centre, unit axes and half size. */
function squareRing(centre: Point2, ux: number, uy: number, half: number): Point2[] {
  const vx = -uy;
  const vy = ux;
  return [
    [centre[0] + (ux + vx) * half, centre[1] + (uy + vy) * half],
    [centre[0] + (-ux + vx) * half, centre[1] + (-uy + vy) * half],
    [centre[0] + (-ux - vx) * half, centre[1] + (-uy - vy) * half],
    [centre[0] + (ux - vx) * half, centre[1] + (uy - vy) * half],
  ];
}

/** Square prism between two heights (tower shafts, cornices). */
function emitSquarePrism(
  sink: MeshSink,
  centre: Point2,
  ux: number,
  uy: number,
  half: number,
  yBottom: number,
  yTop: number,
  style: SurfaceStyle,
): void {
  const ring = ringInfoOf(squareRing(centre, ux, uy, half));
  emitRingWalls(sink, ring, yBottom, yTop, style);
}

/** Flat annulus (top ledge) between an inner and an outer square ring. */
function emitSquareAnnulus(
  sink: MeshSink,
  centre: Point2,
  ux: number,
  uy: number,
  innerHalf: number,
  outerHalf: number,
  height: number,
  style: SurfaceStyle,
): void {
  const inner = squareRing(centre, ux, uy, innerHalf);
  const outer = squareRing(centre, ux, uy, outerHalf);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    emitQuad(
      sink,
      [
        world(inner[i][0], inner[i][1], height),
        world(inner[j][0], inner[j][1], height),
        world(outer[j][0], outer[j][1], height),
        world(outer[i][0], outer[i][1], height),
      ],
      [[0, 0], [1, 0], [1, 1], [0, 1]],
      style,
      [0, 1, 0],
    );
  }
}

/** Upward-facing square cap (tower cornice / string-course top). */
function emitSquareDeck(
  sink: MeshSink,
  centre: Point2,
  ux: number,
  uy: number,
  half: number,
  height: number,
  style: SurfaceStyle,
): void {
  const ring = squareRing(centre, ux, uy, half);
  emitQuad(
    sink,
    [
      world(ring[0][0], ring[0][1], height),
      world(ring[3][0], ring[3][1], height),
      world(ring[2][0], ring[2][1], height),
      world(ring[1][0], ring[1][1], height),
    ],
    [[0, 0], [1, 0], [1, 1], [0, 1]],
    style,
    [0, 1, 0],
  );
}

/** Eight-sided spire from a base ring to an apex (steep neo-gothic tower roof). */
function emitOctagonSpire(
  sink: MeshSink,
  centre: Point2,
  ux: number,
  uy: number,
  radius: number,
  yBase: number,
  apexY: number,
  style: SurfaceStyle,
): void {
  const vx = -uy;
  const vy = ux;
  const cx = centre[0];
  const cz = -centre[1];
  const base: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const localX = cx + (ux * cos + vx * sin) * radius;
    const localY = centre[1] + (uy * cos + vy * sin) * radius;
    base.push([localX, yBase, -localY]);
  }
  const apex: Vec3 = [cx, apexY, cz];
  for (let i = 0; i < 8; i++) {
    const a = base[i];
    const b = base[(i + 1) % 8];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const aax = apex[0] - a[0];
    const aay = apex[1] - a[1];
    const aaz = apex[2] - a[2];
    let normal = normalize3(
      aby * aaz - abz * aay,
      abz * aax - abx * aaz,
      abx * aay - aby * aax,
    );
    const centroidX = (a[0] + b[0] + apex[0]) / 3 - cx;
    const centroidZ = (a[2] + b[2] + apex[2]) / 3 - cz;
    if (centroidX * normal[0] + centroidZ * normal[2] < 0) {
      normal = [-normal[0], -normal[1], -normal[2]];
    }
    emitTriangle(
      sink,
      a,
      b,
      apex,
      normal,
      [[0, 0], [1, 0], [0.5, 1]],
      style,
    );
  }
}

/** Small gold cross above a tower: two crossed vertical planes. */
function emitGoldCross(
  sink: MeshSink,
  centre: Point2,
  ux: number,
  uy: number,
  baseY: number,
  height: number,
  style: SurfaceStyle,
): void {
  const vx = -uy;
  const vy = ux;
  const barHalf = 0.09;
  const crossHalf = 0.62;
  const barY = baseY + height * 0.62;
  const position = (tangentX: number, tangentY: number, offset: number, y: number): Vec3 => [
    centre[0] + (tangentX * offset),
    y,
    -(centre[1] + (tangentY * offset)),
  ];
  // One full cross in a vertical plane: tangent + normal (normal of the plane).
  const plane = (tangentX: number, tangentY: number, normal: Vec3): void => {
    // Vertical post.
    emitQuad(
      sink,
      [
        position(tangentX, tangentY, -barHalf, baseY),
        position(tangentX, tangentY, barHalf, baseY),
        position(tangentX, tangentY, barHalf, baseY + height),
        position(tangentX, tangentY, -barHalf, baseY + height),
      ],
      [[0, 0], [1, 0], [1, 1], [0, 1]],
      style,
      normal,
    );
    // Horizontal arms (left and right of the post, so they never overlap it).
    for (const sign of [-1, 1]) {
      const inner = sign * barHalf;
      const outer = sign * crossHalf;
      emitQuad(
        sink,
        [
          position(tangentX, tangentY, inner, barY - barHalf),
          position(tangentX, tangentY, outer, barY - barHalf),
          position(tangentX, tangentY, outer, barY + barHalf),
          position(tangentX, tangentY, inner, barY + barHalf),
        ],
        [[0, 0], [1, 0], [1, 1], [0, 1]],
        style,
        normal,
      );
    }
  };
  plane(ux, uy, [vx, 0, -vy]); // cross plane containing the tower's u axis
  plane(vx, vy, [ux, 0, -uy]); // cross plane containing the tower's v axis
}

/** Rose window: glass 12-gon disc + cream trim ring + four stone spokes. */
function emitRoseWindow(
  sink: MeshSink,
  centre: Point2,
  normalLocal: Point2,
  height: number,
  style: BuildingStyle,
): void {
  const cx = centre[0];
  const cz = -centre[1];
  const nx = normalLocal[0];
  const nz = -normalLocal[1];
  const tangent: [number, number, number] = [-nz, 0, nx];
  const glassStyle = surface(style, FACE_KIND.glass, GLASS);
  const trimStyle = surface(style, FACE_KIND.trim, STONE);
  const up: Vec3 = [0, 1, 0];
  const discPoint = (angle: number, radius: number, proud: number): Vec3 => [
    cx + nx * proud + tangent[0] * radius * Math.cos(angle),
    height + radius * Math.sin(angle),
    cz + nz * proud + tangent[2] * radius * Math.cos(angle),
  ];
  const normal: Vec3 = [nx, 0, nz];
  // Glass disc (12-gon fan, slightly recessed behind the stone ring).
  const hub = discPoint(0, 0, 0.22);
  for (let i = 0; i < ROSE_SEGMENTS; i++) {
    const a0 = (i / ROSE_SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / ROSE_SEGMENTS) * Math.PI * 2;
    const p0 = discPoint(a0, ROSE_RADIUS, 0.22);
    const p1 = discPoint(a1, ROSE_RADIUS, 0.22);
    emitTriangle(
      sink,
      hub,
      p0,
      p1,
      normal,
      [[0, 0], [ROSE_RADIUS * Math.cos(a0), ROSE_RADIUS * Math.sin(a0)],
        [ROSE_RADIUS * Math.cos(a1), ROSE_RADIUS * Math.sin(a1)]],
      glassStyle,
    );
  }
  // Cream trim ring around the glass.
  for (let i = 0; i < ROSE_SEGMENTS; i++) {
    const a0 = (i / ROSE_SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / ROSE_SEGMENTS) * Math.PI * 2;
    const inner0 = discPoint(a0, ROSE_RADIUS - 0.02, 0.3);
    const inner1 = discPoint(a1, ROSE_RADIUS - 0.02, 0.3);
    const outer0 = discPoint(a0, ROSE_RADIUS + ROSE_RING_WIDTH, 0.3);
    const outer1 = discPoint(a1, ROSE_RADIUS + ROSE_RING_WIDTH, 0.3);
    emitQuad(
      sink,
      [inner0, inner1, outer1, outer0],
      [[0, 0], [1, 0], [1, 1], [0, 1]],
      trimStyle,
      normal,
    );
  }
  // Four stone tracery spokes in front of the glass.
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 8;
    const halfWidth = 0.1;
    const halfAngle = Math.atan2(halfWidth, ROSE_RADIUS * 0.5);
    const p0 = discPoint(angle - halfAngle, ROSE_RADIUS * 0.95, 0.34);
    const p1 = discPoint(angle + halfAngle, ROSE_RADIUS * 0.95, 0.34);
    const p2 = discPoint(angle + halfAngle, 0.35, 0.34);
    const p3 = discPoint(angle - halfAngle, 0.35, 0.34);
    emitQuad(sink, [p0, p1, p2, p3], [[0, 0], [1, 0], [1, 1], [0, 1]], trimStyle, normal);
  }
}

// --- tower selection -------------------------------------------------------

interface TowerPlan {
  centre: Point2;
  ux: number;
  uy: number;
  halfWidth: number;
  halfLength: number;
  /** OSM top of the part (eave + roof rise). */
  top: number;
  /** OSM eave (normalised volume height). */
  eave: number;
}

function towerPlans(building: BuildingFeature): TowerPlan[] {
  const volumes = Array.isArray(building.volumes) ? building.volumes : [];
  const plans: TowerPlan[] = [];
  for (const volume of volumes) {
    if (!volume || volume.isPart !== true) continue;
    const top = volume.height + (Number.isFinite(volume.roofHeight) ? volume.roofHeight : 0);
    if (!(top >= MIN_TOWER_TOP) || !Number.isFinite(top)) continue;
    const points = cleanRing(volume.footprint?.[0]);
    if (points.length < 4) continue;
    const rect = minAreaRect(points);
    if (!rect) continue;
    plans.push({
      centre: [rect.cx, rect.cy],
      ux: rect.ux,
      uy: rect.uy,
      halfWidth: rect.halfWidth,
      halfLength: rect.halfLength,
      top,
      eave: Number.isFinite(volume.height) ? volume.height : top,
    });
  }
  plans.sort((a, b) => {
    if (a.top !== b.top) return b.top - a.top;
    if (a.centre[0] !== b.centre[0]) return a.centre[0] - b.centre[0];
    return a.centre[1] - b.centre[1];
  });
  return plans;
}

interface TowerSelection {
  front: TowerPlan[];
  main: TowerPlan[];
}

/**
 * Split the tall parts into the symmetric front facade pair (two towers of
 * near-identical height standing close together) and the remaining crossing
 * tower(s). OSM maps the Red Church with THREE tall parts (two 36 m facade
 * twins + one 50 m crossing tower); using the naive "two tallest" would make
 * the symmetric facade asymmetric, so the twin pair wins when it exists.
 */
function selectTowers(plans: readonly TowerPlan[]): TowerSelection {
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      const a = plans[i];
      const b = plans[j];
      if (Math.abs(a.top - b.top) > TWIN_MAX_HEIGHT_DIFF) continue;
      const spacing = Math.hypot(a.centre[0] - b.centre[0], a.centre[1] - b.centre[1]);
      if (spacing > TWIN_MAX_SPACING) continue;
      const front = [a, b];
      const main = plans.filter((_, index) => index !== i && index !== j);
      return { front, main };
    }
  }
  return { front: plans.slice(0, 2), main: plans.slice(2) };
}

/**
 * Front facade centre point: where the nave ridge line (dv = 0) leaves the plan
 * on the front side. That is the apex of the front gable, so the twin towers can
 * be placed symmetrically about it and the rose window sits centred under it.
 * Falls back to the frontmost boundary vertex when the ridge does not reach the
 * front wall.
 */
function findFrontFacadeCenter(
  points: readonly Point2[],
  ridge: (point: Point2) => number,
  centre: Point2,
  frontDir: Point2,
): { point: Point2; normal: Point2; crossed: boolean } {
  const ring = ringInfoOf(points as Point2[]);
  const n = points.length;
  let best: { point: Point2; normal: Point2; projection: number } | null = null;
  let fallbackPoint: Point2 = points[0];
  let fallbackNormal: Point2 = frontDir;
  let fallbackProjection = -Infinity;
  for (let i = 0; i < n; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % n];
    const normal = boundaryNormalLocal(ring, i);
    const projection =
      (p0[0] - centre[0]) * frontDir[0] + (p0[1] - centre[1]) * frontDir[1];
    if (projection > fallbackProjection) {
      fallbackProjection = projection;
      fallbackPoint = p0;
      fallbackNormal = normal;
    }
    const d0 = ridge(p0);
    const d1 = ridge(p1);
    if ((d0 < -1e-6 && d1 > 1e-6) || (d0 > 1e-6 && d1 < -1e-6)) {
      const t = d0 / (d0 - d1);
      const point: Point2 = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
      const crossingProjection =
        (point[0] - centre[0]) * frontDir[0] + (point[1] - centre[1]) * frontDir[1];
      if (!best || crossingProjection > best.projection) {
        best = { point, normal, projection: crossingProjection };
      }
    }
  }
  if (best) return { point: best.point, normal: best.normal, crossed: true };
  return { point: fallbackPoint, normal: fallbackNormal, crossed: false };
}

/**
 * One substantial front-facade tower (7.2 x 7.2 m): brick shaft to 36 m with
 * cream string courses, projecting stone cornice to 37 m, steep eight-sided
 * slate spire to 50 m and a gold cross reaching ~52 m.
 */
function emitFrontFacadeTower(
  sink: MeshSink,
  towerCentre: Point2,
  ux: number,
  uy: number,
  brickStyle: SurfaceStyle,
  stoneStyle: SurfaceStyle,
  slateStyle: SurfaceStyle,
  goldStyle: SurfaceStyle,
): void {
  const half = FRONT_TOWER_HALF;
  emitSquarePrism(sink, towerCentre, ux, uy, half, 0, FRONT_TOWER_SHAFT_TOP, brickStyle);
  for (const course of FRONT_TOWER_STRING_COURSES) {
    const y0 = course - FRONT_TOWER_STRING_COURSE_HEIGHT / 2;
    const y1 = course + FRONT_TOWER_STRING_COURSE_HEIGHT / 2;
    const outerHalf = half + FRONT_TOWER_STRING_COURSE_OUTSET;
    emitSquarePrism(sink, towerCentre, ux, uy, outerHalf, y0, y1, stoneStyle);
    emitSquareDeck(sink, towerCentre, ux, uy, outerHalf, y1, stoneStyle);
  }
  const corniceHalf = half + FRONT_TOWER_CORNICE_OUTSET;
  emitSquarePrism(
    sink, towerCentre, ux, uy, corniceHalf, FRONT_TOWER_SHAFT_TOP, FRONT_TOWER_CORNICE_TOP, stoneStyle,
  );
  emitSquareDeck(
    sink, towerCentre, ux, uy, corniceHalf, FRONT_TOWER_CORNICE_TOP, stoneStyle,
  );
  emitOctagonSpire(
    sink,
    towerCentre,
    ux,
    uy,
    half + 0.2,
    FRONT_TOWER_CORNICE_TOP,
    FRONT_TOWER_TOP,
    slateStyle,
  );
  emitGoldCross(sink, towerCentre, ux, uy, FRONT_TOWER_TOP, CROSS_HEIGHT, goldStyle);
}

// --- nave construction -----------------------------------------------------

interface RoofVertex {
  point: Point2;
  /** Signed distance from the ridge line (metres). */
  dv: number;
}

interface RoofSegment {
  a: Point2;
  b: Point2;
  dvA: number;
  dvB: number;
  normal: Point2;
}

interface RoofSplit {
  /** Boundary vertices with crossings inserted (ridge vertices have dv = 0). */
  vertices: RoofVertex[];
  /** Boundary segments split at ridge crossings, carrying the wall normal. */
  segments: RoofSegment[];
  /** Indices into `vertices` that lie on the ridge line. */
  crossings: number[];
}

/** Split the plan boundary at the ridge line (dv = 0). */
function splitAtRidge(points: readonly Point2[], ridge: (p: Point2) => number): RoofSplit {
  const ring: RingInfo = ringInfoOf(points as Point2[]);
  const n = points.length;
  const vertices: RoofVertex[] = [];
  const segments: RoofSegment[] = [];
  const crossings: number[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % n];
    const d0 = ridge(p0);
    const d1 = ridge(p1);
    const normal = boundaryNormalLocal(ring, i);
    const isOnRidge = (value: number): boolean => Math.abs(value) < 1e-6;
    if (isOnRidge(d0)) {
      crossings.push(vertices.length);
      vertices.push({ point: p0, dv: 0 });
    } else {
      vertices.push({ point: p0, dv: d0 });
    }
    if ((d0 < -1e-6 && d1 > 1e-6) || (d0 > 1e-6 && d1 < -1e-6)) {
      const t = d0 / (d0 - d1);
      const crossing: Point2 = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
      crossings.push(vertices.length);
      vertices.push({ point: crossing, dv: 0 });
      segments.push({ a: p0, b: crossing, dvA: d0, dvB: 0, normal });
      segments.push({ a: crossing, b: p1, dvA: 0, dvB: d1, normal });
    } else {
      segments.push({ a: p0, b: p1, dvA: d0, dvB: d1, normal });
    }
  }
  return { vertices, segments, crossings };
}

/**
 * Gable roof over the (irregular) nave plan, clipped to the real boundary:
 * two slope planes meeting along the min-area-rect long axis, vertical gable
 * walls filling the gap between the eave and the roof at the plan boundary.
 * The eave half width is estimated from the wall-parallel boundary segments so
 * that a cross-shaped plan gets a roof over the nave (not over the whole
 * min-area rectangle).
 */
function buildGableRoof(
  sink: MeshSink,
  points: readonly Point2[],
  centre: Point2,
  ux: number,
  uy: number,
  mrrHalfWidth: number,
  eave: number,
  rise: number,
  roofStyle: SurfaceStyle,
  gableStyle: SurfaceStyle,
  warn: (message: string) => void,
): void {
  const vx = -uy;
  const vy = ux;
  const ridge = (p: Point2): number => (p[0] - centre[0]) * vx + (p[1] - centre[1]) * vy;
  const split = splitAtRidge(points, ridge);

  // Estimate the roof's horizontal half width from the long (wall-parallel)
  // boundary segments: a church plan is wider at the transept than at the
  // nave, and the gable roof covers the nave.
  const halfWidthCandidates: number[] = [];
  for (const segment of split.segments) {
    const alignment = Math.abs(segment.normal[0] * vx + segment.normal[1] * vy);
    if (alignment < 0.7) continue;
    const mid = Math.abs((segment.dvA + segment.dvB) / 2);
    if (mid > 0.5) halfWidthCandidates.push(mid);
  }
  let halfWidth = mrrHalfWidth;
  if (halfWidthCandidates.length) {
    halfWidthCandidates.sort((a, b) => a - b);
    const index = Math.min(
      halfWidthCandidates.length - 1,
      Math.floor(halfWidthCandidates.length * 0.25),
    );
    halfWidth = halfWidthCandidates[index];
  }
  halfWidth = Math.max(MIN_ROOF_HALF_WIDTH, Math.min(halfWidth, mrrHalfWidth));
  if (!(halfWidth > 0)) {
    warn('red church: could not infer the nave roof width; roof skipped');
    return;
  }
  const roofHeightAt = (dv: number): number => {
    const t = Math.min(1, Math.abs(dv) / halfWidth);
    return eave + rise * (1 - t);
  };

  // --- roof planes ---------------------------------------------------------
  if (split.crossings.length < 2) {
    // The ridge line does not cross the plan (degenerate footprint): fall back
    // to a flat deck so the massing stays watertight rather than open-topped.
    warn('red church: ridge line does not cross the plan; flat roof deck emitted instead');
    emitDeck(sink, points, eave, roofStyle);
  } else {
    for (let k = 0; k < split.crossings.length; k++) {
      const start = split.crossings[k];
      const end = split.crossings[(k + 1) % split.crossings.length];
      const subpath: Point2[] = [];
      let index = start;
      let guard = 0;
      while (guard++ <= split.vertices.length) {
        subpath.push(split.vertices[index].point);
        if (index === end) break;
        index = (index + 1) % split.vertices.length;
      }
      if (subpath.length < 3) continue;
      const triangulation = triangulatePolygon([subpath as Point2[]]);
      for (const triangle of triangulation.triangles) {
        const { a, b, c } = triangle;
        const ya = roofHeightAt(ridge(a));
        const yb = roofHeightAt(ridge(b));
        const yc = roofHeightAt(ridge(c));
        const wa = world(a[0], a[1], ya);
        const wb = world(b[0], b[1], yb);
        const wc = world(c[0], c[1], yc);
        const abx = wb[0] - wa[0];
        const aby = wb[1] - wa[1];
        const abz = wb[2] - wa[2];
        const acx = wc[0] - wa[0];
        const acy = wc[1] - wa[1];
        const acz = wc[2] - wa[2];
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        if (Math.hypot(nx, ny, nz) < 1e-7) continue;
        let normal = normalize3(nx, ny, nz);
        if (normal[1] < 0) normal = [-normal[0], -normal[1], -normal[2]];
        const uv: [number, number][] = [
          [a[0], a[1]],
          [b[0], b[1]],
          [c[0], c[1]],
        ];
        if (normal[1] >= 0) {
          emitTriangle(sink, wa, wb, wc, normal, uv, roofStyle);
        } else {
          emitTriangle(sink, wa, wc, wb, normal, [uv[0], uv[2], uv[1]], roofStyle);
        }
      }
    }
  }

  // --- gable walls / eave closure -----------------------------------------
  // Where the roof meets the plan boundary above the eave (the gable ends and
  // any boundary inset from the roof's eave line) a vertical brick wall fills
  // the gap, so the roof and walls are always watertight.
  let u = 0;
  for (const segment of split.segments) {
    const length = Math.hypot(segment.b[0] - segment.a[0], segment.b[1] - segment.a[1]);
    const u0 = u;
    const u1 = u + length;
    u = u1;
    if (length < 1e-3) continue;
    const yA = roofHeightAt(segment.dvA);
    const yB = roofHeightAt(segment.dvB);
    if (Math.max(yA, yB) <= eave + 1e-3) continue;
    emitQuad(
      sink,
      [
        world(segment.a[0], segment.a[1], eave),
        world(segment.b[0], segment.b[1], eave),
        world(segment.b[0], segment.b[1], yB),
        world(segment.a[0], segment.a[1], yA),
      ],
      [[u0, 0], [u1, 0], [u1, yB - eave], [u0, yA - eave]],
      gableStyle,
      [segment.normal[0], 0, -segment.normal[1]],
    );
  }
}

/** Cheap brick buttress strips along the long nave walls. */
function buildButtresses(
  sink: MeshSink,
  points: readonly Point2[],
  uy: number,
  ux: number,
  style: SurfaceStyle,
): void {
  const ring = ringInfoOf(points as Point2[]);
  const vx = -uy;
  const vy = ux;
  const candidates: { mid: Point2; normal: Point2; tangent: Point2 }[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 6) continue;
    const normal = boundaryNormalLocal(ring, i);
    const alignment = Math.abs(normal[0] * vx + normal[1] * vy);
    if (alignment < 0.8) continue;
    candidates.push({
      mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      normal,
      tangent: [(b[0] - a[0]) / length, (b[1] - a[1]) / length],
    });
  }
  if (!candidates.length) return;
  const stride = Math.max(1, Math.ceil(candidates.length / BUTTRESS_MAX_COUNT));
  for (let i = 0; i < candidates.length; i += stride) {
    const { mid, normal, tangent } = candidates[i];
    const half = BUTTRESS_HALF_WIDTH;
    const inner = -0.1;
    const outer = BUTTRESS_DEPTH;
    const at = (sign: number, depth: number, height: number): Vec3 =>
      world(
        mid[0] + tangent[0] * half * sign + normal[0] * depth,
        mid[1] + tangent[1] * half * sign + normal[1] * depth,
        height,
      );
    const b0 = at(-1, inner, 0);
    const b1 = at(1, inner, 0);
    const f0 = at(-1, outer, 0);
    const f1 = at(1, outer, 0);
    const normalWorld: Vec3 = [normal[0], 0, -normal[1]];
    // Front face (proud of the wall).
    emitQuad(
      sink,
      [
        f0,
        f1,
        [f1[0], BUTTRESS_HEIGHT, f1[2]],
        [f0[0], BUTTRESS_HEIGHT, f0[2]],
      ],
      [[0, 0], [1, 0], [1, BUTTRESS_HEIGHT], [0, BUTTRESS_HEIGHT]],
      style,
      normalWorld,
    );
    // Two flanks.
    for (const [innerPoint, outerPoint, sign] of [
      [b0, f0, -1],
      [f1, b1, 1],
    ] as const) {
      const sideNormal = normalize3(tangent[0] * sign, 0, -tangent[1] * sign);
      emitQuad(
        sink,
        [
          innerPoint,
          outerPoint,
          [outerPoint[0], BUTTRESS_HEIGHT, outerPoint[2]],
          [innerPoint[0], BUTTRESS_HEIGHT, innerPoint[2]],
        ],
        [[0, 0], [1, 0], [1, BUTTRESS_HEIGHT], [0, BUTTRESS_HEIGHT]],
        style,
        sideNormal,
      );
    }
    // Top cap.
    emitQuad(
      sink,
      [
        [f0[0], BUTTRESS_HEIGHT, f0[2]],
        [f1[0], BUTTRESS_HEIGHT, f1[2]],
        [b1[0], BUTTRESS_HEIGHT, b1[2]],
        [b0[0], BUTTRESS_HEIGHT, b0[2]],
      ],
      [[0, 0], [1, 0], [1, 1], [0, 1]],
      style,
      [0, 1, 0],
    );
  }
}

/** Largest usable volume footprint, used only when `outline` is absent. */
function fallbackOutline(building: BuildingFeature): Point2[] | null {
  const volumes = Array.isArray(building.volumes) ? building.volumes : [];
  let best: Point2[] | null = null;
  let bestArea = 0;
  for (const volume of volumes) {
    const points = cleanRing(volume?.footprint?.[0]);
    if (points.length < 3) continue;
    const area = Math.abs(signedArea(points));
    if (area > bestArea) {
      bestArea = area;
      best = points;
    }
  }
  return best;
}

/**
 * Append the whole Red Church massing (nave, gable roof, plinth, cornices,
 * buttresses, the twin front-facade towers with their spires and gold crosses,
 * the centred rose window and the crossing bell tower) to the sink.
 *
 * Never throws: data problems are reported through `onWarning`. Falls back to
 * the largest volume footprint when the curated `outline` is missing, and to a
 * plan-derived front facade (the ridge-axis end) when no tall building:part
 * cluster is mapped.
 */
export function addRedChurch(
  sink: MeshSink,
  building: BuildingFeature,
  style: BuildingStyle,
  onWarning?: (message: string) => void,
): void {
  const warn = onWarning ?? (() => {});
  try {
    if (!isRedChurchBuilding(building)) return;

    let planPoints = cleanRing(building.outline?.[0]);
    if (planPoints.length < 3) {
      const fallback = fallbackOutline(building);
      if (!fallback) {
        warn('red church: no usable outline or volume footprint; landmark skipped');
        return;
      }
      warn('red church: missing outline; using the largest volume footprint');
      planPoints = fallback;
    }
    const planRing = ringInfoOf(planPoints);
    if (Math.abs(planRing.area) < 40) {
      warn(`red church: footprint area ${Math.abs(planRing.area).toFixed(1)} m² is too small`);
      return;
    }
    const rect = minAreaRect(planPoints);
    if (!rect) {
      warn('red church: could not derive the church axes (degenerate outline)');
      return;
    }
    const centre: Point2 = [rect.cx, rect.cy];
    const ux = rect.ux;
    const uy = rect.uy;
    const vx = -uy;
    const vy = ux;

    // --- tall OSM parts: front facade cluster + crossing bell tower --------
    // The `building:part` cluster marks which nave end carries the front
    // entrance. The two tiny OSM spire-tip parts are only a location hint: the
    // actual facade towers are rebuilt in plan space below (they are much
    // larger than the mapped spires), and only the crossing tower keeps its
    // OSM part footprint.
    const plans = towerPlans(building);
    const selection = selectTowers(plans);
    let clusterX = centre[0];
    let clusterY = centre[1];
    if (plans.length) {
      clusterX = 0;
      clusterY = 0;
      for (const plan of plans) {
        clusterX += plan.centre[0];
        clusterY += plan.centre[1];
      }
      clusterX /= plans.length;
      clusterY /= plans.length;
    }
    const frontSign =
      (clusterX - centre[0]) * ux + (clusterY - centre[1]) * uy >= 0 ? 1 : -1;
    const frontDir: Point2 = [ux * frontSign, uy * frontSign];
    // Crossing bell tower: the tall parts that are not the symmetric facade
    // pair. A single tall part is the crossing tower itself.
    const crossingTowers = plans.length === 1 ? plans : selection.main;
    if (plans.length < 2) {
      warn('red church: no twin tall building:part volumes; front facade towers placed from the plan');
    }

    // --- nave: brick walls, plinth, cornice --------------------------------
    // The curated church emits its own openings; the generic facade grid must
    // stay off its brick walls.
    const brickWall = surface(style, FACE_KIND.wall, BRICK, STYLE_FLAG.blank);
    const brickTrim = surface(style, FACE_KIND.trim, BRICK, STYLE_FLAG.blank);
    const stoneTrim = surface(style, FACE_KIND.trim, STONE);
    emitRingWalls(sink, planRing, 0, NAVE_EAVE, brickWall);
    emitProjectingBand(
      sink, planRing, 0, PLINTH_HEIGHT, PLINTH_OUTSET, stoneTrim, stoneTrim,
    );
    emitProjectingBand(
      sink,
      planRing,
      NAVE_EAVE - CORNICE_HEIGHT,
      NAVE_EAVE,
      CORNICE_OUTSET,
      stoneTrim,
      stoneTrim,
    );

    // --- gable roof --------------------------------------------------------
    const slateRoof = surface(style, FACE_KIND.roof, SLATE, 0, ROOF_SHAPE_ID.gabled);
    buildGableRoof(
      sink,
      planPoints,
      centre,
      ux,
      uy,
      rect.halfWidth,
      NAVE_EAVE,
      NAVE_ROOF_RISE,
      slateRoof,
      brickWall,
      warn,
    );

    // --- buttress strips on the long nave walls ----------------------------
    buildButtresses(sink, planPoints, ux, uy, brickTrim);

    // --- front facade: twin towers flanking the central rose window --------
    // The front facade centreline is the gable apex (where the nave ridge
    // leaves the plan on the front side), so the new towers are symmetric about
    // it and the rose window sits centred in the gable between them. The
    // facade plane is taken from the actual front wall normal at that point.
    const ridge = (point: Point2): number =>
      (point[0] - centre[0]) * vx + (point[1] - centre[1]) * vy;
    const facade = findFrontFacadeCenter(planPoints, ridge, centre, frontDir);
    if (!facade.crossed) {
      warn('red church: ridge line does not reach the front wall; facade placed at the frontmost wall point');
    }
    const facadeAlignment =
      facade.normal[0] * frontDir[0] + facade.normal[1] * frontDir[1];
    const facadeDir: Point2 = facadeAlignment >= 0.2 ? facade.normal : frontDir;
    const facadeTangent: Point2 = [-facadeDir[1], facadeDir[0]];
    const facadeCentre = facade.point;
    const goldTrim = surface(style, FACE_KIND.trim, GOLD);
    for (const sign of [-1, 1] as const) {
      const towerCentre: Point2 = [
        facadeCentre[0] +
          facadeTangent[0] * FRONT_TOWER_SPACING * sign -
          facadeDir[0] * FRONT_TOWER_INSET,
        facadeCentre[1] +
          facadeTangent[1] * FRONT_TOWER_SPACING * sign -
          facadeDir[1] * FRONT_TOWER_INSET,
      ];
      emitFrontFacadeTower(
        sink,
        towerCentre,
        facadeTangent[0],
        facadeTangent[1],
        brickWall,
        stoneTrim,
        slateRoof,
        goldTrim,
      );
    }
    // Rose window: centred in the front gable, 0.3 m proud of the wall.
    emitRoseWindow(sink, facadeCentre, facadeDir, ROSE_CENTER_HEIGHT, style);

    // --- crossing bell tower (the tallest OSM part, kept) -------------------
    for (const tower of crossingTowers) {
      const shaftHalf = Math.max(2.5, Math.min(tower.halfWidth, tower.halfLength, 8));
      const eave = Math.max(8, Math.min(tower.eave, tower.top - 1.5));
      emitSquarePrism(sink, tower.centre, ux, uy, shaftHalf, 0, eave, brickWall);
      const corniceBottom = eave - TOWER_CORNICE_DROP;
      const corniceTop = eave + TOWER_CORNICE_RISE;
      const outerHalf = shaftHalf + TOWER_CORNICE_OUTSET;
      emitSquarePrism(
        sink, tower.centre, ux, uy, outerHalf, corniceBottom, corniceTop, stoneTrim,
      );
      emitSquareDeck(sink, tower.centre, ux, uy, outerHalf, corniceTop, stoneTrim);
      emitOctagonSpire(
        sink,
        tower.centre,
        ux,
        uy,
        shaftHalf * 1.02,
        corniceTop,
        tower.top,
        slateRoof,
      );
      emitGoldCross(
        sink,
        tower.centre,
        ux,
        uy,
        tower.top,
        CROSS_HEIGHT,
        surface(style, FACE_KIND.trim, GOLD),
      );
    }
  } catch (error) {
    warn(`red church failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
