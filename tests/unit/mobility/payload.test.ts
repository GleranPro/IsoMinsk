/**
 * Validation of the REAL exported mobility payload against the shared contract.
 *
 * These tests read `public/data/mobility/manifest.json` and every chunk/route
 * file it references. No fixture is fabricated: if the exporter has not produced
 * the payload yet, the suite is skipped with an explicit warning (same policy as
 * `tests/unit/data/tiles.test.ts`).
 *
 * `scripts/qa/mobility-audit.py` checks the same payload from the Python side;
 * this test is the contract-level guard that the runtime can actually consume
 * what the exporter wrote (versions, release identity, referenced files,
 * geometry/`s` agreement, route continuity, stop bindings, trip ordering).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MOBILITY_VERSION,
  type MobilityChunk,
  type MobilityManifest,
  type MobilityPolyline,
  type MobilityRouteFile,
  mobilityPolylineLength,
} from '../../../src/shared/mobility';

const BASE = path.resolve(__dirname, '../../../public/data/mobility');
const MANIFEST_PATH = path.join(BASE, 'manifest.json');
const HAS_PAYLOAD = existsSync(MANIFEST_PATH);

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(BASE, file), 'utf8')) as T;
}

/** Vertex count of a flat xyz polyline. */
function vertices(points: number[]): number {
  return Math.floor(points.length / 3);
}

/** Assert one polyline is internally consistent; returns its arc length. */
function checkPolyline(label: string, polyline: MobilityPolyline | undefined): number {
  expect(polyline, `${label}: polyline is missing`).toBeTruthy();
  const points = polyline!.p;
  const distances = polyline!.s;
  expect(Array.isArray(points), `${label}: p must be an array`).toBe(true);
  expect(Array.isArray(distances), `${label}: s must be an array`).toBe(true);
  expect(points.length % 3, `${label}: p must hold xyz triples`).toBe(0);
  const count = vertices(points);
  expect(count, `${label}: at least one vertex`).toBeGreaterThan(0);
  expect(distances.length, `${label}: s must match the vertex count`).toBe(count);
  expect(distances[0], `${label}: s must start at 0`).toBeCloseTo(0, 6);
  for (const value of points) expect(Number.isFinite(value), `${label}: finite coordinates`).toBe(true);
  for (let index = 1; index < count; index += 1) {
    expect(distances[index], `${label}: s must not decrease at ${index}`).toBeGreaterThanOrEqual(
      distances[index - 1] - 1e-9,
    );
  }
  // Recorded arc length must agree with the geometry (1 % for 1 cm rounding).
  const measured = mobilityPolylineLength(points);
  const recorded = distances[distances.length - 1];
  if (measured > 1) {
    expect(Math.abs(recorded - measured), `${label}: arc length disagrees with geometry`).toBeLessThan(
      Math.max(0.5, measured * 0.01),
    );
  }
  return recorded;
}

