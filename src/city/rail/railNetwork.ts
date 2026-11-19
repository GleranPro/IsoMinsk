/**
 * Isometric Minsk — фоновая железнодорожная сеть.
 *
 * Чистая логика без Three.js: разбор payload `data/mobility/rail/network.json`,
 * выбор сегментов, сборка составов и сэмплирование позиции вдоль полилинии.
 * Слой рендера (`src/engine/rail/railTrafficLayer.ts`) только раскладывает
 * полученные позы по instanced-мешам.
 *
 * Payload — визуальная модель: расписания электричек и грузовых поездов нет,
 * поэтому составы идут по реальным участкам OSM без остановок. Сегменты —
 * отдельные OSM way-куски, не сшитые через стрелки; поезд заворачивается на
 * конце сегмента, что происходит за кадром почти для любой камеры.
 */

import { VEHICLE_DIMENSIONS, type VehicleModel } from '../mobility/vehicleGeometry';

export const RAIL_NETWORK_VERSION = 1;

export interface RailNetworkSegment {
  id: string;
  /** Length of the polyline in metres (as shipped by the exporter). */
  lengthM: number;
  /** Flat `[x0, y0, x1, y1, …]` local metres (x east, y north). */
  points: number[];
  /** Precomputed bounds `[minX, minY, maxX, maxY]`. */
  bounds: [number, number, number, number];
}

export interface RailNetwork {
  version: number;
  generatedAt: string;
  source: string;
  licence: string;
  note: string;
  segments: RailNetworkSegment[];
}

export type RailTrainKind = 'commuter' | 'freight';

/** Один вагон/секция состава. */
export interface RailUnit {
  model: VehicleModel;
  /** Distance from the train head to the unit's front, metres. */
  offsetM: number;
  lengthM: number;
  /** -1: cab faces backwards (tail cab car). */
  facing: 1 | -1;
}

export interface RailTrain {
  id: string;
  kind: RailTrainKind;
  segmentId: string;
  /** Metres per second (model parameter, not measured). */
  speedMps: number;
  /** Head position along the segment, metres (wraps). */
  distanceM: number;
  /** Offset at start, metres, used before the first update. */
  startDistanceM: number;
  units: RailUnit[];
  /** Total length including inter-unit gaps, metres. */
  lengthM: number;
}

export interface RailSample {
  x: number;
  y: number;
  /** Radians CCW from +X (east), local metres. */
  heading: number;
}

const UNIT_GAP_M = 0.65;

function assertFinite(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(message);
  return value;
}

/** Parse and validate the exported rail network (throws on bad data). */
export function parseRailNetwork(raw: unknown): RailNetwork {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('rail network must be an object');
  }
  const root = raw as Record<string, unknown>;
  if (assertFinite(root.version, 'rail network.version must be a number') !== RAIL_NETWORK_VERSION) {
    throw new Error(`unsupported rail network version: ${String(root.version)}`);
  }
  if (!Array.isArray(root.segments)) throw new Error('rail network.segments must be an array');
  const segments: RailNetworkSegment[] = [];
  for (const [index, entryRaw] of root.segments.entries()) {
    if (!entryRaw || typeof entryRaw !== 'object') {
      throw new Error(`rail network.segments[${index}] must be an object`);
    }
    const entry = entryRaw as Record<string, unknown>;
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new Error(`rail network.segments[${index}].id must be a string`);
    }
    if (!Array.isArray(entry.points) || entry.points.length < 4 || entry.points.length % 2 !== 0) {
      throw new Error(`rail network.segments[${index}].points must be a flat even array`);
    }
    const points: number[] = [];
    for (const value of entry.points) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`rail network.segments[${index}].points has a non-finite value`);
      }
      points.push(value);
    }
    const lengthM = polylineLength(points);
    if (lengthM < 1) throw new Error(`rail network.segments[${index}] is degenerate`);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let point = 0; point < points.length; point += 2) {
      minX = Math.min(minX, points[point]);
      maxX = Math.max(maxX, points[point]);
      minY = Math.min(minY, points[point + 1]);
      maxY = Math.max(maxY, points[point + 1]);
    }
    segments.push({
      id: entry.id,
      lengthM,
      points,
      bounds: [minX, minY, maxX, maxY],
    });
  }
  return {
    version: RAIL_NETWORK_VERSION,
    generatedAt: String(root.generatedAt ?? ''),
    source: String(root.source ?? ''),
    licence: String(root.licence ?? ''),
    note: String(root.note ?? ''),
    segments,
  };
}

/** Длина плоской полилинии, метры. */
export function polylineLength(points: readonly number[]): number {
  let length = 0;
  for (let index = 2; index < points.length; index += 2) {
    length += Math.hypot(points[index] - points[index - 2], points[index + 1] - points[index - 1]);
  }
  return length;
}

/**
 * Сэмпл вдоль полилинии на расстоянии `distance` от начала.
 * `distance` зажимается в `[0, length]`; направление — по ходу полилинии.
 */
