/**
 * Isometric Minsk — CPU cost of a city tile (parse + geometry build).
 *
 * GPU-free benchmark used to separate "slow tile loading" into CPU work
 * (JSON.parse + buildTilePayload) and GPU/streaming work. Reads real tiles from
 * a dataset directory, builds the wire payload exactly like the worker does and
 * reports per-tile timings plus a projection for the whole dataset.
 *
 * Usage:
 *   pnpm exec tsx scripts/qa/tile-cpu-bench.ts
 *   pnpm exec tsx scripts/qa/tile-cpu-bench.ts --tiles-dir public/data/city-tiles-b2 --count 24
 *   pnpm exec tsx scripts/qa/tile-cpu-bench.ts --json docs/B2/TILE_CPU_BENCH.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { buildTilePayload } from '../../src/engine/tiles/tileBuild';
import type { TileData } from '../../src/shared/types';

interface Args {
  tilesDir: string;
  count: number;
  json: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    tilesDir: get('--tiles-dir') ?? 'public/data/city-tiles',
    count: Number(get('--count') ?? 16),
    json: get('--json') ?? null,
  };
}

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function main(): void {
  const args = parseArgs();
  const dir = path.resolve(ROOT, args.tilesDir);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const files: string[] = manifest.tiles.map((entry: { file: string }) =>
    path.basename(entry.file),
  );
  // Evenly spaced sample: centre tiles and outer tiles both appear.
  const step = Math.max(1, Math.floor(files.length / args.count));
  const sample = files.filter((_, index) => index % step === 0).slice(0, args.count);

  const rows: Array<Record<string, number | string>> = [];
  for (const file of sample) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    const t0 = performance.now();
    const data = JSON.parse(text) as TileData;
    const t1 = performance.now();
    const payload = buildTilePayload(data, { facadeDetail: true, trees: true });
    const t2 = performance.now();
    rows.push({
      file,
      textMB: Math.round((text.length / 1e6) * 100) / 100,
      parseMs: Math.round((t1 - t0) * 10) / 10,
      buildMs: Math.round((t2 - t1) * 10) / 10,
    });
  }

  const sum = (key: string): number => rows.reduce((acc, row) => acc + Number(row[key] ?? 0), 0);
  const summary = {
    tilesDir: args.tilesDir,
    sampled: rows.length,
    totalTiles: files.length,
    textMB: Math.round((sum('textMB') / rows.length) * files.length),
    meanParseMs: Math.round((sum('parseMs') / rows.length) * 10) / 10,
    meanBuildMs: Math.round((sum('buildMs') / rows.length) * 10) / 10,
    projectedTransferMB: Math.round((sum('textMB') / rows.length) * files.length),
    projectedParseS: Math.round(((sum('parseMs') / rows.length) * files.length) / 100) / 10,
    projectedBuildS1Worker:
      Math.round(((sum('buildMs') / rows.length) * files.length) / 100) / 10,
    projectedBuildS4Workers:
      Math.round(((sum('buildMs') / rows.length) * files.length) / 400) / 10,
    rows,
  };

  if (args.json) {
    const out = path.resolve(ROOT, args.json);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(summary, null, 1));
  }
  console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
}

main();
