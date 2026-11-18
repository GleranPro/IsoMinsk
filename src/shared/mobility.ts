/**
 * Isometric Minsk — mobility (public transport + traffic signals) contract.
 *
 * This module is the single source of truth for the *payload* schema shared by
 * the offline Python exporter (`scripts/mobility/`) and the browser runtime
 * (`src/mobility/`, `src/engine/mobility/`). It must stay free of React and
 * Three.js imports: unit tests and the Python-side fixtures load it directly.
 *
 * Coordinate convention (identical to the tint/tile payload, see types.ts):
 *   geometry is LOCAL METRES in the UTM 35N plane, translated by the city
 *   origin (`originUtm` in the tile manifest). Converting to Three.js world:
 *      worldX =  localX
 *      worldY =  heightAboveGroundMetres
 *      worldZ = -localY
 *   Use `mobilityLocalToWorld()` / `mobilityWorldToLocal()` instead of open
 *   coding the mapping, so the mobility layer can never drift from the tiles.
 *
 * Time convention:
 *   Every schedule time is an integer number of seconds after the start of the
 *   *service day*. A service day starts at 00:00 local time in the schedule's
 *   time zone and stop times may exceed 86400 (after-midnight trips keep
 *   counting, they do not wrap). Calendar dates are ISO `YYYY-MM-DD` strings and
 *   are resolved in the feed's IANA time zone, never in the browser's zone.
 *
 * Versioning:
 *   `MOBILITY_VERSION` covers the payload schema below. A release is identified
 *   by the triple `(network hash, schedule version, bindings hash)`; the loader
 *   refuses to mix payloads from different releases.
 */

import type { FeatureId, Polygon } from './types';

/** Payload schema version understood by the exporter and the loader. */
export const MOBILITY_VERSION = 1;

/**
 * Distance scale used for quantised geometry in mobile-friendly payloads.
 * Geometry is emitted as plain numbers so this is documentation, not a limit.
 */
export const MOBILITY_POSITION_SCALE = 100; // 1 cm

/** Public transport modes in the first working version. */
export type MobilityMode = 'bus' | 'trolleybus' | 'tram';

/** Runtime movement classes that can be admitted by a signal group. */
export type MobilityTrafficKind = 'vehicle' | 'pedestrian' | 'tram';

/** Signal aspect shown by a head and computed by the controller. */
export type MobilityAspect = 'red' | 'yellow' | 'green';

/** A node reference as used by the offline network builder. */
export type MobilityNodeRef = string;

/**
 * A polyline in local metres.
 *
 * `p` is a flat `[x0, y0, h0, x1, y1, h1, …]` array (three numbers per vertex,
 * height above ground in metres). `s` is the cumulative arc length at every
 * vertex in metres, strictly non-decreasing, same vertex count as `p / 3`.
 * A planned one-vertex polyline (`s = [0]`) is legal for degenerate stubs.
 */
export interface MobilityPolyline {
  p: number[];
  s: number[];
}

/** One travel lane centreline of an edge, offset from the centreline. */
export interface MobilityLane {
  /** Lane index inside the edge, 0 = closest to the centreline's left side. */
  index: number;
  /** Lateral offset from the edge centreline, metres (+ = left of travel). */
  offset: number;
  /** Lane width, metres. */
  widthM: number;
  /** Lane centreline; empty when it is identical to the edge centreline. */
  centerline: MobilityPolyline;
}

/**
 * A directed piece of navigable way between two graph nodes.
 *
 * Edges are exported from the *source topology*: `from`/`to` are stable node
 * references of the OSM way chain, never a proximity join. Bridge/tunnel/layer
 * are preserved so an under-pass is never joined to the deck above it.
 */
export interface MobilityEdge {
  /** Stable id: `e:<osmWayId>:<dir>` (dir is `f` forward, `b` backward). */
  id: string;
  /** Source OSM way id. */
  wayId: number;
  /** Graph node at the start / end of this directed edge. */
  from: MobilityNodeRef;
  to: MobilityNodeRef;
  /** Modes allowed on this edge. */
  modes: MobilityMode[];
  /** True for one-way carriageways / single-direction tram track. */
  oneway: boolean;
  /** OSM `bridge`/`tunnel` semantics; never inferred from proximity. */
  bridge?: boolean;
  tunnel?: boolean;
  /** OSM `layer` (0 when absent) — keeps crossings physically ordered. */
  layer: number;
  /** Normalised carriageway width, metres. */
  widthM: number;
  /** Edge centreline in travel direction. */
  centerline: MobilityPolyline;
  /** Travel lanes, ordered left→right when facing the travel direction. */
  lanes: MobilityLane[];
  /**
   * Allowed continuations at `to` (edge ids). Empty/omitted means "unknown";
   * the runtime must then not invent a turn.
   */
  next?: string[];
}

