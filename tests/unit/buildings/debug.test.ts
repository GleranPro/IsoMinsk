import { describe, it } from 'vitest';
import { buildBuildingsMesh } from '../../../src/city/buildings/buildingsMesh';
import { decodeMesh, mixedRoofShapes } from '../../fixtures/buildings';

describe('debug3', () => {
  it('bad normal triangles', () => {
    const result = buildBuildingsMesh(mixedRoofShapes(), { facadeDetail: true });
    const tris = decodeMesh(result);
    for (const t of tris) {
      const n = t.vertices[0].normal;
      const dot = n[0] * t.geometricNormal[0] + n[1] * t.geometricNormal[1] + n[2] * t.geometricNormal[2];
      if (dot < 0.9999) {
        console.log('bad', dot, 'kind', t.faceKind, 'owner', t.owner, 'area', t.area3D, 'normal', n, 'geo', t.geometricNormal);
        console.log(
          t.vertices.map((v) => `(${v.position[0].toFixed(4)},${v.position[1].toFixed(4)},${v.position[2].toFixed(4)})`).join(' '),
        );
      }
    }
  });
});
