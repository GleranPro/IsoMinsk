/**
 * Ferris-wheel attraction geometry (Minsk: Gorky Park + Chelyuskintsev Park).
 *
 * OSM maps the wheels as `attraction=big_wheel` nodes with only a `height`
 * tag; the offline pipeline turns them into `AttractionFeature`s with measured
 * proportions (rim radius, axle height, cabins, wheel-plane bearing). This
 * module builds a recognisable, stylised low-poly wheel per attraction:
 *
 *  - two white A-frames (at ±3.4 m along the axle) on a concrete foundation
 *    pad, with a boarding deck and steps under the lowest cabin;
 *  - a metal axle + hub drum, two white tubular rims per side (outer at
 *    `radius`, inner at `radius - 1.4`), a middle ring at 0.62·radius, white
 *    spokes and red bracing rods;
 *  - `cabins` upright drum-box cabins hanging from the outer rim (they never
 *    rotate with the wheel), red closed cabins with cream roofs, every
 *    `openCabins`-th cabin yellow/open;
 *  - a red oval "МІНСК" sign plate (yellow letters hinted by a smaller yellow
 *    oval, no text textures) on both sides of the hub;
 *  - the wheel plane yawed by `rotation`, top of the rim at
 *    `hubHeight + radius + tube`, i.e. ≈ the feature's `height`.
 *
 * Budget: < 1800 triangles per wheel (Gorky ≈ 1700, Chelyuskintsev ≈ 1400).
 * Geometry is deterministic, vertex-coloured (linear RGB via GeometrySink,
 * exactly like treeMeshes.ts) and merged by `environmentMeshes.ts`; the
 * renderer draws it with the tree/environment material.
 *
 * Colours are taken from the real wheel (white tubular frame, red bracing,
 * red drum cabins, cream roofs, yellow open cabins, metal hub, dark base).
 */

import * as THREE from 'three';
import type { AttractionFeature } from '../../shared/types';
import { shadeHex } from '../../engine/materials/palette';
import { GeometrySink, type Vec3 } from './meshBuilder';

/** Hard triangle budget for one wheel. */
export const FERRIS_WHEEL_TRIANGLE_BUDGET = 1800;
/** Body (4 side quads) + roof quad = 10 triangles per cabin. */
export const FERRIS_WHEEL_CABIN_TRIANGLES = 10;

/** Colours from the real wheel (references: previous Minsk landmarks project). */
export const FERRIS_WHEEL_COLORS = {
  frame: '#ECEAE2', // white tubular frame
  frameShade: '#D5D3CC', // shaded frame members
  red: '#C42C3A', // bracing / closed cabin body
  cabinRed: '#B61C24', // closed cabin drum (slightly deeper red)
  yellow: '#ECC42C', // open cabins
  cream: '#EEE2BE', // cabin roofs
  metal: '#808286', // hub drum / axle
  hub: '#D2D4D6', // hub caps
  concrete: '#8C887E', // foundation pad
  deck: '#605C58', // boarding deck
  dark: '#3A3C40', // base / steps / bearings shadow
} as const;

/** Closed-cabin body shades (index 0 faces +U, then -U, +A, -A). */
export const CABIN_RED_SHADES: readonly string[] = [
  FERRIS_WHEEL_COLORS.cabinRed,
  shadeHex(FERRIS_WHEEL_COLORS.cabinRed, -0.2),
  shadeHex(FERRIS_WHEEL_COLORS.cabinRed, -0.1),
  shadeHex(FERRIS_WHEEL_COLORS.cabinRed, 0.08),
];
/** Open-cabin body shades (same face order as CABIN_RED_SHADES). */
export const CABIN_YELLOW_SHADES: readonly string[] = [
  FERRIS_WHEEL_COLORS.yellow,
  shadeHex(FERRIS_WHEEL_COLORS.yellow, -0.22),
  shadeHex(FERRIS_WHEEL_COLORS.yellow, -0.12),
  shadeHex(FERRIS_WHEEL_COLORS.yellow, 0.06),
];
/** Roof shades: cream for closed cabins, warm canopy for open ones. */
export const CABIN_ROOF_CREAM = FERRIS_WHEEL_COLORS.cream;
export const CABIN_ROOF_OPEN = shadeHex(FERRIS_WHEEL_COLORS.yellow, 0.14);
/** Hint of the yellow «МІНСК» lettering; distinct from the base cabin yellow. */
const SIGN_LETTER_COLOR = shadeHex(FERRIS_WHEEL_COLORS.yellow, 0.1);