/** Why a stop / variant binding was accepted by the audit. */
export type MobilityBindingConfidence = 'source-id' | 'offset-node' | 'name-geometry' | 'manual';

/**
 * A public transport stop (physical stop area, one direction of travel).
 *
 * A paired stop on the other side of the street is a *different* `MobilityStop`
 * with its own binding: the vehicle body centre and the boarding point are
 * distinct points and must never be collapsed.
 */
export interface MobilityStop {
  /** Stable id: `s:<sourceStopId>` or `s:osm:<nodeId>`. */
  id: string;
  name: string;
  modes: MobilityMode[];
  /** Platform outline when the source provides one (renderer already paints it). */
  platform?: Polygon;
  /** Boarding area centre in local metres (passengers stand here). */
  x: number;
  y: number;
  /** Source OSM node/way ids backing this stop (provenance). */
  osmIds: number[];
}

/** One scheduled call of a variant at a stop, pinned to a lane position. */
export interface MobilityStopCall {
  /** Position in the variant's ordered stop list, 0-based. */
  seq: number;
  stopId: string;
  /** Edge + lane the vehicle body waits on. */
  edgeId: string;
  laneIndex: number;
  /** Distance along the lane centreline where the body centre stops, metres. */
  s: number;
  /** Travel heading on arrival, radians CCW from +X (east). */
  heading: number;
  /** Body-centre position in local metres (computed by the exporter). */
  x: number;
  y: number;
  /** Deck height above ground at the stop, metres. */
  h: number;
  /** Modelled dwell time, seconds (used when the schedule has no explicit dwell). */
  dwellS: number;
  /** True when the source schedule publishes times at this stop. */
  timed: boolean;
  /** How the stop was bound to the lane; recorded for the audit. */
  binding: MobilityBindingConfidence;
}

/**
 * One passenger-facing direction of a route.
 *
 * `edges` is the ordered edge sequence; it must be continuous (`edge[i].to ===
 * edge[i+1].from`) at every step, and every `MobilityStopCall` must lie on one
 * of those edges. Geometry is verified by the offline audit (`verified`).
 */
export interface MobilityRouteVariant {
  /** Stable id: `r:<routeRef>:<direction>:<relationId>` (source-keyed). */
  id: string;
  mode: MobilityMode;
  /** Public route number as shown to passengers ("100", "1", "Т4"). */
  ref: string;
  /** Destination / headsign text. */
  headSign: string;
  /** 0 or 1; part of the source relation, not a guess from geometry. */
  direction: 0 | 1;
  /** Ordered edges of the variant (see the continuity rule above). */
  edges: string[];
  /** Ordered stop calls. */
  stops: MobilityStopCall[];
  /** Total path length, metres (sum of lane-centreline lengths). */
  lengthM: number;
  /** Source `route` relation id. */
  sourceRelationId: number;
  /** False when any gap/mismatch was recorded; unverified variants are not shown. */
  verified: boolean;
  /** Axis-aligned bounds `[minX, minY, maxX, maxY]` for culling. */
  bounds: [number, number, number, number];
  /** Issues found by the audit (empty for a clean variant). */
  issues?: string[];
}

/** One signal group (a set of movements that always share an aspect). */
export interface MobilitySignalGroup {
  /** Id unique within the node, e.g. "g0", "ped1". */
  id: string;
  kind: MobilityTrafficKind;
  /** Aspects the group can display. `red` is implicit. */
  aspects: MobilityAspect[];
}

/** A modelled phase of a signal program (durations are model parameters). */
export interface MobilityPhase {
  /** Groups allowed to move during this phase (indices into `groups`). */
  green: number[];
  /** Modelled green duration, seconds. */
  greenS: number;
  /** Modelled yellow duration, seconds (0 for pedestrian groups). */
  yellowS: number;
  /** All-red / clearance interval after the phase, seconds. */
  allRedS: number;
}

/** A complete, cyclic signal program for one node. */
export interface MobilityPhaseProgram {
  /** Model parameter set id, e.g. "city-v1"; never presented as measured data. */
  id: string;
  phases: MobilityPhase[];
  /** Cycle offset, seconds (shifts the cycle start). */
  offsetS: number;
}

