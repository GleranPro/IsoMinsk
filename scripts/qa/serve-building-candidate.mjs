/**
 * QA-only preview server for an isolated styled-city candidate.
 *
 * Maps exactly `/data/city-tiles/manifest.json` and its listed tile paths to a
 * resolved staged directory, with an explicit escape check. A missing staged
 * tile returns 404: the router never falls through to the working dataset in
 * `public/data/city-tiles`, so a capture can never silently mix two datasets.
 *
 * The middleware is a Vite plugin, so the rest of the app (React shell, workers,
 * museum payload) is served by the normal dev pipeline. This server is QA
 * tooling only and never participates in Pages artifact assembly.
 *
 * Usage:
 *   node scripts/qa/serve-building-candidate.mjs --tiles-dir data/staging/city-buildings [--port 5180]
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createServer } from 'vite';

function parseArgs(argv) {
  const args = { tilesDir: null, port: 5180, host: '127.0.0.1' };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--tiles-dir') args.tilesDir = argv[++index];
    else if (value === '--port') args.port = Number(argv[++index]);
    else if (value === '--host') args.host = argv[++index];
  }
  return args;
}

function stableManifestHash(manifest) {
  const stable = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'generatedAt'));
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function candidatePlugin(tilesDir) {
  return {
    name: 'voxelminsk-candidate-data',
    configureServer(server) {
      server.middlewares.use('/data/city-tiles', (request, response, next) => {
        const rawUrl = (request.url || '/').split('?')[0];
        let relative;
        try {
          relative = decodeURIComponent(rawUrl);
        } catch {
          response.statusCode = 400;
          response.end('bad request');
          return;
        }
        const target = resolve(tilesDir, `.${relative.startsWith('/') ? relative : `/${relative}`}`);
        if (target !== tilesDir && !target.startsWith(tilesDir + sep)) {
          response.statusCode = 403;
          response.end('forbidden');
          return;
        }
        if (!existsSync(target) || statSync(target).isDirectory()) {
          // Fail closed: never fall through to the working dataset.
          response.statusCode = 404;
          response.end('candidate tile not found');
          return;
        }
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        createReadStream(target).pipe(response);
        void next;
      });
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tilesDir) {
    console.error('serve-building-candidate: --tiles-dir is required');
    process.exitCode = 2;
    return;
  }
  const tilesDir = resolve(args.tilesDir);
  const manifestPath = join(tilesDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`serve-building-candidate: no manifest at ${manifestPath}`);
    process.exitCode = 2;
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const repoRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');

  const server = await createServer({
    root: repoRoot,
    configFile: join(repoRoot, 'vite.config.ts'),
    plugins: [candidatePlugin(tilesDir)],
    server: { host: args.host, port: args.port, strictPort: true },
  });
  await server.listen();
  const url = `http://${args.host}:${args.port}`;
  console.log(`serve-building-candidate: ${url}`);
  console.log(`  staged tiles: ${tilesDir}`);
  console.log(`  manifest sha256: ${stableManifestHash(manifest)}`);
  console.log(`  tiles: ${manifest.tiles?.length ?? 0}, buildings: ${manifest.counts?.buildings ?? 0}`);
  console.log('  routes: /data/city-tiles/* -> staged directory only (missing tiles 404)');
}

main().catch((error) => {
  console.error(`serve-building-candidate failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
