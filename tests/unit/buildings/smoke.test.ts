import { describe, it } from 'vitest';
import { buildBuildingsMesh } from '../../../src/city/buildings/buildingsMesh';
import {
  decodeMesh,
  domeBuilding,
  gabledHistoricBuilding,
  hippedBuilding,
  courtyardBuilding,
  lShapedBuilding,
  multiVolumeStalinBlock,
  pyramidalBuilding,
  skillionBuilding,
  squarePrismBuilding,
  smallKioskBuilding,
  complexRoofBuilding,
  mixedRoofShapes,
  syntheticTileBuildings,
  sumAreaXY,
} from '../../fixtures/buildings';

describe('smoke', () => {
  it('reports counts', () => {
    const cases: [string, any][] = [
      ['square', squarePrismBuilding()],
      ['kiosk', smallKioskBuilding()],
      ['L', lShapedBuilding()],
      ['courtyard', courtyardBuilding()],
      ['gabled', gabledHistoricBuilding()],
      ['hipped', hippedBuilding()],
      ['pyramid', pyramidalBuilding()],
      ['skillion', skillionBuilding()],
      ['dome', domeBuilding()],
      ['complex', complexRoofBuilding()],
    ];
    for (const [name, building] of cases) {
      for (const detail of [false, true]) {
        const result = buildBuildingsMesh([building], { facadeDetail: detail });
        const tris = decodeMesh(result);
        const kinds = new Map<number, number>();
        for (const t of tris) kinds.set(t.faceKind, (kinds.get(t.faceKind) ?? 0) + 1);
        const roof = tris.filter((t) => t.faceKind === 1 || t.faceKind === 5);
        const wall = tris.filter((t) => t.faceKind === 0 || t.faceKind === 2 || t.faceKind === 4);
        const area = sumAreaXY(roof);
        const height = Math.max(...tris.flatMap((t) => t.vertices.map((v) => v.position[1])));
        console.log(
          `${name} detail=${detail} tris=${result.triangleCount} kinds=${JSON.stringify([...kinds])} roofArea=${area.toFixed(2)} maxH=${height.toFixed(2)} wallTris=${wall.length} warnings=${JSON.stringify(result.warnings)}`,
        );
      }
    }
    const multi = buildBuildingsMesh([multiVolumeStalinBlock()], { facadeDetail: true });
    console.log('multi', multi.triangleCount, multi.warnings);
    const mixed = buildBuildingsMesh(mixedRoofShapes(), { facadeDetail: true });
    console.log('mixed', mixed.triangleCount, mixed.warnings);
    const tile = syntheticTileBuildings(300);
    const start = performance.now();
    const tileResult = buildBuildingsMesh(tile, { facadeDetail: true });
    const ms = performance.now() - start;
    console.log('perf 300 buildings', tileResult.triangleCount, 'tris', ms.toFixed(2), 'ms');
  });
});