/** One movement through a signalised node (vehicle, tram or pedestrian). */
export interface MobilityMovement {
  /** Id unique within the node, e.g. "m0" (stable across reloads). */
  id: string;
  kind: MobilityTrafficKind;
  /** Approach edge + lane index (for pedestrians: the sidewalk crossing id). */
  approach: { edgeId: string; laneIndex: number };
  /** Exit edge id (`''` for pedestrian movements). */
  exitEdgeId: string;
  /** Path from the stop line through the node; flat x,y with heights. */
  path: MobilityPolyline;
  /** Signal group index the movement obeys. */
  group: number;
  /** Body length assumed when deciding whether the node is clear, metres. */
  clearanceLengthM: number;
}

/** A painted stop line plus the movement it releases. */
export interface MobilityStopLine {
  /** Index into the node's `movements`. */
  movement: number;
  /** Approach edge + lane the line belongs to. */
  edgeId: string;
  laneIndex: number;
  /**
   * Distance along the approach lane centreline at the line, metres. A vehicle
   * must not cross this arc length while its group is not green.
   */
  s: number;
  /** Line across the lane: flat `[x0, y0, h0, x1, y1, h1]`. */
  line: number[];
  /** Travel heading at the line, radians CCW from +X. */
  heading: number;
}

/** One modelled signal head (emissive quad/box, no per-head light source). */
export interface MobilitySignalHead {
  /** Id unique within the node, e.g. "h0". */
  id: string;
  /** Index into the node's `groups`. */
  group: number;
  /** Head position in local metres. */
  x: number;
  y: number;
  /**
   * Ground elevation under the head, metres above the base plane (0). Non-zero
   * on bridge decks and ramps: a pole must stand on the deck it serves, not on
   * the ground below it. Omitted means "ground level".
   */
  groundHeightM?: number;
  /** Yaw the head faces, radians CCW from +X (direction of travel it serves). */
  facing: number;
  kind: MobilityTrafficKind;
  /** Pole height for the stylised model, metres. */
  heightM: number;
}

/**
 * A signalised node: junction, tram crossing or a standalone pedestrian crossing.
 *
 * Occupancy is *runtime state*, not payload: the controller must remember which
 * movements have already entered and have not cleared the conflict zone.
 */
export interface MobilitySignalNode {
  /** Stable id: `j:<osmNodeId>` or `j:group:<n>`. */
  id: string;
  /** What the node controls. */
  kind: 'junction' | 'crossing' | 'tram';
  /** Node centre, local metres. */
  x: number;
  y: number;
  groups: MobilitySignalGroup[];
  movements: MobilityMovement[];
  stopLines: MobilityStopLine[];
  heads: MobilitySignalHead[];
  program: MobilityPhaseProgram;
  /**
   * Pairs of movement indices that must never be green simultaneously, using
   * swept-path conflicts of the modelled body width/length.
   */
  conflicts: [number, number][];
  /** Conflict-zone rings (flat rings) used for occupancy checks. */
  zones?: number[][];
}

/** One stop time of a trip. */
export interface MobilityStopTime {
  /** Index into the variant's `stops` array. */
  seq: number;
  /** Scheduled arrival, seconds after service-day start (may exceed 86400). */
  arrivalS: number;
  /** Scheduled departure, seconds after service-day start (may exceed 86400). */
  departureS: number;
}

/** Service calendar: weekdays plus date exceptions, in the source time zone. */
export interface MobilityServiceCalendar {
  /** Stable id: `cal:<sourceCalendarId>`. */
  id: string;
  /** First date the calendar is valid for, ISO `YYYY-MM-DD`. */
  startDate: string;
  /** Last date the calendar is valid for, ISO `YYYY-MM-DD` (inclusive). */
  endDate: string;
  /** Weekdays the service runs on: 0=Sunday … 6=Saturday. */
  weekdays: number[];
  /** Date exceptions (added service / cancelled service). */
  exceptions?: { date: string; kind: 'add' | 'remove' }[];
  /** IANA time zone of the source, e.g. "Europe/Minsk". */
  timeZone: string;
}

/** One scheduled run of a variant. */
export interface MobilityTrip {
  /** Stable id: `t:<sourceTripId>` or a deterministic hash when the source lacks one. */
  id: string;
  variantId: string;
  calendarId: string;
  /** Source trip identifier, when the feed provides one. */
  sourceTripId?: string;
  /** Stop times, in variant stop order. */
  stopTimes: MobilityStopTime[];
  /**
   * True when every intermediate stop time came from the source. False means
   * the exporter interpolated intermediate times with a documented model; the
   * UI must be able to surface that limitation.
   */
  complete: boolean;
}

