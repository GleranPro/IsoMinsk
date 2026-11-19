#!/usr/bin/env node
/**
 * Run the Blender transport-model build with a locatable Blender executable.
 *
 *   node scripts/models/run_transport_models.mjs [--render] [--glb] [--no-blend]
 *
 * `BLENDER_EXE` wins; otherwise the standard Blender 5.1 install on Windows is
 * used, then `blender` from PATH. The Blender script itself resolves the repo
 * root from `__file__`, so this wrapper may be started from any directory.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const script = join(here, 'build_transport_models.py');

const candidates = [
  process.env.BLENDER_EXE,
  'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe',
  'blender',
].filter(Boolean);

const blender = candidates.find((candidate) =>
  candidate === 'blender' ? true : existsSync(candidate),
);

if (!blender) {
  console.error(
    'Blender not found. Set BLENDER_EXE or install Blender 5.1 in the default location.',
  );
  process.exit(1);
}

const args = [
  '--background',
  '--factory-startup',
  '--python',
  script,
  '--',
  ...process.argv.slice(2),
];

const result = spawnSync(blender, args, {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
