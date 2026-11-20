import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILDING_OVERRIDES,
  applyBuildingOverride,
  groundElevatedParts,
  scaleVolumesToHeight,
} from '../../../src/city/buildings/curatedOverrides';
import type { BuildingFeature } from '../../../src/shared/types';
import { makeBuilding, makeVolume, rectRing } from '../../fixtures/buildings';

describe('curated building overrides', () => {
  it('lowers w25326783 to the real 1-2 storey pavilion', () => {
    const building = makeBuilding(
      [makeVolume([rectRing(0, 0, 40, 20)], 0, 22, 'flat', 0)],
      { id: 'w25326783', archetype: 'stalin' },
    );
    const fixed = applyBuildingOverride(building);
    expect(fixed.height).toBe(BUILDING_OVERRIDES.w25326783?.height);
    expect(fixed.height).toBe(8);
    expect(fixed.archetype).toBe('stalin');
    expect(fixed.volumes[0].height).toBeCloseTo(8, 5);
  });

  it('keeps an elevated part anchored and only scales its span', () => {
    const building = makeBuilding(
      [
        makeVolume([rectRing(0, 0, 20, 20)], 0, 20, 'flat', 0),
        makeVolume([rectRing(5, 5, 15, 15)], 12, 20, 'flat', 0, { isPart: true }),
      ],
      { id: 'w25326783', archetype: 'stalin' },
    );
    const fixed = applyBuildingOverride(building);
    expect(fixed.volumes[1].minHeight).toBe(12);
    expect(fixed.volumes[1].height).toBeGreaterThanOrEqual(12.5);
    expect(fixed.volumes[1].height).toBeLessThanOrEqual(20);
  });

  it('returns unknown ids and curated landmarks untouched', () => {
    const plain = makeBuilding([makeVolume([rectRing(0, 0, 10, 10)], 0, 12, 'flat', 0)], {
      id: 'w1',
    });
    expect(applyBuildingOverride(plain)).toBe(plain);
    const landmark = makeBuilding([makeVolume([rectRing(0, 0, 10, 10)], 0, 22, 'flat', 0)], {
      id: 'w25326783',
    });
    landmark.landmark = 'national-library';
    expect(applyBuildingOverride(landmark)).toBe(landmark);
  });

  it('scales roof rise with the wall height', () => {
    const scaled = scaleVolumesToHeight(
      [makeVolume([rectRing(0, 0, 20, 12)], 0, 20, 'gabled', 5)],
      20,
      10,
    );
    expect(scaled[0].height).toBeCloseTo(10, 5);
    expect(scaled[0].roofHeight).toBeCloseTo(2.5, 5);
  });
});

describe('elevated parts without a base (ЖК «У Троицкого»)', () => {
  it('stretches an unsupported elevated part down to the ground', () => {
    const volumes = [
      makeVolume([rectRing(0, 0, 40, 20)], 0, 6, 'flat', 0),
      makeVolume([rectRing(5, 5, 15, 15)], 45, 50, 'flat', 0, { isPart: true }),
    ];
    const fixed = groundElevatedParts(volumes);
    expect(fixed[1].minHeight).toBe(0);
    expect(fixed[1].height).toBe(50);
    expect(fixed[0]).toBe(volumes[0]);
  });

  it('keeps a part that already stands on another volume', () => {
    const fixed = groundElevatedParts([
      makeVolume([rectRing(0, 0, 40, 20)], 0, 6, 'flat', 0),
      makeVolume([rectRing(5, 5, 15, 15)], 0, 30, 'flat', 0, { isPart: true }),
      makeVolume([rectRing(5, 5, 15, 15)], 30, 34, 'flat', 0, { isPart: true }),
    ]);
    expect(fixed[2].minHeight).toBe(30);
  });

  it('rebuilds the main mass from the real tile data and leaves nothing hanging', () => {
    const tile = JSON.parse(
      readFileSync(resolve(__dirname, '../../../public/data/city-tiles/-1_0.json'), 'utf8'),
    ) as { buildings: BuildingFeature[] };
    const source = tile.buildings.find((b) => b.id === 'w175398077');
    expect(source).toBeDefined();
    const elevated = (volumes: BuildingFeature['volumes']) =>
      volumes.filter((v) => v.minHeight > 0.5).length;
    expect(elevated(source!.volumes)).toBeGreaterThan(10);
    // The source outline body is only 6 m: the real mass is missing.
    const sourceBody = source!.volumes.filter((v) => !v.isPart);
    expect(Math.max(...sourceBody.map((v) => v.height))).toBeLessThanOrEqual(6);

    const fixed = applyBuildingOverride(source!);
    expect(elevated(fixed.volumes)).toBe(0);
    expect(fixed.height).toBe(source!.height);
    expect(fixed.volumes.filter((v) => v.isPart)).toHaveLength(
      source!.volumes.filter((v) => v.isPart).length,
    );
    const body = fixed.volumes.filter((v) => !v.isPart);
    expect(body.length).toBeGreaterThan(3);
    const area = (v: (typeof body)[number]) =>
      Math.abs(
        v.footprint[0].reduce((sum, p, i, ring) => {
          const q = ring[(i + 1) % ring.length];
          return sum + p[0] * q[1] - q[0] * p[1];
        }, 0),
      ) / 2;
    expect(body.reduce((sum, v) => sum + area(v), 0)).toBeGreaterThan(2800);
    expect(Math.min(...body.map((v) => v.height))).toBeGreaterThan(15);
    expect(Math.max(...body.map((v) => v.height))).toBeGreaterThan(60);
  });
});
