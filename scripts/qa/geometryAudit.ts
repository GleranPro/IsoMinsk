// Lead's building-geometry audit: validates the real tile payload through the
// building mesh builder (no browser needed). Run with: pnpm exec tsx scripts/qa/geometryAudit.ts
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { buildBuildingsMesh } from '../../src/city/buildings/buildingsMesh';
import { buildEnvironmentMeshes } from '../../src/city/environment/environmentMeshes';
import type { TileData, TileManifest } from '../../src/shared/types';

const TILE_DIR = 'public/data/tiles';
const manifest: TileManifest = JSON.parse(readFileSync(join(TILE_DIR, 'manifest.json'), 'utf8'));

interface Audit {
  tile: string;
  buildings: number;
  triangles: number;
  invalid: string[];
  roofTriangles: number;
  wallTriangles: number;
  minY: number;
  maxY: number;
  nanCount: number;
  envTriangles: number;
  trees: number;
  /** Payload 0.3.0 road layer counts (per tile). */
  roadSurfaces: number;
  roadNetwork: number;
  junctions: number;
  crossings: number;
}

const results: Audit[] = [];
const globalIssues: string[] = [];

function attrArray(geometry: THREE.BufferGeometry, name: string): Float32Array | null {
  const attr = geometry.getAttribute(name) as THREE.BufferAttribute | undefined;
  return attr ? (attr.array as Float32Array) : null;
}

for (const entry of manifest.tiles) {
  const tile = JSON.parse(readFileSync(join(TILE_DIR, entry.file.split('/').pop()!), 'utf8')) as TileData;
  const result = buildBuildingsMesh(tile.buildings, { facadeDetail: true });
  const positions = attrArray(result.geometry, 'position')!;
  const faces = attrArray(result.geometry, 'aFace');
  const normals = attrArray(result.geometry, 'normal');
  const uvs = attrArray(result.geometry, 'aUV');
  const invalid: string[] = [];
  let nanCount = 0;
  let roofTriangles = 0;
  let wallTriangles = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) nanCount++;
    if (i % 3 === 1) {
      minY = Math.min(minY, positions[i]);
      maxY = Math.max(maxY, positions[i]);
    }
  }
  if (faces) {
    for (let i = 0; i < faces.length; i += 12) {
      for (let v = 0; v < 3; v++) {
        const kind = faces[i + v * 4];
        if (kind === 1 || kind === 5) roofTriangles++;
        else if (kind === 0 || kind === 2) wallTriangles++;
      }
    }
  }
  if (!normals) invalid.push('missing normals');
  if (!uvs) invalid.push('missing aUV');
  if (!faces) invalid.push('missing aFace');
  if (nanCount) invalid.push(`${nanCount} NaN position components`);
  if (!result.triangleOwner || result.triangleOwner.length !== result.triangleCount) {
    invalid.push(`triangleOwner mismatch ${result.triangleOwner?.length} vs ${result.triangleCount}`);
  }
  if (result.buildingIds.length !== tile.buildings.length) {
    invalid.push(`buildingIds ${result.buildingIds.length} vs buildings ${tile.buildings.length}`);
  }
  if (result.triangleCount === 0 && tile.buildings.length > 0) invalid.push('no triangles emitted');
  if (minY < -0.01) invalid.push(`geometry below ground: ${minY.toFixed(2)}`);

  // Payload 0.3.0: the normalized surface partition always accompanies the
  // semantic network layer; a tile with centrelines but no rendered surface
  // would generate markings over the ground plate.
  const roadSurfaces = tile.roadSurfaces ?? [];
  const roadNetwork = tile.roadNetwork ?? [];
  const junctions = tile.junctions ?? [];
  const crossings = tile.crossings ?? [];
  if (roadNetwork.length > 0 && roadSurfaces.length === 0) {
    invalid.push(`roadNetwork has ${roadNetwork.length} piece(s) but roadSurfaces is empty`);
  }

  const env = buildEnvironmentMeshes(tile, { tileBounds: tile.bounds, trees: true });
  const envTriangles =
    (env.ground.index ? env.ground.index.count / 3 : env.ground.getAttribute('position').count / 3) +
    (env.roads.index ? env.roads.index.count / 3 : env.roads.getAttribute('position').count / 3) +
    (env.trees ? (env.trees.index ? env.trees.index.count / 3 : env.trees.getAttribute('position').count / 3) : 0);

  results.push({
    tile: `${tile.tileX}_${tile.tileY}`,
    buildings: tile.buildings.length,
    triangles: result.triangleCount,
    invalid,
    roofTriangles,
    wallTriangles,
    minY: Number.isFinite(minY) ? minY : 0,
    maxY: Number.isFinite(maxY) ? maxY : 0,
    nanCount,
    envTriangles,
    trees: tile.trees.length,
    roadSurfaces: roadSurfaces.length,
    roadNetwork: roadNetwork.length,
    junctions: junctions.length,
    crossings: crossings.length,
  });
  for (const issue of invalid) globalIssues.push(`${tile.tileX}_${tile.tileY}: ${issue}`);
}

const totals = {
  buildings: results.reduce((s, r) => s + r.buildings, 0),
  triangles: results.reduce((s, r) => s + r.triangles, 0),
  envTriangles: results.reduce((s, r) => s + r.envTriangles, 0),
  roofTriangles: results.reduce((s, r) => s + r.roofTriangles, 0),
  wallTriangles: results.reduce((s, r) => s + r.wallTriangles, 0),
  trees: results.reduce((s, r) => s + r.trees, 0),
  roadSurfaces: results.reduce((s, r) => s + r.roadSurfaces, 0),
  roadNetwork: results.reduce((s, r) => s + r.roadNetwork, 0),
  junctions: results.reduce((s, r) => s + r.junctions, 0),
  crossings: results.reduce((s, r) => s + r.crossings, 0),
};

console.log('Per-tile:');
for (const r of results) {
  console.log(
    `  ${r.tile.padEnd(5)} bld=${String(r.buildings).padStart(3)} tris=${String(r.triangles).padStart(6)} ` +
      `roof=${String(r.roofTriangles).padStart(5)} wall=${String(r.wallTriangles).padStart(5)} ` +
      `env=${String(r.envTriangles).padStart(6)} trees=${String(r.trees).padStart(3)} ` +
      `roads=${String(r.roadSurfaces).padStart(3)}/${String(r.roadNetwork).padStart(3)} ` +
      `jct=${String(r.junctions).padStart(2)} xing=${String(r.crossings).padStart(2)} ` +
      `y=[${r.minY.toFixed(1)},${r.maxY.toFixed(1)}]${r.invalid.length ? ' ISSUES: ' + r.invalid.join('; ') : ''}`,
  );
}
console.log('\nTotals:', JSON.stringify(totals));
console.log(
  'Road payload: ' +
    `${totals.roadSurfaces} surface piece(s), ${totals.roadNetwork} network piece(s), ` +
    `${totals.junctions} junction record(s) (tile-duplicated), ${totals.crossings} crossing(s)`,
);
console.log('Triangle per building:', (totals.triangles / Math.max(1, totals.buildings)).toFixed(1));
if (globalIssues.length) {
  console.log(`\n${globalIssues.length} ISSUE(S):`);
  for (const issue of globalIssues.slice(0, 40)) console.log('  - ' + issue);
  process.exitCode = 1;
} else {
  console.log('\nGEOMETRY AUDIT PASSED');
}

mkdirSync('screenshots', { recursive: true });
writeFileSync('screenshots/geometry-audit.json', JSON.stringify({ totals, results }, null, 1));