// --- measured proportions (from the reference model) -----------------------
const REFERENCE_RADIUS_M = 25;
const RIM_TUBE_RADIUS_M = 0.24;
const RIM_DEPTH_M = 1.4; // inner rim is 1.4 m inside the outer rim
const MIDDLE_RING_RATIO = 0.62;
const HUB_RADIUS_M = 2.0;
const HUB_HALF_WIDTH_M = 1.3;
const FRAME_AXLE_OFFSET_M = 3.4;
const AXLE_RADIUS_M = 0.28;
const CABIN_WIDTH_M = 2.2;
const CABIN_DEPTH_M = 1.9;
const CABIN_HEIGHT_M = 1.6;
const CABIN_HANG_GAP_M = 0.12;
const SIGN_HALF_WIDTH_M = 2.6;
const SIGN_HALF_HEIGHT_M = 1.1;
const SIGN_THICKNESS_M = 0.26;
const SIGN_CENTRE_LIFT_M = 0.3;
const BASE_PAD_TOP_M = 0.35;
const MIN_SEGMENTS = 24;
const MAX_SEGMENTS = 36;
const MIN_RADIUS_M = 2;
const MAX_RADIUS_M = 200;
const MAX_CABINS = 56;

// ---------------------------------------------------------------------------
// Wheel frame and local <-> world helpers
// ---------------------------------------------------------------------------

/** Horizontal frame of the wheel: `u` is in-plane, `a` is along the axle. */
export interface FerrisWheelFrame {
  /** In-plane horizontal unit vector (world X/Z). */
  ux: number;
  uz: number;
  /** Axle horizontal unit vector (world X/Z), perpendicular to (ux, uz). */
  ax: number;
  az: number;
}

/**
 * Derive the wheel frame from the plane bearing `rotation` (radians CCW from
 * +X/east, local metres). World mapping is `world = [localX, h, -localY]`, so
 * a local plane direction (cos r, sin r) becomes `(cos r, 0, -sin r)`.
 */
export function ferrisWheelAxes(rotation: number): FerrisWheelFrame {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return { ux: cos, uz: -sin, ax: -sin, az: -cos };
}

/** World point from wheel-plane coordinates (u in-plane, a axle offset, y up). */
function wheelPoint(
  frame: FerrisWheelFrame,
  origin: Vec3,
  u: number,
  a: number,
  y: number,
): Vec3 {
  return [
    origin[0] + frame.ux * u + frame.ax * a,
    y,
    origin[2] + frame.uz * u + frame.az * a,
  ];
}

/** World point on the wheel circle (hub-centred), angle θ in the wheel plane. */
function circlePoint(
  frame: FerrisWheelFrame,
  hub: Vec3,
  radius: number,
  theta: number,
  axialOffset: number,
  radialOffset = 0,
): Vec3 {
  const r = radius + radialOffset;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const a = axialOffset;
  return [
    hub[0] + frame.ux * r * cos + frame.ax * a,
    hub[1] + r * sin,
    hub[2] + frame.uz * r * cos + frame.az * a,
  ];
}

