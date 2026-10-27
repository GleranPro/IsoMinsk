/* Temporary diagnostic script (deleted after use): measure real-tile environment builds. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TileData } from '../../../src/shared/types';
import { buildEnvironmentMeshes } from '../../../src/city/environment/environmentMeshes';

const dir = path.resolve('public/data/tiles');
const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
  .sort();

const rows: Array<Record<string, unknown>> = [];
let total = { ground: 0, roads: 0, trees: 0, all: 0 };
let maxAll = 0;
let maxAllFile = '';
const started = performance.now();

for (const file of files) {
  const tile = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as TileData;
  const before = performance.now();
  const result = buildEnvironmentMeshes(tile, { tileBounds: tile.bounds, trees: true });
  const ms = performance.now() - before;
  const counts = result.counts!;
  const roadStats = counts.roads;
  const roadGeometryTriangles =
    roadStats.roadTriangles +
    roadStats.pavementTriangles +
    roadStats.railTriangles +
    roadStats.kerbTriangles +
    roadStats.markingTriangles;
  total.ground += counts.groundTriangles;
  total.roads += roadGeometryTriangles;
  total.trees += counts.treeTriangles;
  total.all += result.triangleCount;
  if (result.triangleCount > maxAll) {
    maxAll = result.triangleCount;
    maxAllFile = file;
  }
  rows.push({
    file,
    surfaces: tile.surfaces.length,
    roads: tile.roads.length,
    trees: tile.trees.length,
    ground: counts.groundTriangles,
    roadGeometryTriangles,
    surfaceRoad: roadStats.roadTriangles,
    pavement: roadStats.pavementTriangles,
    rail: roadStats.railTriangles,
    kerb: roadStats.kerbTriangles,
    marking: roadStats.markingTriangles,
    tree: counts.treeTriangles,
    total: result.triangleCount,
    gPlusR: counts.groundTriangles + roadGeometryTriangles,
    waterBands: counts.surfaces.waterBands,
    dashes: roadStats.dashes,
    railSegments: roadStats.railSegments,
    bridges: roadStats.bridges,
    skipped: counts.skippedPolygons,
    treeLod: counts.treeLod,
    ms: Math.round(ms * 100) / 100,
  });
}

const totalMs = performance.now() - started;
console.log(JSON.stringify(rows, null, 1));
console.log('TOTALS', JSON.stringify(total), 'maxTile', maxAllFile, maxAll, 'buildTotalMs', Math.round(totalMs));