describe('mobility payload', () => {
  if (!HAS_PAYLOAD) {
    it.skip('exported mobility payload is absent — run scripts/mobility/export.py', () => {
      // The skip is intentional and reported by vitest; never invent payloads.
    });
    return;
  }

  const manifest = readJson<MobilityManifest>('manifest.json');

  it('declares the contract version and a complete release identity', () => {
    expect(manifest.version).toBe(MOBILITY_VERSION);
    expect(manifest.epsg).toBe(32635);
    expect(Array.isArray(manifest.originUtm)).toBe(true);
    expect(manifest.originUtm).toHaveLength(2);
    expect(manifest.chunkSize).toBeGreaterThan(0);
    expect(manifest.bounds).toHaveLength(4);
    expect(manifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    for (const part of ['network', 'schedule', 'bindings'] as const) {
      expect(typeof manifest.release[part], `release.${part} must be recorded`).toBe('string');
      expect(manifest.release[part].length).toBeGreaterThan(0);
    }
    expect(manifest.provenance.length).toBeGreaterThan(0);
    expect(['ready', 'partial', 'unavailable', 'synthetic', 'absent']).toContain(manifest.scheduleStatus);
    // An empty timetable must never be advertised as a ready public schedule.
    if (manifest.counts.trips === 0) {
      expect(manifest.scheduleStatus === 'ready', 'zero trips must not be scheduleStatus=ready').toBe(false);
    }
  });

  it('indexes every chunk file with matching byte size and counts', () => {
    expect(manifest.chunks.length).toBeGreaterThan(0);
    const keys = new Set<string>();
    for (const entry of manifest.chunks) {
      expect(entry.key).toMatch(/^-?\d+_-?\d+$/);
      expect(keys.has(entry.key), `duplicate chunk key ${entry.key}`).toBe(false);
      keys.add(entry.key);
      const file = path.join(BASE, entry.file);
      expect(existsSync(file), `chunk file missing: ${entry.file}`).toBe(true);
      expect(statSync(file).size, `chunk bytes mismatch: ${entry.file}`).toBe(entry.bytes);
    }
  });

  it('keeps chunk payloads consistent with the manifest and the contract', () => {
    const edgeIds = new Set<string>();
    for (const entry of manifest.chunks) {
      const chunk = readJson<MobilityChunk>(entry.file);
      expect(chunk.version, `${entry.file}: version`).toBe(MOBILITY_VERSION);
      expect(chunk.key, `${entry.file}: key`).toBe(entry.key);
      expect(chunk.edges.length, `${entry.file}: edge count`).toBe(entry.edges);
      expect(chunk.stops.length, `${entry.file}: stop count`).toBe(entry.stops);
      expect(chunk.signals.length, `${entry.file}: signal count`).toBe(entry.signals);
      for (const edge of chunk.edges) {
        expect(edgeIds.has(edge.id), `duplicate edge id ${edge.id}`).toBe(false);
        edgeIds.add(edge.id);
        expect(typeof edge.wayId).toBe('number');
        expect(edge.from).toBeTruthy();
        expect(edge.to).toBeTruthy();
        expect(edge.widthM).toBeGreaterThan(0);
        expect(typeof edge.layer).toBe('number');
        expect(edge.lanes.length, `${edge.id}: lanes`).toBeGreaterThan(0);
        const length = checkPolyline(`${edge.id}.centerline`, edge.centerline);
        for (const lane of edge.lanes) {
          expect(lane.widthM, `${edge.id}: lane width`).toBeGreaterThan(0);
          if (lane.centerline && lane.centerline.p.length > 0) {
            checkPolyline(`${edge.id}.lane${lane.index}`, lane.centerline);
          }
          expect(lane.offset).toBeTypeOf('number');
        }
        expect(length).toBeGreaterThan(0);
      }
      for (const stop of chunk.stops) {
        expect(Number.isFinite(stop.x) && Number.isFinite(stop.y), `${stop.id}: finite position`).toBe(true);
        expect(stop.modes.length, `${stop.id}: modes`).toBeGreaterThan(0);
      }
      for (const node of chunk.signals) {
        expect(node.groups.length, `${node.id}: groups`).toBeGreaterThan(0);
        expect(node.movements.length, `${node.id}: movements`).toBeGreaterThan(0);
        expect(node.program.phases.length, `${node.id}: phases`).toBeGreaterThan(0);
        for (const movement of node.movements) {
          expect(movement.group, `${node.id}/${movement.id}: group index`).toBeGreaterThanOrEqual(0);
          expect(movement.group, `${node.id}/${movement.id}: group index`).toBeLessThan(node.groups.length);
          checkPolyline(`${node.id}/${movement.id}.path`, movement.path);
        }
        for (const stopLine of node.stopLines) {
          expect(node.movements[stopLine.movement], `${node.id}: stop line movement`).toBeTruthy();
        }
        for (const head of node.heads) {
          expect(head.group, `${node.id}/${head.id}: head group`).toBeGreaterThanOrEqual(0);
          expect(head.group, `${node.id}/${head.id}: head group`).toBeLessThan(node.groups.length);
        }
        // A phase must never release two conflicting movements together.
        for (const phase of node.program.phases) {
          const green = new Set(phase.green);
          for (const [first, second] of node.conflicts) {
            expect(
              green.has(first) && green.has(second),
              `${node.id}: phase releases conflicting movements ${first} and ${second}`,
            ).toBe(false);
          }
        }
      }
    }
    // Route variants reference edges by id: the index must be complete up front.
    expect(edgeIds.size).toBeGreaterThan(0);
  });

  it('exports route variants with continuous geometry and bound stops', () => {
    const edgeIndex = new Map<string, { from: string; to: string; length: number; lanes: number[] }>();
    for (const entry of manifest.chunks) {
      const chunk = readJson<MobilityChunk>(entry.file);
      for (const edge of chunk.edges) {
        const edgeLength = edge.centerline.s[edge.centerline.s.length - 1] ?? 0;
        edgeIndex.set(edge.id, {
          from: edge.from,
          to: edge.to,
          length: edgeLength,
          // A lane's own centreline can be slightly longer than the edge
          // centreline (offset in a curve); stop calls use the lane length.
          lanes: edge.lanes.map((lane) =>
            lane.centerline && lane.centerline.s.length > 0
              ? (lane.centerline.s[lane.centerline.s.length - 1] ?? edgeLength)
              : edgeLength,
          ),
        });
      }
    }
    const calendars = new Set(manifest.calendars.map((calendar) => calendar.id));
    expect(manifest.routes.length).toBeGreaterThan(0);
    for (const entry of manifest.routes) {
      const payload = readJson<MobilityRouteFile>(entry.file);
      expect(payload.version, `${entry.file}: version`).toBe(MOBILITY_VERSION);
      expect(payload.variant.id, `${entry.file}: variant id`).toBe(entry.id);
      expect(payload.variant.verified, `${entry.file}: verified flag`).toBe(entry.verified);
      expect(payload.variant.stops.length, `${entry.file}: stop count`).toBe(entry.stops);
      expect(payload.trips.length, `${entry.file}: trip count`).toBe(entry.trips);
      let previous: { from: string; to: string } | null = null;
      for (const edgeId of payload.variant.edges) {
        const edge = edgeIndex.get(edgeId);
        expect(edge, `${entry.id}: edge ${edgeId} is not in any chunk`).toBeTruthy();
        if (previous) {
          expect(edge!.to, `${entry.id}: edge ${edgeId} continues ${previous.to}`).toBeTruthy();
          expect(edge!.from, `${entry.id}: discontinuity at ${edgeId}`).toBe(previous.to);
        }
        previous = edge!;
      }
      payload.variant.stops.forEach((call, position) => {
        expect(call.seq, `${entry.id}: stop ${position} seq`).toBe(position);
        const edge = edgeIndex.get(call.edgeId);
        expect(edge, `${entry.id}: stop ${position} edge ${call.edgeId}`).toBeTruthy();
        expect(call.laneIndex, `${entry.id}: stop ${position} lane index`).toBeGreaterThanOrEqual(0);
        expect(call.laneIndex, `${entry.id}: stop ${position} lane index`).toBeLessThan(edge!.lanes.length);
        expect(call.s, `${entry.id}: stop ${position} s`).toBeGreaterThanOrEqual(0);
        expect(call.s, `${entry.id}: stop ${position} s beyond lane`).toBeLessThanOrEqual(
          (edge!.lanes[call.laneIndex] ?? edge!.length) + 1e-6,
        );
        expect(Number.isFinite(call.x) && Number.isFinite(call.y), `${entry.id}: stop ${position} position`).toBe(
          true,
        );
      });
      for (const trip of payload.trips) {
        expect(calendars.has(trip.calendarId), `${entry.id}/${trip.id}: calendar`).toBe(true);
        expect(trip.variantId, `${entry.id}/${trip.id}: variant id`).toBe(payload.variant.id);
        if (trip.stopTimes.length > 0) {
          expect(trip.stopTimes.length, `${entry.id}/${trip.id}: stop times`).toBe(payload.variant.stops.length);
        }
        trip.stopTimes.forEach((stopTime, position) => {
          expect(stopTime.seq, `${entry.id}/${trip.id}: seq`).toBe(position);
          expect(stopTime.departureS, `${entry.id}/${trip.id}: departs before arrival`).toBeGreaterThanOrEqual(
            stopTime.arrivalS - 1e-6,
          );
          if (position > 0) {
            expect(
              stopTime.arrivalS,
              `${entry.id}/${trip.id}: arrival runs backwards at ${position}`,
            ).toBeGreaterThanOrEqual(trip.stopTimes[position - 1].arrivalS - 1e-6);
          }
        });
      }
    }
  });

  it('indexes signal nodes with stable ids and positions', () => {
    const seen = new Set<string>();
    for (const entry of manifest.signalNodes) {
      expect(seen.has(entry.id), `duplicate signal node ${entry.id}`).toBe(false);
      seen.add(entry.id);
      expect(Number.isFinite(entry.x) && Number.isFinite(entry.y)).toBe(true);
      expect(manifest.chunks.some((chunk) => chunk.key === entry.chunk), `${entry.id}: chunk key`).toBe(true);
    }
    for (const calendar of manifest.calendars) {
      expect(calendar.timeZone, `${calendar.id}: time zone`).toBeTruthy();
      expect(calendar.weekdays.length, `${calendar.id}: weekdays`).toBeGreaterThan(0);
      expect(calendar.startDate <= calendar.endDate, `${calendar.id}: period`).toBe(true);
    }
  });
});