/** One chunk of the spatial network index (geometry loaded around the camera). */
export interface MobilityChunkIndex {
  /** `"<cx>_<cy>"` using the manifest's `chunkSize`. */
  key: string;
  /** Chunk bounds `[minX, minY, maxX, maxY]`, claimed by exactly one chunk. */
  bounds: [number, number, number, number];
  /** Path relative to the mobility data base URL. */
  file: string;
  edges: number;
  stops: number;
  signals: number;
  /** Uncompressed payload size in bytes (loader budget/provenance). */
  bytes: number;
}

/** Runtime-checked chunk payload. */
export interface MobilityChunk {
  version: number;
  key: string;
  bounds: [number, number, number, number];
  edges: MobilityEdge[];
  stops: MobilityStop[];
  signals: MobilitySignalNode[];
}

/** Compact route index entry; the full variant lives in its own file. */
export interface MobilityRouteIndexEntry {
  id: string;
  mode: MobilityMode;
  ref: string;
  headSign: string;
  direction: 0 | 1;
  file: string;
  bounds: [number, number, number, number];
  lengthM: number;
  verified: boolean;
  stops: number;
  trips: number;
  /** Calendar ids used by this variant's trips. */
  calendars: string[];
}

/** Route variant payload with its trips. */
export interface MobilityRouteFile {
  version: number;
  variant: MobilityRouteVariant;
  trips: MobilityTrip[];
}

/** Provenance of one source snapshot (kept next to the runtime payload). */
export interface MobilityProvenance {
  /** Human readable source name, e.g. "OSM extract" / "Minsktrans schedule". */
  source: string;
  /** Source URL or local file path. */
  url: string;
  /** ISO date/time the snapshot was obtained. */
  retrievedAt: string;
  /** Licence / reuse terms as understood at retrieval time. */
  licence: string;
  /** Free-form limitations of this snapshot. */
  note?: string;
}

/**
 * Release identity. Two payloads with different triples must never be mixed;
 * the loader invalidates its cache when any component changes.
 */
export interface MobilityReleaseIdentity {
  network: string;
  schedule: string;
  bindings: string;
}

/** Whether the payload carries real, publishable public schedule times. */
export type MobilityScheduleStatus = 'ready' | 'partial' | 'unavailable' | 'synthetic' | 'absent';

/**
 * Model parameters for a procedurally generated timetable (whole-city demo).
 *
 * The runtime synthesises trips from these values instead of storing tens of
 * thousands of trip records in the payload. The data is explicitly a model, not
 * a licensed schedule: it is only used when `scheduleStatus === 'synthetic'` and
 * `timetableMode === 'procedural'`.
 */
export interface MobilitySyntheticTimetable {
  /** Model parameter set id, e.g. "city-demo-v1". */
  id: string;
  /** Departure interval per mode, seconds. */
  headwayS: Record<MobilityMode, number>;
  /** First departure of the service day, seconds after local midnight. */
  firstDepartureS: number;
  /** Last departure of the service day, seconds after local midnight. */
  lastDepartureS: number;
  /** Moving speed used to spread stops along the route, m/s. */
  cruiseMps: Record<MobilityMode, number>;
  /** Dwell time at each intermediate stop, seconds. */
  dwellS: Record<MobilityMode, number>;
  /**
   * Headway during the night window, seconds. The demo has NO hours without
   * transport: at night vehicles run less often instead of disappearing.
   */
  nightHeadwayS?: Record<MobilityMode, number>;
  /** Night window start, seconds after midnight (default 23:00). */
  nightStartS?: number;
  /** Night window end, seconds after midnight (default 05:30); wraps midnight. */
  nightEndS?: number;
  /** Calendar id the generated trips refer to (must exist in `calendars`). */
  calendarId: string;
}

