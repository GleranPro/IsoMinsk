import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { LightingRig } from '../../../src/engine/renderer/lighting';

describe('winter lighting preset', () => {
  it('lowers and cools the daylight sun, restoring the summer rig at 0', () => {
    const scene = new THREE.Scene();
    const rig = new LightingRig(scene, 512);
    rig.setTimeOfDay(13);
    const baseElevation = rig.getSunElevationDeg();
    const baseAmbient = rig.ambient.color.clone();
    expect(baseElevation).toBeGreaterThanOrEqual(40);

    rig.setSeasonWinter(1);
    expect(rig.getSeasonWinter()).toBe(1);
    // Lower sun -> longer shadows; the clamp keeps it at 26-31°.
    expect(rig.getSunElevationDeg()).toBeLessThan(baseElevation);
    expect(rig.getSunElevationDeg()).toBeLessThanOrEqual(31.1);
    // Colder fill: the blue/red ratio rises versus the warm summer ambient.
    const winterAmbient = rig.ambient.color;
    expect(winterAmbient.b / Math.max(winterAmbient.r, 1e-6))
      .toBeGreaterThan(baseAmbient.b / Math.max(baseAmbient.r, 1e-6));

    rig.setSeasonWinter(0);
    expect(rig.getSunElevationDeg()).toBeCloseTo(baseElevation, 5);
    expect(rig.ambient.color.getHex()).toBe(baseAmbient.getHex());
    rig.dispose();
  });

  it('keeps the night light direction: no 26° "day" sun after sunset', () => {
    const scene = new THREE.Scene();
    const rig = new LightingRig(scene, 512);
    rig.setTimeOfDay(23);
    const base = rig.getSunElevationDeg();
    rig.setSeasonWinter(1);
    expect(rig.getSunElevationDeg()).toBeCloseTo(base, 5);
    rig.dispose();
  });
});
