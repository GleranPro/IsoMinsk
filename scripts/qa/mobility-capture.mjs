#!/usr/bin/env node
/**
 * Isometric Minsk — mobility acceptance frames (QA).
 *
 * Captures the verified corridors with the dynamic layer on, writes the
 * simulation dump next to the frames, and FAILS when nothing is actually drawn.
 * A folder of empty street screenshots must never be mistaken for a working
 * transport layer.
 *
 * The camera follows a real active trip instead of a hardcoded midpoint: with a
 * 12-minute headway there are only a handful of vehicles in the whole corridor,
 * so a fixed frame would usually look empty and prove nothing.
 *
 * Evidence (in `screenshots/mobility/`):
 *   bus-close.png / bus-motion-b.png   the same trip 3 s apart (movement)
 *   bus-signal.png                     a signal node on the bus corridor
 *   tram-close.png                     a tram on its track
 *   bus-overview.png / tram-overview.png  corridor context
 *   bus-rot0..3.png                    four camera rotations of the same trip
 *   dump.json                          clock, trips, signal aspects (QA)
 *   stats.json                         EngineStats per frame
 *   console.log                        every browser console message
 *
 * Usage (PowerShell, from the repo root):
 *   node scripts/qa/mobility-capture.mjs
 *   $env:QA_GPU='1'; node scripts/qa/mobility-capture.mjs        # hardware GPU
 *   $env:QA_DATE='2026-11-16'; node scripts/qa/mobility-capture.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT_DIR = path.join(ROOT, 'screenshots', 'mobility');
const PORT = Number(process.env.QA_PORT || 5173);
const BASE_URL = process.env.QA_BASE_URL?.trim() || `http://127.0.0.1:${PORT}`;
const HEADLESS = process.env.QA_HEADLESS !== '0';
const USE_GPU = process.env.QA_GPU === '1';
const READY_TIMEOUT_MS = Number(process.env.QA_READY_TIMEOUT_MS || 180_000);
const SERVICE_DATE = process.env.QA_DATE?.trim() || '2026-11-16';
const VIEWPORT = { width: 1600, height: 900 };

const SWIFTSHADER_ARGS = [
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-gpu-sandbox',
];
const GPU_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'];
const CHROMIUM_ARGS = USE_GPU ? GPU_ARGS : SWIFTSHADER_ARGS;

/** Corridor midpoints (local metres) used for the wide context frames. */
const BUS_CORRIDOR = [450, 1250];
const TRAM_CORRIDOR = [3200, -3670];

// --------------------------------------------------------------------------
// geometry targets from the exported intermediate network
// --------------------------------------------------------------------------

/** Sample a flat xyz polyline at arc length `distance`. */
function sampleFlat(points, distances, distance) {
  const count = Math.floor(points.length / 3);
  if (count === 0) return { x: 0, y: 0 };
  if (count === 1) return { x: points[0], y: points[1] };
  const length = distances[distances.length - 1] ?? 0;
  const clamped = Math.min(Math.max(distance, 0), length);
  let index = 0;
  while (index < count - 2 && distances[index + 1] < clamped) index += 1;
  const span = distances[index + 1] - distances[index];
  const t = span > 1e-9 ? (clamped - distances[index]) / span : 0;
  return {
    x: points[index * 3] + (points[(index + 1) * 3] - points[index * 3]) * t,
    y: points[index * 3 + 1] + (points[(index + 1) * 3 + 1] - points[index * 3 + 1]) * t,
  };
}

function edgeStartHeading(edge) {
  const p = edge.centerline.p;
  return Math.atan2(p[4] - p[1], p[3] - p[0]);
}

function edgeEndHeading(edge) {
  const p = edge.centerline.p;
  const count = Math.floor(p.length / 3);
  return Math.atan2(
    p[(count - 1) * 3 + 1] - p[(count - 2) * 3 + 1],
    p[(count - 1) * 3] - p[(count - 2) * 3],
  );
}