/** Root of `public/data/mobility/manifest.json`. */
export interface MobilityManifest {
  version: number;
  generatedAt: string;
  /** Projection of local metres (matches the tile manifest). */
  epsg: number;
  /** UTM 35N easting/northing that maps to local (0, 0). */
  originUtm: [number, number];
  /** Spatial chunk edge in metres (independent of the tile payload size). */
  chunkSize: number;
  /** Covered extent `[minX, minY, maxX, maxY]`; outside is simply not simulated. */
  bounds: [number, number, number, number];
  chunks: MobilityChunkIndex[];
  routes: MobilityRouteIndexEntry[];
  /** Signal nodes indexed by position so the loader can subscribe by camera. */
  signalNodes: { id: string; x: number; y: number; chunk: string }[];
  calendars: MobilityServiceCalendar[];
  release: MobilityReleaseIdentity;
  provenance: MobilityProvenance[];
  /**
   * Honest state of the timetable in this release. `unavailable`/`absent` mean
   * the routes have verified geometry but no public schedule: the UI must say so
   * instead of presenting an empty day as "no trips right now". `synthetic`
   * marks an explicitly non-public QA timetable.
   */
  scheduleStatus: MobilityScheduleStatus;
  /** Why the timetable is not `ready` (source terms, missing period, …). */
  scheduleNote?: string;
  /**
   * How the timetable is produced. `stored` — trips are in the route files
   * (verified snapshot); `procedural` — the runtime synthesises trips from
   * `syntheticTimetable` (whole-city demo). Absent means `stored`.
   */
  timetableMode?: 'stored' | 'procedural';
  /** Parameters for `procedural` timetables. */
  syntheticTimetable?: MobilitySyntheticTimetable;
  counts: {
    edges: number;
    stops: number;
    signalNodes: number;
    variants: number;
    trips: number;
    verifiedVariants: number;
  };
}

/* ------------------------------------------------------------------------- */
/* Coordinate helpers — shared by the loader, the logic and the QA scripts.   */
/* ------------------------------------------------------------------------- */

/** Local metres + height -> Three.js world position (x, y, z). */
export function mobilityLocalToWorld(
  localX: number,
  localY: number,
  heightM = 0,
  target: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): { x: number; y: number; z: number } {
  target.x = localX;
  target.y = heightM;
  target.z = -localY;
  return target;
}

/** Three.js world position -> local metres + height. */
export function mobilityWorldToLocal(
  worldX: number,
  worldZ: number,
  worldY = 0,
  target: { x: number; y: number; h: number } = { x: 0, y: 0, h: 0 },
): { x: number; y: number; h: number } {
  target.x = worldX;
  target.y = -worldZ;
  target.h = worldY;
  return target;
}

/** Number of vertices in a flat xyz polyline. */
export function mobilityVertexCount(points: number[]): number {
  return Math.floor(points.length / 3);
}

/**
 * Cumulative arc length of a flat xyz polyline. Horizontal distance is used:
 * heights describe a deck profile, they do not add to the driven distance.
 */
export function mobilityArcLengths(points: number[], out?: number[]): number[] {
  const count = mobilityVertexCount(points);
  const result = out && out.length === count ? out : new Array<number>(count);
  if (count === 0) return result;
  result[0] = 0;
  for (let i = 1; i < count; i += 1) {
    const dx = points[i * 3] - points[i * 3 - 3];
    const dy = points[i * 3 + 1] - points[i * 3 - 2];
    result[i] = result[i - 1] + Math.hypot(dx, dy);
  }
  return result;
}

/** Total length of a flat xyz polyline, metres. */
export function mobilityPolylineLength(points: number[], s?: number[]): number {
  if (s && s.length > 0) return s[s.length - 1];
  const count = mobilityVertexCount(points);
  let total = 0;
  for (let i = 1; i < count; i += 1) {
    total += Math.hypot(
      points[i * 3] - points[i * 3 - 3],
      points[i * 3 + 1] - points[i * 3 - 2],
    );
  }
  return total;
}

/** Sample position along a flat xyz polyline at arc length `distance` metres. */
export function mobilitySample(
  points: number[],
  s: number[],
  distance: number,
  target: { x: number; y: number; h: number; heading: number } = { x: 0, y: 0, h: 0, heading: 0 },
): { x: number; y: number; h: number; heading: number } {
  const count = mobilityVertexCount(points);
  if (count === 0) {
    target.x = 0;
    target.y = 0;
    target.h = 0;
    target.heading = 0;
    return target;
  }
  if (count === 1) {
    target.x = points[0];
    target.y = points[1];
    target.h = points[2];
    target.heading = 0;
    return target;
  }
  const length = s[s.length - 1] ?? mobilityPolylineLength(points);
  const clamped = Math.min(Math.max(distance, 0), length > 0 ? length : 0);
  // Binary search for the segment containing `clamped`.
  let low = 0;
  let high = count - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (s[mid] <= clamped) low = mid;
    else high = mid;
  }
  const s0 = s[low];
  const s1 = s[low + 1] ?? s0;
  const span = s1 - s0;
  const t = span > 1e-9 ? Math.min(Math.max((clamped - s0) / span, 0), 1) : 0;
  const ax = points[low * 3];
  const ay = points[low * 3 + 1];
  const ah = points[low * 3 + 2];
  const bx = points[high * 3];
  const by = points[high * 3 + 1];
  const bh = points[high * 3 + 2];
  target.x = ax + (bx - ax) * t;
  target.y = ay + (by - ay) * t;
  target.h = ah + (bh - ah) * t;
  const dx = bx - ax;
  const dy = by - ay;
  target.heading = Math.hypot(dx, dy) > 1e-9 ? Math.atan2(dy, dx) : 0;
  return target;
}