// ---------------------------------------------------------------------------
// Small vector helpers (no THREE.Vector3 allocation in the builders)
// ---------------------------------------------------------------------------

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function scale(a: Vec3, f: number): Vec3 {
  return [a[0] * f, a[1] * f, a[2] * f];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function normalize(a: Vec3): Vec3 | null {
  const length = Math.hypot(a[0], a[1], a[2]);
  if (!Number.isFinite(length) || length < 1e-9) return null;
  return [a[0] / length, a[1] / length, a[2] / length];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

// ---------------------------------------------------------------------------
// Primitive emitters
// ---------------------------------------------------------------------------

/** Triangular prism between two world points (6 triangles, no end caps). */
function emitPrism(
  sink: GeometrySink,
  from: Vec3,
  to: Vec3,
  radius: number,
  color: string,
): void {
  if (!(radius > 0)) return;
  const direction = normalize(subtract(to, from));
  if (!direction) return;
  const helper: Vec3 = Math.abs(direction[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const n1 = normalize(cross(direction, helper));
  if (!n1) return;
  const n2 = normalize(cross(direction, n1));
  if (!n2) return;
  const angles = [Math.PI / 2, Math.PI * 7 / 6, Math.PI * 11 / 6];
  const offsets: Vec3[] = angles.map((angle) =>
    add(scale(n1, Math.cos(angle) * radius), scale(n2, Math.sin(angle) * radius)),
  );
  for (let j = 0; j < 3; j++) {
    const next = (j + 1) % 3;
    const mid = (angles[j] + (angles[next] + Math.PI * 2)) / 2;
    const desired = add(scale(n1, Math.cos(mid)), scale(n2, Math.sin(mid)));
    sink.addOrientedQuad(
      add(from, offsets[j]),
      add(from, offsets[next]),
      add(to, offsets[next]),
      add(to, offsets[j]),
      desired,
      color,
    );
  }
}

interface BoxColors {
  top: string;
  bottom?: string;
  sideU: string;
  sideNegU: string;
  sideA: string;
  sideNegA: string;
}

interface BoxOptions {
  center: Vec3;
  frame: FerrisWheelFrame;
  halfU: number;
  halfA: number;
  halfY: number;
  colors: BoxColors;
  /** Skip the top face (e.g. body hidden under a separate roof quad). */
  skipTop?: boolean;
  /** Skip the bottom face (e.g. boxes resting on the ground). */
  skipBottom?: boolean;
}

/** Axis-aligned box in the wheel frame (12 triangles, or fewer when faces are skipped). */
function emitBox(sink: GeometrySink, options: BoxOptions): void {
  const { center, frame, halfU, halfA, halfY, colors } = options;
  if (!(halfU > 0) || !(halfA > 0) || !(halfY > 0)) return;
  const corner = (su: number, sa: number, sy: number): Vec3 =>
    wheelPoint(frame, center, su * halfU, sa * halfA, center[1] + sy * halfY);
  const normalU: Vec3 = [frame.ux, 0, frame.uz];
  const normalA: Vec3 = [frame.ax, 0, frame.az];
  const scaleNormal = (v: Vec3, f: number): Vec3 => [v[0] * f, 0, v[2] * f];

  if (!options.skipTop) {
    sink.addOrientedQuad(
      corner(-1, -1, 1),
      corner(1, -1, 1),
      corner(1, 1, 1),
      corner(-1, 1, 1),
      [0, 1, 0],
      colors.top,
    );
  }
  if (!options.skipBottom && colors.bottom) {
    sink.addOrientedQuad(
      corner(-1, -1, -1),
      corner(-1, 1, -1),
      corner(1, 1, -1),
      corner(1, -1, -1),
      [0, -1, 0],
      colors.bottom,
    );
  }
  sink.addOrientedQuad(
    corner(1, -1, -1),
    corner(1, 1, -1),
    corner(1, 1, 1),
    corner(1, -1, 1),
    normalU,
    colors.sideU,
  );
  sink.addOrientedQuad(
    corner(-1, 1, -1),
    corner(-1, -1, -1),
    corner(-1, -1, 1),
    corner(-1, 1, 1),
    scaleNormal(normalU, -1),
    colors.sideNegU,
  );
  sink.addOrientedQuad(
    corner(-1, 1, -1),
    corner(1, 1, -1),
    corner(1, 1, 1),
    corner(-1, 1, 1),
    normalA,
    colors.sideA,
  );
  sink.addOrientedQuad(
    corner(1, -1, -1),
    corner(-1, -1, -1),
    corner(-1, -1, 1),
    corner(1, -1, 1),
    scaleNormal(normalA, -1),
    colors.sideNegA,
  );
}

/**
 * White tubular rim: a triangular-section torus in the wheel plane at a given
 * axial offset. `segments × 3` quads = `segments × 6` triangles.
 */
function emitTubeRing(
  sink: GeometrySink,
  frame: FerrisWheelFrame,
  hub: Vec3,
  radius: number,
  axialOffset: number,
  tubeRadius: number,
  segments: number,
  color: string,
): void {
  if (!(radius > tubeRadius) || segments < 3) return;
  const sides = 3;
  const radialOffsets = [tubeRadius, -tubeRadius * 0.5, -tubeRadius * 0.5];
  const axialOffsets = [0, tubeRadius * 0.866, -tubeRadius * 0.866];
  const step = (Math.PI * 2) / segments;
  for (let k = 0; k < segments; k++) {
    const thetaA = k * step;
    const thetaB = (k + 1) * step;
    const thetaMid = (thetaA + thetaB) / 2;
    const radialDir: Vec3 = [
      frame.ux * Math.cos(thetaMid),
      Math.sin(thetaMid),
      frame.uz * Math.cos(thetaMid),
    ];
    const axleDir: Vec3 = [frame.ax, 0, frame.az];
    const ringA: Vec3[] = [];
    const ringB: Vec3[] = [];
    for (let j = 0; j < sides; j++) {
      ringA.push(
        circlePoint(frame, hub, radius, thetaA, axialOffset + axialOffsets[j], radialOffsets[j]),
      );
      ringB.push(
        circlePoint(frame, hub, radius, thetaB, axialOffset + axialOffsets[j], radialOffsets[j]),
      );
    }
    for (let j = 0; j < sides; j++) {
      const next = (j + 1) % sides;
      // Outward direction of this cross-section edge, in (radial, axial) space.
      const edgeRadial = radialOffsets[next] - radialOffsets[j];
      const edgeAxial = axialOffsets[next] - axialOffsets[j];
      const midRadial = (radialOffsets[next] + radialOffsets[j]) / 2;
      const midAxial = (axialOffsets[next] + axialOffsets[j]) / 2;
      let nr = edgeAxial;
      let na = -edgeRadial;
      if (nr * midRadial + na * midAxial < 0) {
        nr = -nr;
        na = -na;
      }
      const desired = add(scale(radialDir, nr), scale(axleDir, na));
      sink.addOrientedQuad(ringA[j], ringA[next], ringB[next], ringB[j], desired, color);
    }
  }
}

/** Double-sided flat annular band in the wheel plane (middle ring). */
function emitBandRing(
  sink: GeometrySink,
  frame: FerrisWheelFrame,
  hub: Vec3,
  radius: number,
  axialOffset: number,
  halfWidth: number,
  segments: number,
  color: string,
): void {
  if (!(radius > halfWidth) || segments < 3) return;
  const step = (Math.PI * 2) / segments;
  const axleDir: Vec3 = [frame.ax, 0, frame.az];
  for (let k = 0; k < segments; k++) {
    const thetaA = k * step;
    const thetaB = (k + 1) * step;
    const innerA = circlePoint(frame, hub, radius - halfWidth, thetaA, axialOffset);
    const innerB = circlePoint(frame, hub, radius - halfWidth, thetaB, axialOffset);
    const outerA = circlePoint(frame, hub, radius + halfWidth, thetaA, axialOffset);
    const outerB = circlePoint(frame, hub, radius + halfWidth, thetaB, axialOffset);
    sink.addOrientedQuad(innerA, innerB, outerB, outerA, axleDir, color);
    sink.addOrientedQuad(outerA, outerB, innerB, innerA, scale(axleDir, -1), color);
  }
}

/** Metal cylinder whose axis is the wheel axle (hub drum / axle). */
function emitAxleCylinder(
  sink: GeometrySink,
  frame: FerrisWheelFrame,
  center: Vec3,
  radius: number,
  halfWidth: number,
  sides: number,
  sideColor: string,
  capColor: string,
): void {
  if (!(radius > 0) || !(halfWidth > 0) || sides < 3) return;
  const axleDir: Vec3 = [frame.ax, 0, frame.az];
  const circle = (phi: number, axial: number): Vec3 => [
    center[0] + frame.ux * radius * Math.cos(phi) + frame.ax * axial,
    center[1] + radius * Math.sin(phi),
    center[2] + frame.uz * radius * Math.cos(phi) + frame.az * axial,
  ];
  for (let k = 0; k < sides; k++) {
    const phiA = (k / sides) * Math.PI * 2;
    const phiB = ((k + 1) / sides) * Math.PI * 2;
    const phiMid = (phiA + phiB) / 2;
    const desired: Vec3 = [
      frame.ux * Math.cos(phiMid),
      Math.sin(phiMid),
      frame.uz * Math.cos(phiMid),
    ];
    sink.addOrientedQuad(
      circle(phiA, -halfWidth),
      circle(phiB, -halfWidth),
      circle(phiB, halfWidth),
      circle(phiA, halfWidth),
      desired,
      sideColor,
    );
  }
  for (const sign of [-1, 1]) {
    const capCenter: Vec3 = [
      center[0] + frame.ax * halfWidth * sign,
      center[1],
      center[2] + frame.az * halfWidth * sign,
    ];
    const normal = scale(axleDir, sign);
    for (let k = 0; k < sides; k++) {
      const phiA = (k / sides) * Math.PI * 2;
      const phiB = ((k + 1) / sides) * Math.PI * 2;
      sink.addWorldTriangle(
        capCenter,
        circle(phiA, halfWidth * sign),
        circle(phiB, halfWidth * sign),
        capColor,
        normal,
      );
    }
  }
}

/**
 * Flattened elliptical plate in the wheel plane (the «МІНСК» sign). Emits two
 * faces plus a side rim; `letters` adds a smaller elliptical hint on both sides.
 */
function emitSignPlate(
  sink: GeometrySink,
  frame: FerrisWheelFrame,
  center: Vec3,
  halfU: number,
  halfY: number,
  halfThickness: number,
  segments: number,
  faceColor: string,
  edgeColor: string,
  letterColor: string,
): void {
  if (!(halfU > 0) || !(halfY > 0) || !(halfThickness > 0)) return;
  const front = halfThickness;
  const back = -halfThickness;
  const pointAt = (phi: number, axial: number, fu: number, fy: number): Vec3 => [
    center[0] + frame.ax * axial + frame.ux * fu * Math.cos(phi),
    center[1] + fy * Math.sin(phi),
    center[2] + frame.az * axial + frame.uz * fu * Math.cos(phi),
  ];
  const axleDir: Vec3 = [frame.ax, 0, frame.az];
  for (let k = 0; k < segments; k++) {
    const phiA = (k / segments) * Math.PI * 2;
    const phiB = ((k + 1) / segments) * Math.PI * 2;
    const frontCenter = pointAt(0, front, 0, 0);
    const backCenter = pointAt(0, back, 0, 0);
    sink.addWorldTriangle(
      frontCenter,
      pointAt(phiA, front, halfU, halfY),
      pointAt(phiB, front, halfU, halfY),
      faceColor,
      axleDir,
    );
    sink.addWorldTriangle(
      backCenter,
      pointAt(phiB, back, halfU, halfY),
      pointAt(phiA, back, halfU, halfY),
      faceColor,
      scale(axleDir, -1),
    );
    const phiMid = (phiA + phiB) / 2;
    const rimNormal: Vec3 = [
      frame.ux * Math.cos(phiMid),
      Math.sin(phiMid),
      frame.uz * Math.cos(phiMid),
    ];
    sink.addOrientedQuad(
      pointAt(phiA, back, halfU, halfY),
      pointAt(phiB, back, halfU, halfY),
      pointAt(phiB, front, halfU, halfY),
      pointAt(phiA, front, halfU, halfY),
      rimNormal,
      edgeColor,
    );
  }
  // Hint of the yellow «МІНСК» lettering: a smaller oval proud of each face.
  const letterHalfU = halfU * 0.58;
  const letterHalfY = halfY * 0.42;
  for (const sign of [-1, 1]) {
    const axial = sign * (halfThickness + 0.012);
    const faceNormal = scale(axleDir, sign);
    const centerPoint = pointAt(0, axial, 0, 0);
    for (let k = 0; k < segments; k++) {
      const phiA = (k / segments) * Math.PI * 2;
      const phiB = ((k + 1) / segments) * Math.PI * 2;
      sink.addWorldTriangle(
        centerPoint,
        pointAt(phiA, axial, letterHalfU, letterHalfY),
        pointAt(phiB, axial, letterHalfU, letterHalfY),
        letterColor,
        faceNormal,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Cabin dimensions (scaled a little with the wheel size)
// ---------------------------------------------------------------------------

export interface FerrisCabinDimensions {
  /** Scale relative to the reference (Gorky Park, 25 m radius) cabin. */
  scale: number;
  halfU: number;
  halfA: number;
  bodyHeight: number;
  hangGap: number;
  roofLift: number;
  roofHalfU: number;
  roofHalfA: number;
}

export function ferrisWheelCabinDimensions(radius: number): FerrisCabinDimensions {
  const scale = clamp(radius / REFERENCE_RADIUS_M, 0.55, 1.15);
  const halfU = (CABIN_WIDTH_M / 2) * scale;
  const halfA = (CABIN_DEPTH_M / 2) * scale;
  return {
    scale,
    halfU,
    halfA,
    bodyHeight: CABIN_HEIGHT_M * scale,
    hangGap: CABIN_HANG_GAP_M * scale,
    roofLift: 0.03 * scale,
    roofHalfU: halfU * 1.07,
    roofHalfA: halfA * 1.05,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isValidAttraction(attraction: AttractionFeature | null | undefined): boolean {
  if (!attraction || typeof attraction !== 'object') return false;
  if (attraction.type !== 'ferris-wheel') return false;
  if (!Number.isFinite(attraction.x) || !Number.isFinite(attraction.y)) return false;
  if (
    !Number.isFinite(attraction.radius) ||
    attraction.radius < MIN_RADIUS_M ||
    attraction.radius > MAX_RADIUS_M
  ) {
    return false;
  }
  if (
    !Number.isFinite(attraction.hubHeight) ||
    attraction.hubHeight < 2 ||
    attraction.hubHeight > 400
  ) {
    return false;
  }
  if (!Number.isFinite(attraction.height) || attraction.height <= 0) return false;
  if (!Number.isFinite(attraction.cabins) || attraction.cabins < 0) return false;
  if (!Number.isFinite(attraction.rotation)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Per-wheel build
// ---------------------------------------------------------------------------

/** True when cabin `index` should be an open/yellow one (evenly distributed). */
function isOpenCabin(index: number, cabins: number, openCabins: number): boolean {
  if (openCabins <= 0 || cabins <= 0) return false;
  if (openCabins >= cabins) return true;
  return (index * openCabins) % cabins < openCabins;
}

function emitCabin(
  sink: GeometrySink,
  frame: FerrisWheelFrame,
  pivot: Vec3,
  dims: FerrisCabinDimensions,
  open: boolean,
): void {
  const bodyColors = open ? CABIN_YELLOW_SHADES : CABIN_RED_SHADES;
  const center: Vec3 = [
    pivot[0],
    pivot[1] - dims.hangGap - dims.bodyHeight / 2,
    pivot[2],
  ];
  emitBox(sink, {
    center,
    frame,
    halfU: dims.halfU,
    halfA: dims.halfA,
    halfY: dims.bodyHeight / 2,
    colors: {
      top: bodyColors[0],
      sideU: bodyColors[0],
      sideNegU: bodyColors[1],
      sideA: bodyColors[2],
      sideNegA: bodyColors[3],
    },
    skipTop: true,
    skipBottom: true,
  });
  // Cream (closed) / warm yellow (open) roof: one flat quad with a small
  // overhang, at the top of the body.
  const roofY = pivot[1] - dims.hangGap + dims.roofLift;
  const roofColor = open ? CABIN_ROOF_OPEN : CABIN_ROOF_CREAM;
  const corner = (su: number, sa: number): Vec3 =>
    wheelPoint(frame, pivot, su * dims.roofHalfU, sa * dims.roofHalfA, roofY);
  sink.addOrientedQuad(
    corner(-1, -1),
    corner(1, -1),
    corner(1, 1),
    corner(-1, 1),
    [0, 1, 0],
    roofColor,
  );
}

/**
 * Emit one wheel into `sink`. Returns false for malformed attractions.
 * Deterministic: all variation comes from the feature fields.
 */
export function emitFerrisWheel(sink: GeometrySink, attraction: AttractionFeature): boolean {
  if (!isValidAttraction(attraction)) return false;

  const frame = ferrisWheelAxes(attraction.rotation);
  const origin: Vec3 = [attraction.x, 0, -attraction.y];
  const hub: Vec3 = [attraction.x, attraction.hubHeight, -attraction.y];
  const radius = attraction.radius;
  const hubHeight = attraction.hubHeight;
  const cabins = clamp(Math.round(attraction.cabins), 0, MAX_CABINS);
  const requestedOpen =
    attraction.openCabins === undefined
      ? Math.round(cabins / 9)
      : Math.round(attraction.openCabins);
  const openCabins = clamp(requestedOpen, 0, cabins);
  const supportScale = clamp(radius / REFERENCE_RADIUS_M, 0.6, 1.1);
  const cabinDims = ferrisWheelCabinDimensions(radius);

  // Dense wheels (unusual data) trade rim segments/spokes for cabin budget so
  // a wheel never exceeds the triangle budget.
  const reducedDetail = cabins > 40;
  const segments = reducedDetail ? MIN_SEGMENTS : clamp(Math.round(radius), MIN_SEGMENTS, MAX_SEGMENTS);
  const spokesPerSide = reducedDetail ? 8 : radius >= 20 ? 12 : 8;
  const axleHalfLength = FRAME_AXLE_OFFSET_M + 0.35;

  const white = FERRIS_WHEEL_COLORS.frame;
  const whiteShade = FERRIS_WHEEL_COLORS.frameShade;
  const red = FERRIS_WHEEL_COLORS.red;
  const redShade = shadeHex(red, -0.16);
  const metal = FERRIS_WHEEL_COLORS.metal;
  const concrete = FERRIS_WHEEL_COLORS.concrete;
  const dark = FERRIS_WHEEL_COLORS.dark;
  const deck = FERRIS_WHEEL_COLORS.deck;

  // --- wheel rims, middle ring, spokes and bracing -------------------------
  for (const side of [-1, 1]) {
    const axialOffset = HUB_HALF_WIDTH_M * side;
    emitTubeRing(sink, frame, hub, radius, axialOffset, RIM_TUBE_RADIUS_M, segments, white);
    emitTubeRing(
      sink,
      frame,
      hub,
      radius - RIM_DEPTH_M,
      axialOffset,
      RIM_TUBE_RADIUS_M * 0.85,
      segments,
      white,
    );
    emitBandRing(
      sink,
      frame,
      hub,
      radius * MIDDLE_RING_RATIO,
      axialOffset,
      0.14 * supportScale,
      segments,
      whiteShade,
    );
  }

  const step = (Math.PI * 2) / spokesPerSide;
  for (const side of [-1, 1]) {
    const axialOffset = HUB_HALF_WIDTH_M * side;
    for (let k = 0; k < spokesPerSide; k++) {
      const theta = k * step;
      // White spoke from the hub drum to the inner rim.
      emitPrism(
        sink,
        circlePoint(frame, hub, HUB_RADIUS_M, theta, axialOffset),
        circlePoint(frame, hub, radius - RIM_DEPTH_M, theta, axialOffset),
        0.11 + 0.05 * supportScale,
        white,
      );
      // Red bracing diagonal between the middle ring and the outer rim.
      emitPrism(
        sink,
        circlePoint(frame, hub, radius * MIDDLE_RING_RATIO, theta, axialOffset),
        circlePoint(frame, hub, radius, theta + step * 0.5, axialOffset),
        0.085 + 0.03 * supportScale,
        redShade,
      );
    }
  }

  // --- hub drum, axle, bearing blocks --------------------------------------
  emitAxleCylinder(
    sink,
    frame,
    hub,
    HUB_RADIUS_M,
    HUB_HALF_WIDTH_M,
    8,
    metal,
    FERRIS_WHEEL_COLORS.hub,
  );
  emitAxleCylinder(
    sink,
    frame,
    hub,
    AXLE_RADIUS_M,
    axleHalfLength,
    6,
    dark,
    metal,
  );
  for (const side of [-1, 1]) {
    const bearingCenter: Vec3 = [
      hub[0] + frame.ax * FRAME_AXLE_OFFSET_M * side,
      hub[1],
      hub[2] + frame.az * FRAME_AXLE_OFFSET_M * side,
    ];
    emitBox(sink, {
      center: bearingCenter,
      frame,
      halfU: 0.55 * supportScale + 0.08,
      halfA: 0.45 * supportScale + 0.08,
      halfY: 0.6 * supportScale + 0.1,
      colors: { top: metal, bottom: dark, sideU: metal, sideNegU: whiteShade, sideA: metal, sideNegA: whiteShade },
      skipBottom: true,
    });
  }

  // --- sign plates on both sides of the hub --------------------------------
  for (const sign of [-1, 1]) {
    const signCenter: Vec3 = [
      hub[0] + frame.ax * (HUB_HALF_WIDTH_M + 0.25) * sign,
      hub[1] + SIGN_CENTRE_LIFT_M,
      hub[2] + frame.az * (HUB_HALF_WIDTH_M + 0.25) * sign,
    ];
    emitSignPlate(
      sink,
      frame,
      signCenter,
      SIGN_HALF_WIDTH_M * supportScale,
      SIGN_HALF_HEIGHT_M * supportScale,
      SIGN_THICKNESS_M / 2,
      8,
      red,
      shadeHex(red, -0.22),
      SIGN_LETTER_COLOR,
    );
  }

  // --- A-frames, foundation pad, boarding deck ----------------------------
  const legSpread = clamp(radius * 0.54, 3.5, 14);
  const legRadius = 0.22 * supportScale + 0.08;
  const beamRadius = 0.13 * supportScale + 0.05;
  const deckTop = Math.max(0.55, Math.min(1.1, hubHeight - radius - 1.55));
  const deckHalfU = 4.5 * supportScale;
  const deckHalfA = 2.6 * supportScale;
  const deckBottom = BASE_PAD_TOP_M;

  for (const side of [-1, 1]) {
    const apexHeight = hubHeight;
    const apex: Vec3 = [
      hub[0] + frame.ax * FRAME_AXLE_OFFSET_M * side,
      apexHeight,
      hub[2] + frame.az * FRAME_AXLE_OFFSET_M * side,
    ];
    // Two legs per frame.
    for (const legSign of [-1, 1]) {
      const foot = wheelPoint(
        frame,
        origin,
        legSign * legSpread,
        FRAME_AXLE_OFFSET_M * side,
        BASE_PAD_TOP_M * 0.5,
      );
      emitPrism(sink, foot, apex, legRadius, white);
    }
    // Horizontal cross-beams at two heights.
    for (const heightFraction of [0.42, 0.76]) {
      const y = hubHeight * heightFraction;
      const u = legSpread * (1 - heightFraction);
      emitPrism(
        sink,
        wheelPoint(frame, origin, -u, FRAME_AXLE_OFFSET_M * side, y),
        wheelPoint(frame, origin, u, FRAME_AXLE_OFFSET_M * side, y),
        beamRadius,
        whiteShade,
      );
    }
  }
  // Ties between the two frames at the feet.
  for (const legSign of [-1, 1]) {
    emitPrism(
      sink,
      wheelPoint(frame, origin, legSign * legSpread, -FRAME_AXLE_OFFSET_M, BASE_PAD_TOP_M * 0.6),
      wheelPoint(frame, origin, legSign * legSpread, FRAME_AXLE_OFFSET_M, BASE_PAD_TOP_M * 0.6),
      beamRadius,
      whiteShade,
    );
  }

  emitBox(sink, {
    center: [origin[0], BASE_PAD_TOP_M / 2, origin[2]],
    frame,
    halfU: legSpread + 1.4,
    halfA: FRAME_AXLE_OFFSET_M + 1.0,
    halfY: BASE_PAD_TOP_M / 2,
    colors: { top: concrete, bottom: dark, sideU: concrete, sideNegU: dark, sideA: concrete, sideNegA: dark },
    skipBottom: true,
  });

  // Boarding deck under the lowest cabin (plus a small step box beside it).
  emitBox(sink, {
    center: [origin[0], (deckBottom + deckTop) / 2, origin[2]],
    frame,
    halfU: deckHalfU,
    halfA: deckHalfA,
    halfY: (deckTop - deckBottom) / 2,
    colors: {
      top: deck,
      bottom: dark,
      sideU: shadeHex(deck, -0.15),
      sideNegU: shadeHex(deck, -0.25),
      sideA: shadeHex(deck, -0.1),
      sideNegA: shadeHex(deck, -0.2),
    },
    skipBottom: true,
  });
  const stepTop = clamp(deckTop * 0.55, 0.2, 0.6);
  emitBox(sink, {
    center: wheelPoint(frame, origin, deckHalfU + 0.9 * supportScale, 0, stepTop / 2),
    frame,
    halfU: 0.85 * supportScale,
    halfA: 1.1 * supportScale,
    halfY: stepTop / 2,
    colors: { top: concrete, sideU: concrete, sideNegU: dark, sideA: shadeHex(concrete, -0.1), sideNegA: dark },
    skipBottom: true,
  });

  // --- upright cabins hanging from the outer rim ---------------------------
  if (cabins > 0) {
    const cabinStep = (Math.PI * 2) / cabins;
    for (let k = 0; k < cabins; k++) {
      const theta = k * cabinStep - Math.PI / 2; // first cabin at the bottom
      const pivot = circlePoint(frame, hub, radius, theta, 0);
      emitCabin(sink, frame, pivot, cabinDims, isOpenCabin(k, cabins, openCabins));
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AttractionEmitStats {
  /** Number of wheels emitted. */
  attractions: number;
  /** Triangles added to the sink by the wheels. */
  triangles: number;
  /** Attractions skipped because of malformed data. */
  skipped: number;
}

/** Emit every ferris wheel into the given sink; never throws. */
export function emitAttractions(
  sink: GeometrySink,
  attractions: readonly AttractionFeature[] | null | undefined,
): AttractionEmitStats {
  const stats: AttractionEmitStats = { attractions: 0, triangles: 0, skipped: 0 };
  if (!Array.isArray(attractions) || attractions.length === 0) return stats;
  for (const attraction of attractions) {
    const before = sink.triangleCount;
    try {
      if (emitFerrisWheel(sink, attraction)) {
        stats.attractions++;
        stats.triangles += sink.triangleCount - before;
      } else {
        stats.skipped++;
      }
    } catch {
      // Never let one odd attraction break the whole tile.
      stats.skipped++;
    }
  }
  return stats;
}

/**
 * Build all attraction geometry for a tile (one merged indexed geometry), or
 * null when there are no valid attractions.
 */
export function buildAttractionGeometry(
  attractions: readonly AttractionFeature[] | null | undefined,
): THREE.BufferGeometry | null {
  if (!Array.isArray(attractions) || attractions.length === 0) return null;
  const sink = new GeometrySink();
  emitAttractions(sink, attractions);
  if (sink.isEmpty) return null;
  return sink.build();
}

/** Number of wheel-plane rim segments used for a given radius (24–36). */
export function ferrisWheelSegments(radius: number): number {
  if (!Number.isFinite(radius) || radius <= 0) return MIN_SEGMENTS;
  return clamp(Math.round(radius), MIN_SEGMENTS, MAX_SEGMENTS);
}
