/**
 * Mobility contract helpers — pure math shared by the loader, the simulation and
 * the QA scripts. A wrong sampling convention here silently misplaces every
 * vehicle, so the helpers are pinned by dedicated tests.
 */

import { describe, expect, it } from 'vitest';
import {
  MOBILITY_VERSION,
  mobilityArcLengths,
  mobilityLocalToWorld,
  mobilityPolylineLength,
  mobilitySample,
  mobilityVertexCount,
  mobilityWorldToLocal,
} from '../../../src/shared/mobility';

describe('mobility contract', () => {
  it('keeps the payload version pinned to a single value', () => {
    expect(MOBILITY_VERSION).toBe(1);
  });

  it('maps local metres to world with north = -Z and back again', () => {
    const world = mobilityLocalToWorld(120, 340, 6.5);
    expect(world.x).toBe(120);
    expect(world.y).toBe(6.5);
    expect(world.z).toBe(-340);
    const local = mobilityWorldToLocal(world.x, world.z, world.y);
    expect(local.x).toBe(120);
    expect(local.y).toBe(340);
    expect(local.h).toBe(6.5);
  });

  it('reuses the provided target object instead of allocating', () => {
    const target = { x: 0, y: 0, z: 0 };
    expect(mobilityLocalToWorld(1, 2, 3, target)).toBe(target);
  });

  it('counts vertices in a flat xyz polyline', () => {
    expect(mobilityVertexCount([])).toBe(0);
    expect(mobilityVertexCount([0, 0, 0])).toBe(1);
    expect(mobilityVertexCount([0, 0, 0, 3, 4, 0])).toBe(2);
    // A trailing partial vertex is not a vertex.
    expect(mobilityVertexCount([0, 0, 0, 3, 4])).toBe(1);
  });

  it('accumulates horizontal arc length and ignores height changes', () => {
    // 3-4-5 triangle in plan, with a 10 m height rise that must not add length.
    const points = [0, 0, 0, 3, 4, 10, 3 + 0, 4 + 12, 0];
    const s = mobilityArcLengths(points);
    expect(s).toEqual([0, 5, 17]);
    expect(mobilityPolylineLength(points)).toBeCloseTo(17, 9);
    expect(mobilityPolylineLength(points, s)).toBeCloseTo(17, 9);
  });

  it('samples at the ends, the joints and the middle of a segment', () => {
    const points = [0, 0, 0, 10, 0, 2, 10, 10, 2];
    const s = mobilityArcLengths(points);

    const start = mobilitySample(points, s, 0);
    expect(start).toMatchObject({ x: 0, y: 0, h: 0 });
    expect(start.heading).toBeCloseTo(0, 9);

    const joint = mobilitySample(points, s, 10);
    expect(joint.x).toBeCloseTo(10, 9);
    expect(joint.y).toBeCloseTo(0, 9);
    expect(joint.h).toBeCloseTo(2, 9);

    const middle = mobilitySample(points, s, 5);
    expect(middle.x).toBeCloseTo(5, 9);
    expect(middle.y).toBeCloseTo(0, 9);
    expect(middle.h).toBeCloseTo(1, 9);
    expect(middle.heading).toBeCloseTo(0, 9);

    const second = mobilitySample(points, s, 15);
    expect(second.x).toBeCloseTo(10, 9);
    expect(second.y).toBeCloseTo(5, 9);
    expect(second.h).toBeCloseTo(2, 9);
    expect(second.heading).toBeCloseTo(Math.PI / 2, 9);
  });

  it('clamps out-of-range distances instead of extrapolating off the path', () => {
    const points = [0, 0, 0, 10, 0, 0];
    const s = mobilityArcLengths(points);
    expect(mobilitySample(points, s, -5).x).toBe(0);
    const past = mobilitySample(points, s, 99);
    expect(past.x).toBe(10);
    expect(past.y).toBe(0);
  });

  it('survives degenerate polylines', () => {
    const empty = mobilitySample([], [], 0);
    expect(empty).toEqual({ x: 0, y: 0, h: 0, heading: 0 });

    const single = mobilitySample([4, 5, 6], [0], 3);
    expect(single).toEqual({ x: 4, y: 5, h: 6, heading: 0 });

    // Two identical vertices: no direction, no NaN.
    const doubled = mobilitySample([2, 2, 0, 2, 2, 0], [0, 0], 1);
    expect(doubled.x).toBe(2);
    expect(Number.isFinite(doubled.heading)).toBe(true);
  });

  it('writes into the provided sample target', () => {
    const target = { x: 0, y: 0, h: 0, heading: 0 };
    expect(mobilitySample([0, 0, 0, 1, 0, 0], [0, 1], 0.5, target)).toBe(target);
    expect(target.x).toBeCloseTo(0.5, 9);
  });
});