function angleDelta(a, b) {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/**
 * Read the bridge and the sharpest turn from the verified network so the
 * acceptance frames can frame them deterministically instead of hoping a
 * vehicle happens to be there.
 */
function readGeometryTargets() {
  const file = path.join(ROOT, 'data', 'processed', 'mobility', 'network.json');
  if (!existsSync(file)) return { bridge: null, turn: null };
  const network = JSON.parse(readFileSync(file, 'utf8'));
  const edges = network.edges ?? [];

  let bridge = null;
  let bestHeight = 0;
  for (const edge of edges) {
    const heights = edge.centerline.p.filter((_, index) => index % 3 === 2);
    const maxHeight = Math.max(...heights, 0);
    if (maxHeight > bestHeight) {
      bestHeight = maxHeight;
      const half = (edge.centerline.s[edge.centerline.s.length - 1] ?? 0) / 2;
      const point = sampleFlat(edge.centerline.p, edge.centerline.s, half);
      bridge = { point: [point.x, point.y], heightM: maxHeight, edgeId: edge.id, mode: 'tram' };
    }
  }
  if (bridge && bridge.heightM < 0.5) bridge = null;

  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  let turn = null;
  let sharpest = 0;
  let fallback = null;
  let fallbackAngle = 0;
  for (const variant of network.variants ?? []) {
    const ids = variant.edges ?? [];
    // Cumulative distance from the variant start; turns at the very end are the
    // terminus loop, not a mid-route road turn, and would prove the wrong thing.
    const lengths = ids.map((id) => byId.get(id)?.centerline.s.slice(-1)[0] ?? 0);
    const totalLength = lengths.reduce((sum, value) => sum + value, 0);
    let travelled = 0;
    for (let index = 1; index < ids.length; index += 1) {
      travelled += lengths[index - 1];
      const before = byId.get(ids[index - 1]);
      const after = byId.get(ids[index]);
      if (!before || !after) continue;
      if (travelled < 150 || totalLength - travelled < 150) continue;
      const delta = angleDelta(edgeEndHeading(before), edgeStartHeading(after));
      const candidate = {
        point: [after.centerline.p[0], after.centerline.p[1]],
        angleRad: delta,
        edgeId: after.id,
        mode: variant.mode,
        variantId: variant.id,
        distanceAlongVariantM: travelled,
      };
      if (Math.abs(delta) > Math.abs(fallbackAngle)) {
        fallbackAngle = delta;
        fallback = candidate;
      }
      // Prefer a street-style turn (45°–100°) away from the termini: that is the
      // case the body-clearance check is about. A near-U-turn loop is the
      // fallback when no such junction exists on the corridor.
      const degrees = (Math.abs(delta) * 180) / Math.PI;
      if (
        degrees >= 45 &&
        degrees <= 100 &&
        travelled >= 300 &&
        totalLength - travelled >= 300 &&
        Math.abs(delta) > Math.abs(sharpest)
      ) {
        sharpest = delta;
        turn = candidate;
      }
    }
  }
  return { bridge, turn: turn ?? fallback };
}

// --------------------------------------------------------------------------
// dev server (mirrors scripts/qa/capture.mjs)
// --------------------------------------------------------------------------

let serverProcess = null;
const serverOutput = [];

async function probeServer(url, timeoutMs = 1500) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await probeServer(BASE_URL)) {
    console.log(`[server] reusing dev server on ${BASE_URL}`);
    return;
  }
  console.log(`[server] starting: pnpm exec vite --port ${PORT} --strictPort --host 127.0.0.1`);
  serverProcess = spawn(
    'pnpm',
    ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: ROOT,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    },
  );
  serverProcess.stdout?.on('data', (chunk) => serverOutput.push(String(chunk)));
  serverProcess.stderr?.on('data', (chunk) => serverOutput.push(String(chunk)));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`dev server exited (${serverProcess.exitCode})\n${serverOutput.join('')}`);
    }
    if (await probeServer(BASE_URL)) {
      console.log(`[server] ready at ${BASE_URL}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`dev server did not become reachable within 120 s\n${serverOutput.join('')}`);
}

function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      serverProcess.kill('SIGTERM');
    }
  } catch (error) {
    console.warn(`[server] stop failed: ${String(error)}`);
  }
}

// --------------------------------------------------------------------------
// browser helpers
// --------------------------------------------------------------------------

const READY_PROBE = () => {
  const api = window.__CITY_APP__;
  const stats = window.__CITY_STATS__ ?? api?.stats ?? null;
  const hasGeometry = !!stats && stats.loadedTiles > 0 && stats.triangles > 0;
  if (api && api.ready === true && hasGeometry) return 'ready';
  if (!api && hasGeometry) return 'stats-only';
  return false;
};

async function waitForReady(page) {
  const startedAt = Date.now();
  const deadline = startedAt + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const probe = await page.evaluate(READY_PROBE).catch(() => false);
    if (probe) {
      console.log(`[ready] ${probe} after ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
      return probe;
    }
    const overlay = await page
      .evaluate(() => document.querySelector('[data-testid="error-message"]')?.textContent ?? '')
      .catch(() => '');
    if (overlay.trim()) throw new Error(`renderer reported a fatal error: ${overlay.trim()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`renderer did not become ready within ${READY_TIMEOUT_MS / 1000} s\n${serverOutput.join('')}`);
}

/** Wait until the mobility status left `idle`/`loading` (or timed out honestly). */
async function waitForMobility(page, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const app = window.__CITY_APP__?.app;
      return app && typeof app.getMobilityStatus === 'function' ? app.getMobilityStatus() : null;
    });
    if (last && last.state !== 'idle' && last.state !== 'loading') {
      console.log(
        `[mobility] state=${last.state} schedule=${last.scheduleStatus} trips=${last.scheduledTrips} ` +
          `active=${last.activeTrips} chunks=${last.loadedChunks} signals=${last.signalNodes}`,
      );
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}

async function applyCamera(page, focus, orthoHeight, azimuth = Math.PI / 4, settleMs = 900) {
  await page.evaluate(
    ({ point, zoom, az }) => {
      const app = window.__CITY_APP__?.app;
      if (!app) throw new Error('__CITY_APP__.app is missing');
      app.setCameraSettings({ orthoHeight: zoom, azimuth: az });
      app.focusOnLocal(point[0], point[1]);
    },
    { point: focus, zoom: orthoHeight, az: azimuth },
  );
  await page.waitForTimeout(settleMs);
}

async function readDump(page) {
  return page.evaluate(() => {
    const app = window.__CITY_APP__?.app;
    return app && typeof app.getMobilityDump === 'function' ? app.getMobilityDump() : null;
  });
}

async function readStats(page) {
  return page.evaluate(() => window.__CITY_STATS__ ?? null);
}

async function shoot(page, name, statsByView, view) {
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  statsByView[name] = { view, status: await readStats(page) };
  return readDump(page);
}

/** Pick a trip of the given route number that is actually moving on screen. */
function pickTrip(dump, routeMarker) {
  const trips = (dump?.trips ?? []).filter((trip) => String(trip.ref) === routeMarker || trip.variantId.includes(`:${routeMarker}:`));
  const preferred = trips.find((trip) => trip.phase === 'moving') ?? trips.find((trip) => trip.phase !== 'finished') ?? trips[0];
  return preferred ?? null;
}

function nearestSignal(dump, point) {
  const nodes = dump?.signals ?? [];
  let best = null;
  let bestDistance = Infinity;
  for (const node of nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    const distance = Math.hypot(node.x - point[0], node.y - point[1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  }
  return best;
}

/**
 * Find a service time at which a vehicle matches the predicate and is near
 * `point`, using the explicit QA clock (deterministic timetable → deterministic
 * answer). Options narrow the match to one variant and/or a minimum deck height,
 * so "near the bridge" cannot silently capture a tram that is still approaching
 * the ramp at ground level.
 */
async function searchMoment(page, point, mode, radiusM, options = {}) {
  const {
    windowStart = 8 * 3600,
    windowEnd = 8 * 3600 + 1800,
    step = 15,
    variantId = null,
    minHeight = null,
  } = options;
  for (let seconds = windowStart; seconds <= windowEnd; seconds += step) {
    const hit = await page.evaluate(
      ({ date, sec, target, wantedMode, radius, wantedVariant, minH }) => {
        const app = window.__CITY_APP__?.app;
        if (!app) return null;
        app.setMobilityServiceDate(date, sec);
        const dump = app.getMobilityDump();
        const trip = (dump?.trips ?? []).find(
          (candidate) =>
            candidate.mode === wantedMode &&
            (wantedVariant === null || candidate.variantId === wantedVariant) &&
            (minH === null || candidate.h >= minH) &&
            Math.hypot(candidate.x - target[0], candidate.y - target[1]) <= radius,
        );
        return trip
          ? { tripId: trip.tripId, x: trip.x, y: trip.y, h: trip.h, seconds: sec }
          : null;
      },
      {
        date: SERVICE_DATE,
        sec: seconds,
        target: point,
        wantedMode: mode,
        radius: radiusM,
        wantedVariant: variantId,
        minH: minHeight,
      },
    );
    if (hit) return hit;
  }
  return null;
}

/** Frame a target and verify the expected vehicle is still there and drawn. */
async function shootMoment(page, name, point, orthoHeight, tripId, statsByView, view, settleMs = 900) {
  // A short settle, so a vehicle photographed mid-manoeuvre (bridge plateau,
  // junction turn) has not already driven out of the frame.
  await applyCamera(page, point, orthoHeight, Math.PI / 4, settleMs);
  const dump = await shoot(page, name, statsByView, view);
  const trip = (dump?.trips ?? []).find((candidate) => candidate.tripId === tripId);
  return { dump, trip };
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await ensureServer();

  const browser = await chromium.launch({ headless: HEADLESS, args: CHROMIUM_ARGS });
  const consoleMessages = [];
  const statsByView = {};
  const failures = [];
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('console', (message) => consoleMessages.push(`[${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => consoleMessages.push(`[pageerror] ${String(error)}`));

    const url = `${BASE_URL}/?dataset=city`;
    console.log(`[browser] ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await waitForReady(page);

    // Deterministic QA clock: a fixed service date at 08:00 local, so frames are
    // reproducible and there are guaranteed active trips on the demo timetable.
    const fixed = await page.evaluate((date) => {
      const app = window.__CITY_APP__?.app;
      if (!app || typeof app.setMobilityServiceDate !== 'function') return false;
      app.setMobilityServiceDate(date);
      app.setMobilitySettings({ vehiclesVisible: true, signalsVisible: true });
      return true;
    }, SERVICE_DATE);
    if (!fixed) throw new Error('app.setMobilityServiceDate is unavailable: mobility integration missing');
    const status = await waitForMobility(page);
    if (!status) throw new Error('getMobilityStatus() returned nothing');
    if (status.scheduleStatus === 'unavailable' || status.scheduleStatus === 'absent') {
      console.error(
        '[fatal] the payload has no timetable: transport-by-schedule cannot be captured or accepted.',
      );
      process.exitCode = 2;
      return;
    }

    const initial = await readDump(page);
    if (!initial) throw new Error('getMobilityDump() returned null: simulation never initialised');
    if ((initial.trips.length ?? 0) === 0) {
      console.error('[fatal] simulation has no active trips at the fixed QA clock — nothing to capture.');
      process.exitCode = 2;
      return;
    }

    // --- bus corridor: follow a real trip ---------------------------------
    const busTrip = pickTrip(initial, '39');
    if (!busTrip) throw new Error('no active bus 39 trip to follow');
    console.log(`[target] bus trip ${busTrip.tripId} at (${busTrip.x.toFixed(0)}, ${busTrip.y.toFixed(0)}) phase=${busTrip.phase}`);
    await applyCamera(page, [busTrip.x, busTrip.y], 160);
    const busDump = await shoot(page, 'bus-close', statsByView, { follow: busTrip.tripId, orthoHeight: 160 });
    const busDrawn = (busDump?.trips ?? []).filter((trip) => trip.drawn);
    console.log(`[view] bus-close drawn=${busDrawn.length} of ${busDump?.trips.length ?? 0}`);
    if (busDrawn.length === 0) {
      failures.push('bus-close: focused a moving trip but the layer drew nothing (LOD/budget/culling bug?)');
    }

    // Same trip 3 s later: movement evidence, no teleport.
    await page.waitForTimeout(3000);
    const busLater = await shoot(page, 'bus-motion-b', statsByView, { follow: busTrip.tripId, orthoHeight: 160 });
    const moved = (busLater?.trips ?? []).find((trip) => trip.tripId === busTrip.tripId);
    if (!moved) {
      failures.push('bus-motion-b: followed trip disappeared from the simulation');
    } else {
      const distance = Math.hypot(moved.x - busTrip.x, moved.y - busTrip.y);
      console.log(`[motion] ${busTrip.tripId} moved ${distance.toFixed(1)} m in ~3 s`);
      if (distance < 1) failures.push(`bus-motion-b: trip did not move (${distance.toFixed(2)} m in 3 s)`);
      if (distance > 120) failures.push(`bus-motion-b: trip jumped ${distance.toFixed(1)} m in 3 s`);
    }

    // --- signal node on the same corridor --------------------------------
    const signal = nearestSignal(initial, [busTrip.x, busTrip.y]);
    if (signal) {
      console.log(`[target] signal ${signal.nodeId} at (${signal.x.toFixed(0)}, ${signal.y.toFixed(0)}) phase=${signal.phase}`);
      // The layer hides signal heads below its screen-size LOD (~0.62 m/px,
      // i.e. orthoHeight <= ~112 m at the 360 px internal height). Frame the node
      // at 90 m so a head is deliberately visible instead of tripping the LOD.
      await applyCamera(page, [signal.x, signal.y], 90);
      const signalDump = await shoot(page, 'bus-signal', statsByView, { signal: signal.nodeId, orthoHeight: 90 });
      const known = (signalDump?.signals ?? []).find((node) => node.nodeId === signal.nodeId);
      const aspects = known ? Object.values(known.aspects) : [];
      console.log(`[signals] ${signal.nodeId} aspects=${aspects.join(',')} drawn=${signalDump?.status.signalNodesDrawn ?? 0}`);
      if (!known) failures.push('bus-signal: the signal node vanished from the dump');
      if ((signalDump?.status.signalNodesDrawn ?? 0) === 0) {
        failures.push('bus-signal: focused a signal node but the layer drew no heads');
      }
    } else {
      failures.push('no signal node found near the bus trip');
    }

    // --- rendering modes: night and clean (non pixel-art) ----------------
    await applyCamera(page, [busTrip.x, busTrip.y], 170);
    await page.evaluate(() => window.__CITY_APP__?.app?.setTimeOfDay(23));
    await page.waitForTimeout(1000);
    await shoot(page, 'bus-night', statsByView, { orthoHeight: 170, timeOfDay: 23 });
    await page.evaluate(() => {
      const app = window.__CITY_APP__?.app;
      app?.setTimeOfDay(13);
      app?.setPixelEffectEnabled(false);
    });
    await page.waitForTimeout(1000);
    await shoot(page, 'bus-clean', statsByView, { orthoHeight: 170, pixelArt: false });
    await page.evaluate(() => window.__CITY_APP__?.app?.setPixelEffectEnabled(true));
    console.log('[view] bus-night, bus-clean');

    // --- tram corridor ----------------------------------------------------
    const tramTrip = pickTrip(initial, '9');
    if (tramTrip) {
      console.log(`[target] tram trip ${tramTrip.tripId} at (${tramTrip.x.toFixed(0)}, ${tramTrip.y.toFixed(0)})`);
      await applyCamera(page, [tramTrip.x, tramTrip.y], 170);
      const tramDump = await shoot(page, 'tram-close', statsByView, { follow: tramTrip.tripId, orthoHeight: 170 });
      const drawn = (tramDump?.trips ?? []).filter((trip) => trip.drawn).length;
      console.log(`[view] tram-close drawn=${drawn}`);
      if (drawn === 0) failures.push('tram-close: focused a tram but nothing was drawn');

      // Signalised node on the tram alignment (the plan requires both a road
      // junction and a tram node as verified cases).
      const tramSignal = nearestSignal(initial, [tramTrip.x, tramTrip.y]);
      if (tramSignal) {
        console.log(`[target] tram signal ${tramSignal.nodeId} at (${tramSignal.x.toFixed(0)}, ${tramSignal.y.toFixed(0)})`);
        await applyCamera(page, [tramSignal.x, tramSignal.y], 90);
        const signalDump = await shoot(page, 'tram-signal', statsByView, {
          signal: tramSignal.nodeId,
          orthoHeight: 90,
        });
        const known = (signalDump?.signals ?? []).find((node) => node.nodeId === tramSignal.nodeId);
        console.log(
          `[signals] ${tramSignal.nodeId} aspects=${known ? Object.values(known.aspects).join(',') : 'missing'} ` +
            `drawn=${signalDump?.status.signalNodesDrawn ?? 0}`,
        );
        if (!known) failures.push('tram-signal: the tram signal node vanished from the dump');
        if ((signalDump?.status.signalNodesDrawn ?? 0) === 0) {
          failures.push('tram-signal: focused a tram signal node but the layer drew no heads');
        }
      } else {
        failures.push('no signal node found near the tram trip');
      }
    } else {
      failures.push('no active tram 9 trip to follow');
    }

    // --- bridge and sharp-turn clearance frames --------------------------
    // These are the two visual checks the plan calls out separately: a vehicle
    // must sit on the raised deck at the right profile height, and a bus body
    // must stay on the carriageway through the sharpest turn of the corridor.
    const geometry = readGeometryTargets();
    if (!geometry.bridge) {
      console.warn('[warn] no elevated edge found in data/processed/mobility/network.json: bridge frame skipped');
    } else {
      console.log(
        `[target] bridge edge ${geometry.bridge.edgeId} at (${geometry.bridge.point[0].toFixed(0)}, ` +
          `${geometry.bridge.point[1].toFixed(0)}), deck height ${geometry.bridge.heightM.toFixed(2)} m`,
      );
      const moment = await searchMoment(page, geometry.bridge.point, 'tram', 70, {
        minHeight: Math.max(1.5, geometry.bridge.heightM - 0.6),
        // The deck plateau is ~11 s long at tram speed; a 15 s clock grid can
        // step straight over it, so the QA search samples every 5 s.
        step: 5,
      });      if (!moment) {
        failures.push('bridge: no tram reached the elevated deck within the 08:00–08:30 QA window');
      } else {
        console.log(
          `[target] tram ${moment.tripId} on the deck at ${moment.seconds}s of service day ` +
            `(h=${moment.h.toFixed(2)} m)`,
        );
        const { dump, trip } = await shootMoment(
          page,
          'tram-bridge',
          [moment.x, moment.y],
          110,
          moment.tripId,
          statsByView,
          { bridge: geometry.bridge.edgeId, heightM: geometry.bridge.heightM, orthoHeight: 110 },
          250,
        );
        const height = trip?.h ?? 0;
        console.log(`[bridge] trip height ${height.toFixed(2)} m, drawn=${trip?.drawn === true}, dumpTrips=${dump?.trips.length ?? 0}`);
        if (!trip) failures.push('bridge: framed the deck but the tram left before the screenshot');
        if (height < Math.max(1, geometry.bridge.heightM - 0.6)) {
          failures.push(`bridge: vehicle height ${height.toFixed(2)} m does not follow the ${geometry.bridge.heightM.toFixed(2)} m deck`);
        }
        if (trip && !trip.drawn) failures.push('bridge: tram on the deck was culled by the layer');
      }
    }
    if (!geometry.turn) {
      console.warn('[warn] no sharp turn found in the network: turn-clearance frame skipped');
    } else {
      console.log(
        `[target] sharpest turn ${(geometry.turn.angleRad * 180 / Math.PI).toFixed(1)}° on ${geometry.turn.variantId} ` +
          `at (${geometry.turn.point[0].toFixed(0)}, ${geometry.turn.point[1].toFixed(0)})`,
      );
      const moment = await searchMoment(page, geometry.turn.point, geometry.turn.mode, 14, {
        variantId: geometry.turn.variantId,
        // Catch the body inside the turn itself, not approaching it: a bus
        // crosses the 28 m junction window in ~5 s, so sample every 2 s.
        step: 2,
      });
      if (!moment) {
        failures.push('turn: no vehicle reached the sharpest turn within the 08:00–08:30 QA window');
      } else {
        console.log(`[target] ${geometry.turn.mode} ${moment.tripId} in the turn at ${moment.seconds}s of service day`);
        const { trip } = await shootMoment(
          page,
          'bus-turn',
          [moment.x, moment.y],
          100,
          moment.tripId,
          statsByView,
          { turn: geometry.turn.edgeId, angleRad: geometry.turn.angleRad, orthoHeight: 100 },
          250,
        );
        console.log(`[turn] trip ${trip?.tripId ?? 'missing'} drawn=${trip?.drawn === true}`);
        if (!trip) failures.push('turn: framed the turn but the vehicle left before the screenshot');
        else if (!trip.drawn) failures.push('turn: vehicle in the turn was culled by the layer');
      }
    }

    // --- corridor context -------------------------------------------------
    for (const [name, focus, zoom] of [
      ['bus-overview', BUS_CORRIDOR, 900],
      ['tram-overview', TRAM_CORRIDOR, 900],
    ]) {
      await applyCamera(page, focus, zoom);
      const dump = await shoot(page, name, statsByView, { focus, orthoHeight: zoom });
      console.log(`[view] ${name} trips=${dump?.trips.length ?? 0} drawn=${dump?.status.drawnTrips ?? 0}`);
    }

    // --- four camera rotations around the followed trip -------------------
    await applyCamera(page, [busTrip.x, busTrip.y], 200);
    for (let index = 0; index < 4; index += 1) {
      const azimuth = Math.PI / 4 + (index * Math.PI) / 2;
      await applyCamera(page, [busTrip.x, busTrip.y], 200, azimuth);
      await shoot(page, `bus-rot${index}`, statsByView, { azimuth, orthoHeight: 200 });
      console.log(`[view] bus-rot${index} azimuth=${azimuth.toFixed(3)}`);
    }

    const dump = await readDump(page);
    const finalStatus = await page.evaluate(() => window.__CITY_APP__?.app?.getMobilityStatus() ?? null);
    await writeFile(
      path.join(OUT_DIR, 'dump.json'),
      `${JSON.stringify({ capturedAt: new Date().toISOString(), serviceDate: SERVICE_DATE, status: finalStatus, dump, failures }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(OUT_DIR, 'stats.json'),
      `${JSON.stringify({ gpu: USE_GPU ? 'hardware' : 'swiftshader', views: statsByView }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(path.join(OUT_DIR, 'console.log'), `${consoleMessages.join('\n')}\n`, 'utf8');

    console.log(
      `[summary] active=${dump?.trips.length ?? 0} drawn=${dump?.status.drawnTrips ?? 0} ` +
        `signalsDrawn=${dump?.status.signalNodesDrawn ?? 0} schedule=${finalStatus?.scheduleStatus ?? '?'}`,
    );
    if (failures.length > 0) {
      console.error(`[fatal] ${failures.length} acceptance failure(s):`);
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 2;
    } else {
      console.log(`[ok] wrote frames to ${OUT_DIR}`);
    }
  } finally {
    await browser.close().catch(() => {});
    stopServer();
  }
}

main().catch((error) => {
  console.error(`[fatal] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