export function sampleRailSegment(points: readonly number[], distance: number): RailSample {
  const total = polylineLength(points);
  const target = Math.max(0, Math.min(total, Number.isFinite(distance) ? distance : 0));
  let travelled = 0;
  for (let index = 2; index < points.length; index += 2) {
    const ax = points[index - 2];
    const ay = points[index - 1];
    const bx = points[index];
    const by = points[index + 1];
    const segment = Math.hypot(bx - ax, by - ay);
    if (segment <= 1e-9) continue;
    if (travelled + segment >= target) {
      const t = (target - travelled) / segment;
      return {
        x: ax + (bx - ax) * t,
        y: ay + (by - ay) * t,
        heading: Math.atan2(by - ay, bx - ax),
      };
    }
    travelled += segment;
  }
  const last = points.length - 2;
  return {
    x: points[last],
    y: points[last + 1],
    heading: Math.atan2(
      points[last + 1] - points[last - 1],
      points[last] - points[last - 2],
    ),
  };
}

function unit(model: VehicleModel, offsetM: number, facing: 1 | -1 = 1): RailUnit {
  return {
    model,
    offsetM,
    lengthM: VEHICLE_DIMENSIONS[model].lengthM,
    facing,
  };
}

/** Build one commuter consist: lead + motor car + reversed tail lead. */
export function commuterConsist(): RailUnit[] {
  const units: RailUnit[] = [];
  let offset = 0;
  for (const [model, facing] of [
    ['commuterLead', 1],
    ['commuterCar', 1],
    ['commuterLead', -1],
  ] as const) {
    units.push(unit(model, offset, facing));
    offset += VEHICLE_DIMENSIONS[model].lengthM + UNIT_GAP_M;
  }
  return units;
}

/** Build one freight consist: locomotive + six gondolas. */
export function freightConsist(wagons = 6): RailUnit[] {
  const units: RailUnit[] = [];
  let offset = 0;
  units.push(unit('freightLoco', offset, 1));
  offset += VEHICLE_DIMENSIONS.freightLoco.lengthM + UNIT_GAP_M;
  for (let index = 0; index < Math.max(1, wagons); index += 1) {
    units.push(unit('freightWagon', offset, 1));
    offset += VEHICLE_DIMENSIONS.freightWagon.lengthM + UNIT_GAP_M;
  }
  return units;
}

/** Total length of a consist (front of first unit to rear of last). */
export function consistLength(units: readonly RailUnit[]): number {
  if (units.length === 0) return 0;
  const last = units[units.length - 1];
  return last.offsetM + last.lengthM;
}

export interface BuildTrainsOptions {
  /** Maximum number of trains (default 12). */
  maxTrains?: number;
  /** Minimum segment length to receive a train (default 500 m). */
  minSegmentM?: number;
  /** Number of freight wagons per consist (default 6). */
  freightWagons?: number;
}

/**
 * Deterministically choose segments and build commuter/freight consists.
 * Longer segments get trains first; every second segment is commuter, the
 * rest freight, so both kinds are spread over the city.
 */
export function buildRailTrains(
  segments: readonly RailNetworkSegment[],
  options: BuildTrainsOptions = {},
): RailTrain[] {
  const maxTrains = Math.max(0, Math.floor(options.maxTrains ?? 12));
  const minSegment = Math.max(0, options.minSegmentM ?? 500);
  const candidates = [...segments]
    .filter((segment) => segment.lengthM >= minSegment)
    .sort((left, right) => {
      if (left.lengthM !== right.lengthM) return right.lengthM - left.lengthM;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    })
    .slice(0, maxTrains);
  const trains: RailTrain[] = [];
  candidates.forEach((segment, index) => {
    const kind: RailTrainKind = index % 2 === 0 ? 'commuter' : 'freight';
    const units = kind === 'commuter' ? commuterConsist() : freightConsist(options.freightWagons ?? 6);
    const lengthM = consistLength(units);
    // Start head far enough along that the whole train is on the segment.
    const startDistanceM = Math.min(
      segment.lengthM - 1,
      lengthM + 1 + ((index * 0.381 + 0.137) % 1) * Math.max(1, segment.lengthM - lengthM - 2),
    );
    trains.push({
      id: `train-${kind}-${index}`,
      kind,
      segmentId: segment.id,
      speedMps: kind === 'commuter' ? 15 : 10,
      distanceM: startDistanceM,
      startDistanceM,
      units,
      lengthM,
    });
  });
  return trains;
}

/**
 * Advance a train head by `dt` seconds. The head runs from `lengthM` to
 * `segment.lengthM`; then it wraps so the tail has fully left the segment.
 */
export function advanceRailTrain(train: RailTrain, segment: RailNetworkSegment, dt: number): void {
  const cycle = segment.lengthM + train.lengthM;
  const step = Math.max(0, Math.min(0.5, Number.isFinite(dt) ? dt : 0));
  train.distanceM = (train.distanceM + train.speedMps * step) % cycle;
  if (train.distanceM < train.lengthM) {
    // While wrapping, the head is before the tail exit point; keep the whole
    // consist past the start so units never pile up at the origin.
    train.distanceM = train.lengthM;
  }
}

/** Pose of one unit in local metres, or `null` when it is off the segment. */
export function railUnitPose(
  train: RailTrain,
  segment: RailNetworkSegment,
  unit: RailUnit,
): RailSample | null {
  const center = train.distanceM - unit.offsetM - unit.lengthM * 0.5;
  if (center < -unit.lengthM * 0.5 || center > segment.lengthM + unit.lengthM * 0.5) {
    return null;
  }
  const sample = sampleRailSegment(segment.points, center);
  return unit.facing === 1 ? sample : { ...sample, heading: sample.heading + Math.PI };
}
