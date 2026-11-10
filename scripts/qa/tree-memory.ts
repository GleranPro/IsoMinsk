/** Exact tree-buffer comparison on the same input tiles (no WebGL required). */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildTreeGeometry } from '../../src/city/environment/treeMeshes';
import { buildTreeInstances, TREE_STYLES, treeInstanceBytes } from '../../src/city/environment/treeInstances';
import { mergeEnvironmentGeometries } from '../../src/engine/tiles/tileBuild';
import { packGeometry } from '../../src/engine/tiles/serialization';
import { TreeTemplateCache } from '../../src/engine/tiles/instancedTrees';
import type { TileData, TileManifest } from '../../src/shared/types';

const dataset = process.argv[2] === 'central' ? 'central' : 'city';
const base = path.resolve('public/data', dataset === 'city' ? 'city-tiles' : 'tiles');
const manifest: TileManifest = JSON.parse(readFileSync(path.join(base, 'manifest.json'), 'utf8'));
let legacyBytes = 0, legacyTriangles = 0, count = 0;
const styles = TREE_STYLES.map(style => ({ style, count: 0, instanceBytes: 0, templateBytes: 0,
  triangles: 0, batches: 0, reductionPercent: 0, cache: new TreeTemplateCache() }));
for (const entry of manifest.tiles) {
  let file = path.join(base, entry.file);
  // Central's manifest may retain the pipeline's tiles/ prefix.
  let data: TileData;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch { file = path.join(base, entry.file.replace(/^tiles\//, '')); data = JSON.parse(readFileSync(file, 'utf8')); }
  const old = buildTreeGeometry(data.trees);
  if (old) {
    const merged = mergeEnvironmentGeometries([old.geometry])!;
    legacyBytes += packGeometry(merged).bytes;
    legacyTriangles += old.triangleCount;
    count += old.count;
    old.geometry.dispose(); merged.dispose();
  }
  for (const result of styles) {
    const trees = buildTreeInstances(data.trees, result.style);
    if (!trees) continue;
    result.count += trees.count;
    result.instanceBytes += treeInstanceBytes(trees);
    result.triangles += trees.triangleCount;
    result.batches += 1 + trees.crowns.length;
    result.cache.get(trees, 0, true);
    for (const crown of trees.crowns) result.cache.get(trees, crown.template);
  }
}
const report = { dataset, tiles: manifest.tiles.length, legacy: { count, bytes: legacyBytes, triangles: legacyTriangles },
  styles: styles.map(({ cache, ...s }) => {
    s.templateBytes = cache.bytes;
    s.reductionPercent = +(100 * (1 - (s.instanceBytes + s.templateBytes) / legacyBytes)).toFixed(2);
    cache.dispose(); return s;
  }) };
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.styles.some(s => s.count !== count || s.reductionPercent < 75)) process.exitCode = 1;