/* ------------------------------------------------------------------------- */
/* Runtime-facing status types (no React / Three.js dependencies).            */
/* ------------------------------------------------------------------------- */

/** Layered switch state controlled by the UI. */
export interface MobilitySettings {
  /** Kamera-visible transport bodies. Turning this off does not stop the clock. */
  vehiclesVisible: boolean;
  /** Signal heads geometry (rules keep running while hidden). */
  signalsVisible: boolean;
  /** QA overlay: flight ids, stop lines, active groups, conflict zones. */
  debug: boolean;
  /** Simulation pause (clock stops; the map remains interactive). */
  paused: boolean;
}

/** Data/availability state surfaced in the UI. */
export type MobilityDataState = 'idle' | 'loading' | 'ready' | 'partial' | 'error' | 'unavailable';

/** One clock/dataset status line for the control panel. */
export interface MobilityStatus {
  state: MobilityDataState;
  /** Timetable state of the loaded release (public / partial / synthetic / none). */
  scheduleStatus: MobilityScheduleStatus;
  /** Local (Europe/Minsk) service date of the clock, ISO date. */
  serviceDate: string;
  /** Seconds after service-day start. */
  serviceSeconds: number;
  /** Fixed QA date when the clock is overridden (`null` in normal operation). */
  fixedDate: string | null;
  /** Human readable release identity, e.g. "net 12ab34 · sched 2026-11-16". */
  release: string;
  /** Non-fatal problems: unverified variants, unmatched stops, stale data. */
  notes: string[];
  /** Number of variants that are actually simulated. */
  activeVariants: number;
  /** Number of trips scheduled for the current service day. */
  scheduledTrips: number;
  /** Trips currently drawn on the map / active in the simulation. */
  activeTrips: number;
  drawnTrips: number;
  blockedTrips: number;
  loadedChunks: number;
  loadedBytes: number;
  /** Signal nodes loaded near the camera / actually drawn this frame. */
  signalNodes: number;
  signalNodesDrawn: number;
  /** Simulation cost of the last window, milliseconds (p50). */
  simulationMs: number;
  templateBytes: number;
  instanceBytes: number;
}

/** Snapshot of the simulation for QA overlays and tests. */
export interface MobilityTripSnapshot {
  tripId: string;
  variantId: string;
  mode: MobilityMode;
  ref: string;
  /** Trip phase: running, holding at a stop, waiting at a signal, finished. */
  phase: 'moving' | 'braking' | 'dwelling' | 'waiting' | 'signal' | 'finished';
  /** Body-centre position, local metres. */
  x: number;
  y: number;
  h: number;
  /** Travel heading, radians CCW from +X. */
  heading: number;
  /** Current speed, m/s. */
  speed: number;
  /** Schedule delay in seconds (positive = late). */
  delayS: number;
  /** Index of the next stop call, -1 when the trip is finished. */
  nextStop: number;
  /** Mirrors `MobilityRouteVariant.id`; keeps QA dumps self-describing. */
  routeVariant: string;
  /** True when the body is drawn this frame (culling/budget). */
  drawn: boolean;
}

/** Optional trace hooks used by QA scripts and tests. */
export interface MobilityDebugDump {
  clock: { serviceDate: string; serviceSeconds: number; stepHz: number; paused: boolean };
  settings: MobilitySettings;
  status: MobilityStatus;
  trips: MobilityTripSnapshot[];
  signals: {
    nodeId: string;
    /** Node centre in local metres (QA camera framing). */
    x: number;
    y: number;
    /** Current aspect per group id. */
    aspects: Record<string, MobilityAspect>;
    /** Phase index inside the program. */
    phase: number;
    /** Occupied movement ids that have not cleared yet. */
    occupied: string[];
  }[];
  /** Feature ids the dynamic layer must never mutate (regression check). */
  staticFeatureIds?: FeatureId[];
}
