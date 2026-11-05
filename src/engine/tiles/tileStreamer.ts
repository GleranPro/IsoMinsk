/**
 * Tile streaming.
 *
 * Responsibilities:
 *  - fetch the tile manifest (with retry) and expose per-tile index entries;
 *  - compute the tiles visible in the orthographic frustum, expanded by one tile
 *    so buildings that cross a tile border are already present;
 *  - keep an LRU cache (default 40 tiles) with explicit GPU/geometry disposal;
 *  - dedupe concurrent requests and cancel/ignore stale ones, retry once on
 *    transient failure;
 *  - build tiles in Web Workers (fallback: chunked main-thread build);
 *  - pick a near/far facade material per tile from its projected size (LOD);
 *  - report initial-loading progress and expose counters for EngineStats.
 *
 * The streamer owns no render loop: `update()` is called once per frame by
 * createCityApp with the camera rig and the current low-res render height.
 */

import * as THREE from 'three';
import { groundResolutionFor } from '../../city/ground/groundRaster';
import {
  DATA_BASE_URL,
  GROUND_LAYER_Y,
  TILE_MANIFEST_URL,
  TILE_SIZE_M,
} from '../../shared/config';
import { ENV_PALETTE } from '../materials/palette';
import { createGroundMaterial, createGroundQuad, createGroundTexture } from '../materials/groundMaterial';
import { tileBounds, tileKey, tilesInRect } from '../../shared/tileMath';
import type { TileData, TileIndexEntry, TileManifest, BuildingFeature, FeatureId } from '../../shared/types';
import type { IsometricCameraRig } from '../camera/isometricCamera';
import { buildTilePayload } from './tileBuild';
import {
  type GroundBuildMode,
  unpackGeometry,
  wireMeshBytes,
  type TileWirePayload,
} from './serialization';
import { TileWorkerPool } from './tileWorkerPool';
import { createDemoManifest, createDemoTiles } from './demoTiles';

export interface TileEntry {
  key: string;
  x: number;
  y: number;
  bounds: [number, number, number, number];
  group: THREE.Group;
  buildingMesh: THREE.Mesh | null;
  environmentMesh: THREE.Mesh | null;
  treeMesh: THREE.Mesh | null;
  /** Raster ground quad (payload 0.4.0) with its own texture/material. */
  groundMesh: THREE.Mesh | null;
  /** Bridge deck tops (payload 0.4.2) with their own atlas texture/material. */
  deckMesh: THREE.Mesh | null;
  /** Texel size of the ground texture currently shown, metres (ground LOD). */
  groundRes: number;
  buildings: Map<FeatureId, BuildingFeature>;
  buildingIds: FeatureId[];
  triangleOwner: Uint32Array | null;
  lod: 'near' | 'far';
  triangles: number;
  bytes: number;
  lastUsed: number;
}

export interface TileStreamerOptions {
  scene: THREE.Scene;
  root: THREE.Group;
  environmentMaterial: THREE.Material;
  treeMaterial: THREE.Material;
  facadeMaterialNear: THREE.Material;
  facadeMaterialFar: THREE.Material;
  demo?: boolean;
  nolimit?: boolean;
  maxLoadedTiles?: number;
  /** Override the manifest URL (dataset selection lives in src/shared/config.ts). */
  manifestUrl?: string;
  /** Override the tile payload base URL. */
  dataBaseUrl?: string;
  /** Ground build mode: 'raster' (default) or the legacy 'vector' partition. */
  groundMode?: GroundBuildMode;
  /** Ground texel size override, metres. */
  groundRes?: number;
  /** Ready after this many (nearest) visible tiles instead of all of them. */
  initialTileTarget?: number;
  /** Keep the ground plate visible to cover tiles skipped by the resident budget. */
  keepBasePlate?: boolean;
  /** Number of tile-build workers (2 for the central dataset, 3-4 for the city). */
  workerCount?: number;
  /** Visible/resident budget before the idle top-up (default: maxLoadedTiles). */
  initialBudget?: number;
  /** After this many ms of camera idle the visible budget grows by one step. */
  idleTopUpAfterMs?: number;
  /** Tiles added to the visible budget per idle top-up step. */
  topUpStepTiles?: number;
  /** Stop the idle top-up once geometryMB reaches this value (0 = no cap). */
  maxTopUpGeometryMB?: number;
  /** Manifest tile URL layout preference ('flat' central, 'nested' city). */
  tileLayout?: 'flat' | 'nested' | 'auto';
  onError?: (message: string) => void;
  onWarning?: (message: string) => void;
  onLoadingChange?: (loading: boolean, progress: number) => void;
  onTilesChanged?: () => void;
  onReady?: () => void;
  onManifestLoaded?: (manifest: TileManifest) => void;
}

interface InflightTask {
  key: string;
  x: number;
  y: number;
  url: string;
  /** Second URL candidate (`<base>/x_y.json` vs `<base>/tiles/x_y.json`). */
  alternateUrl: string | null;
  usedAlternate: boolean;
  attempts: number;
  cancelled: boolean;
  requestId: number | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

interface InlineJob {
  task: InflightTask;
  resolve: (payload: TileWirePayload) => void;
  reject: (error: Error) => void;
}

interface DesiredTile {
  entry: TileIndexEntry;
  key: string;
  distance: number;
}

const DEFAULT_MAX_LOADED_TILES = 40;
const MAX_TILES_IN_VIEW = 120;
/** View/zoom distance below which the cached visible set is reused instead of
 * rebuilding it: recomputing 400-tile candidates every frame causes GC churn. */
const DESIRED_RECOMPUTE_TARGET_STEP_TILES = 0.2;
const DESIRED_RECOMPUTE_ZOOM_RATIO = 0.06;
const MAX_CONCURRENT_TILE_LOADS = 6;
const TILE_LOAD_MARGIN_TILES = 1;
/** Facade windows are only worth shading when one low-res pixel covers less
 * than this much ground (world metres per pixel). Above it, the window pattern
 * would alias into a dark smear, so far tiles use flat, detailed-off walls. */
const DETAIL_WORLD_PER_PIXEL = 1.0;
/**
 * Ground texture LOD tiers and GPU budget. Each tile shows ONE ground texture:
 *
 *  - fine   (base / 2, min 0.25 m): the MAX_FINE_GROUND_TILES visible tiles
 *    nearest the camera target while a render pixel is under ~0.6 m — at the
 *    base 1 m (city) lane dashes become blobs;
 *  - base   (0.5 m pilot / 1 m city): the MAX_BASE_GROUND_TILES nearest visible
 *    tiles while a render pixel is under ~3 m;
 *  - coarse (base × 4, no paint): everything else — the whole-city overview
 *    keeps all 144 tiles resident, and 1024² textures for each (≈770 MB with
 *    mips) would be pointless at 14 m per pixel.
 *
 * Budget: 6 × 21 MB + 24 × 5.3 MB + rest × 0.35 MB ≈ 300 MB for the city.
 * A tile keeps showing its current texture until the re-rasterised one (ground
 * and bridge decks only, in a worker) arrives; hysteresis avoids churn.
 */
const GROUND_FINE_ENTER_WPP = 0.6;
const GROUND_FINE_EXIT_WPP = 0.8;
const GROUND_BASE_ENTER_WPP = 3.0;
const GROUND_BASE_EXIT_WPP = 4.0;
const MAX_FINE_GROUND_TILES = 6;
const MAX_BASE_GROUND_TILES = 24;
const GROUND_FINE_MIN_RES = 0.25;
const GROUND_COARSE_FACTOR = 4;
const MAX_GROUND_JOBS = 2;
type GroundTier = 'fine' | 'base' | 'coarse';
const MAX_ADDS_PER_FRAME = 2;
const TILE_FETCH_TIMEOUT_GUARD_MS = 35_000;
const BASE_PLANE_SIZE = 12_000;

/** Ground plate geometry with a baked linear vertex colour for the env material. */
function createGroundPlaneGeometry(width: number, depth: number): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(width, depth);
  const baseGroundColor = new THREE.Color(ENV_PALETTE.ground);
  const positionCount = (geometry.getAttribute('position') as THREE.BufferAttribute).count;
  const colors = new Float32Array(positionCount * 3);
  for (let i = 0; i < positionCount; i += 1) {
    colors[i * 3] = baseGroundColor.r;
    colors[i * 3 + 1] = baseGroundColor.g;
    colors[i * 3 + 2] = baseGroundColor.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class TileStreamer {
  manifest: TileManifest | null = null;
  manifestError: string | null = null;

  private readonly options: TileStreamerOptions;
  private readonly tiles = new Map<string, TileEntry>();
  private readonly inflight = new Map<string, InflightTask>();
  /** URL each resident tile was loaded from (ground LOD re-requests). */
  private readonly tileUrls = new Map<string, string>();
  /** Pending ground re-raster jobs by tile key. */
  private readonly groundUpgrades = new Map<string, { id: number; res: number; cancelled: boolean }>();
  private groundFineActive = false;
  private groundBaseActive = true;
  private readonly failedKeys = new Set<string>();
  private readonly tileIndex = new Map<string, TileIndexEntry>();
  private readonly payloadQueue: TileWirePayload[] = [];
  private readonly forcedKeys = new Set<string>();
  private readonly pool: TileWorkerPool;
  private readonly root: THREE.Group;
  private readonly basePlane: THREE.Mesh;
  private basePlaneGeometry: THREE.PlaneGeometry;
  private readonly basePlaneMaterial: THREE.Material;
  private readonly diagnostics: string[] = [];
  private readonly maxLoadedTiles: number;
  private readonly demo: boolean;
  private readonly nolimit: boolean;
  private readonly manifestUrl: string;
  private readonly dataBaseUrl: string;
  private readonly initialTileTarget: number;
  private readonly keepBasePlate: boolean;
  private readonly initialBudget: number;
  private readonly idleTopUpAfterMs: number;
  private readonly topUpStepTiles: number;
  private readonly maxTopUpGeometryMB: number;
  private readonly tileLayout: 'flat' | 'nested' | 'auto';
  private desiredBudget: number;
  private lastCameraMotionAt = 0;
  private readyAt = 0;
  private lastTopUpAt = 0;
  private topUpStopped = false;
  private previousTargetX = Number.NaN;
  private previousTargetZ = Number.NaN;
  private previousOrthoHeight = Number.NaN;
  /** Tile grid size is owned by the manifest (512 m central, 1024 m city). */
  private tileSize: number = TILE_SIZE_M;
  private desiredDirty = true;
  private lastDesiredTargetX = Number.NaN;
  private lastDesiredTargetZ = Number.NaN;
  private lastDesiredOrthoHeight = Number.NaN;

  private inlineMode = false;
  private inlineRunning = false;
  private inlineQueue: InlineJob[] = [];
  private disposed = false;
  private visibleKeys = new Set<string>();
  private desired: DesiredTile[] = [];
  private initialKeys: Set<string> | null = null;
  private initialTarget = 0;
  private readyNotified = false;
  private loadingNotified = false;
  private tilesChangedPending = false;
  private readyWatchdog: ReturnType<typeof setTimeout> | null = null;
  private tileFailureCount = 0;
  private loadingProgress = 0;
  private lastTargetX = Number.NaN;
  private lastTargetZ = Number.NaN;
  private lastOrthoHeight = Number.NaN;
  private lastRenderHeight = 0;

  private buildingCount = 0;
  private geometryBytes = 0;
  private nightFactor = 0;

  constructor(options: TileStreamerOptions) {
    this.options = options;
    this.root = options.root;
    this.demo = Boolean(options.demo);
    this.nolimit = Boolean(options.nolimit);
    this.maxLoadedTiles = Math.max(
      4,
      options.maxLoadedTiles ?? (this.nolimit ? 400 : DEFAULT_MAX_LOADED_TILES),
    );
    this.manifestUrl = options.manifestUrl ?? TILE_MANIFEST_URL;
    this.dataBaseUrl = options.dataBaseUrl ?? DATA_BASE_URL;
    this.initialTileTarget = Math.max(
      1,
      options.initialTileTarget ?? Number.MAX_SAFE_INTEGER,
    );
    this.keepBasePlate = Boolean(options.keepBasePlate);
    this.initialBudget = Math.max(
      4,
      Math.min(options.initialBudget ?? this.maxLoadedTiles, this.maxLoadedTiles),
    );
    this.desiredBudget = this.initialBudget;
    this.idleTopUpAfterMs = Math.max(0, options.idleTopUpAfterMs ?? 0);
    this.topUpStepTiles = Math.max(1, options.topUpStepTiles ?? 32);
    this.maxTopUpGeometryMB = Math.max(0, options.maxTopUpGeometryMB ?? 0);
    this.tileLayout = options.tileLayout ?? 'auto';

    this.basePlaneMaterial = options.environmentMaterial;
    this.basePlaneGeometry = createGroundPlaneGeometry(BASE_PLANE_SIZE, BASE_PLANE_SIZE);
    this.basePlane = new THREE.Mesh(this.basePlaneGeometry, this.basePlaneMaterial);
    this.basePlane.rotation.x = -Math.PI / 2;
    this.basePlane.position.y = GROUND_LAYER_Y.base - 0.09;
    // No shadow receiving: the shadow camera only covers the visible footprint,
    // which would otherwise show its frustum boundary as a diagonal band.
    this.basePlane.receiveShadow = false;
    this.basePlane.castShadow = false;
    this.basePlane.frustumCulled = false;
    this.basePlane.name = 'base-ground';
    this.root.add(this.basePlane);

    this.pool = new TileWorkerPool({
      size: Math.max(1, Math.min(options.workerCount ?? 2, 4)),
      onFatal: (reason) => {
        this.diagnostics.push(`worker pool unavailable: ${reason}`);
        this.inlineMode = true;
      },
    });
    if (!this.pool.available) {
      this.inlineMode = true;
      this.diagnostics.push(`tile builds fall back to the main thread: ${this.pool.fatalReason}`);
    }
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.demo) {
      await this.loadDemo();
      return;
    }
    try {
      const manifest = await this.fetchManifest();
      if (this.disposed) return;
      this.installManifest(manifest);
      this.options.onLoadingChange?.(true, 0);
      this.loadingNotified = true;
      this.readyWatchdog = setTimeout(() => {
        if (!this.readyNotified) this.notifyReady('initial tile load took too long');
      }, TILE_FETCH_TIMEOUT_GUARD_MS);
    } catch (error) {
      if (this.disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.manifestError = message;
      const friendly = `City data unavailable (${message}). Rendering the ground plane only.`;
      this.diagnostics.push(friendly);
      this.options.onError?.(friendly);
      this.options.onLoadingChange?.(false, 0);
      this.loadingNotified = true;
      this.notifyReady('manifest failed');
    }
  }

  private async fetchManifest(): Promise<TileManifest> {
    let lastError: unknown = new Error('manifest not fetched');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(this.manifestUrl, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${this.manifestUrl}`);
        const manifest = (await response.json()) as TileManifest;
        if (!manifest || !Array.isArray(manifest.tiles) || manifest.tiles.length === 0) {
          throw new Error('manifest is missing a non-empty tiles array');
        }
        return manifest;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await delay(600);
      }
    }
    throw lastError;
  }

  private installManifest(manifest: TileManifest): void {
    this.manifest = manifest;
    // The manifest owns the tile grid size (512 m central, 1024 m city).
    this.tileSize =
      typeof manifest.tileSize === 'number' && manifest.tileSize > 0
        ? manifest.tileSize
        : TILE_SIZE_M;
    this.tileIndex.clear();
    for (const entry of manifest.tiles) {
      if (!entry || typeof entry.x !== 'number' || typeof entry.y !== 'number') continue;
      this.tileIndex.set(tileKey(entry.x, entry.y), entry);
    }

    if (this.keepBasePlate) {
      // City overview: the resident budget intentionally skips the furthest
      // visible tiles (nearest-first policy), so the plate fills those holes
      // with matching ground colour instead of showing sky. Sized to the data
      // bounds plus two tiles so its edge sits far outside the framed city.
      this.rebuildBasePlate(manifest.bounds, this.tileSize * 2);
    } else {
      // Central dataset: a clean floating diorama, plate only as the no-data
      // fallback (it used to show as a straight-edged band at the horizon).
      this.basePlane.visible = false;
    }
    this.desiredDirty = true;
    this.options.onManifestLoaded?.(manifest);
  }

  private rebuildBasePlate(
    bounds: [number, number, number, number],
    margin: number,
  ): void {
    const width = Math.max(1000, Math.abs(bounds[2] - bounds[0]) + margin * 2);
    const depth = Math.max(1000, Math.abs(bounds[3] - bounds[1]) + margin * 2);
    this.basePlane.geometry = createGroundPlaneGeometry(width, depth);
    this.basePlaneGeometry.dispose();
    this.basePlaneGeometry = this.basePlane.geometry as THREE.PlaneGeometry;
    const centreX = (bounds[0] + bounds[2]) * 0.5;
    const centreY = (bounds[1] + bounds[3]) * 0.5;
    this.basePlane.position.set(centreX, GROUND_LAYER_Y.base - 0.09, -centreY);
    this.basePlane.visible = true;
  }

  private async loadDemo(): Promise<void> {
    const manifest = createDemoManifest();
    this.installManifest(manifest);
    const tiles = createDemoTiles();
    this.options.onLoadingChange?.(true, 0);
    this.loadingNotified = true;
    for (let i = 0; i < tiles.length; i += 1) {
      if (this.disposed) return;
      const payload = buildTilePayload(tiles[i], { facadeDetail: true, trees: true });
      this.addTileFromPayload(payload);
      this.options.onLoadingChange?.(true, (i + 1) / tiles.length);
      await nextTick();
    }
    this.initialKeys = new Set(this.tiles.keys());
    this.initialTarget = this.initialKeys.size;
    this.loadingProgress = 1;
    this.options.onLoadingChange?.(false, 1);
    this.notifyReady('demo city loaded');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.readyWatchdog) clearTimeout(this.readyWatchdog);
    for (const task of this.inflight.values()) {
      task.cancelled = true;
      if (task.retryTimer) clearTimeout(task.retryTimer);
      if (task.requestId !== null) this.pool.cancel(task.requestId);
    }
    this.inflight.clear();
    for (const job of this.inlineQueue) job.reject(new Error('streamer disposed'));
    this.inlineQueue.length = 0;
    this.payloadQueue.length = 0;
    this.pool.dispose();
    for (const key of [...this.tiles.keys()]) this.evictTile(key);
    this.root.remove(this.basePlane);
    this.basePlaneGeometry.dispose();
    // The base plane shares the tile environment material (owned by the app).
    this.tiles.clear();
    this.tileIndex.clear();
    this.buildingCount = 0;
    this.geometryBytes = 0;
  }

  // -------------------------------------------------------------------------
  // per-frame update
  // -------------------------------------------------------------------------

  update(rig: IsometricCameraRig, renderHeightPx: number): void {
    if (this.disposed) return;
    if (!this.manifest) return;

    const worldPerPixel = rig.getPixelWorldSize(renderHeightPx);
    const target = rig.getTargetWorld();
    const orthoHeight = rig.getOrthoHeight();
    this.lastTargetX = target.x;
    this.lastTargetZ = target.z;
    this.lastOrthoHeight = orthoHeight;
    this.lastRenderHeight = renderHeightPx;

    // Rebuild the visible set only when the camera moved/zoomed enough to change
    // it: at city scale the candidate list is several hundred tiles and the
    // per-frame cost would otherwise dominate.
    const targetStep = this.tileSize * DESIRED_RECOMPUTE_TARGET_STEP_TILES;
    const moved =
      !Number.isFinite(this.lastDesiredTargetX) ||
      Math.abs(target.x - this.lastDesiredTargetX) > targetStep ||
      Math.abs(target.z - this.lastDesiredTargetZ) > targetStep;
    const zoomed =
      !Number.isFinite(this.lastDesiredOrthoHeight) ||
      Math.abs(Math.log(orthoHeight / this.lastDesiredOrthoHeight)) >
        DESIRED_RECOMPUTE_ZOOM_RATIO;
    if (this.desiredDirty || moved || zoomed) {
      this.computeDesired(rig, target);
      this.desiredDirty = false;
      this.lastDesiredTargetX = target.x;
      this.lastDesiredTargetZ = target.z;
      this.lastDesiredOrthoHeight = orthoHeight;
    }
    // Track true camera motion (damping counts) so the idle top-up only runs
    // once the view has actually settled.
    if (
      !Number.isFinite(this.previousTargetX) ||
      target.x !== this.previousTargetX ||
      target.z !== this.previousTargetZ ||
      orthoHeight !== this.previousOrthoHeight
    ) {
      this.previousTargetX = target.x;
      this.previousTargetZ = target.z;
      this.previousOrthoHeight = orthoHeight;
      this.lastCameraMotionAt = performance.now();
    }
    this.maybeTopUpIdle(performance.now());
    this.beginInitialPhaseIfNeeded();
    this.touchAndEvict();
    // Ground LOD tier state first: new tiles are requested at the current tier.
    this.updateGroundTierState((2 * orthoHeight) / Math.max(1, renderHeightPx));
    this.requestMissingTiles();
    this.processPayloadQueue();
    // City dataset: the ground plate covers the parts of the city that are not
    // resident yet; hide it as soon as the full visible set is loaded so the
    // finished overview is a clean floating diorama (no plate ring/corners).
    if (this.keepBasePlate) {
      this.basePlane.visible = this.tiles.size < this.desired.length;
    }
    this.updateLod(renderHeightPx, rig);
    this.updateLoadingProgress();
    if (this.tilesChangedPending) {
      this.tilesChangedPending = false;
      this.options.onTilesChanged?.();
    }
    void worldPerPixel;
  }

  private computeDesired(rig: IsometricCameraRig, target: THREE.Vector3): void {
    const manifest = this.manifest;
    if (!manifest) return;
    let candidates: Array<{ x: number; y: number; entry: TileIndexEntry; distance: number }> = [];

    if (this.nolimit) {
      for (const entry of manifest.tiles) {
        candidates.push({ x: entry.x, y: entry.y, entry, distance: 0 });
      }
    } else {
      const footprint = rig.getVisibleGroundRect(220);
      // World XZ -> local metres: localX = worldX, localY = -worldZ.
      const minLocalX = footprint.minX;
      const maxLocalX = footprint.maxX;
      const minLocalY = -footprint.maxZ;
      const maxLocalY = -footprint.minZ;
      const margin = this.tileSize * TILE_LOAD_MARGIN_TILES;
      const addresses = tilesInRect(
        minLocalX - margin,
        minLocalY - margin,
        maxLocalX + margin,
        maxLocalY + margin,
        this.tileSize,
      );
      for (const address of addresses) {
        const key = tileKey(address.x, address.y);
        const entry = this.tileIndex.get(key);
        if (!entry) continue;
        const [bx0, by0, bx1, by1] = tileBounds(address.x, address.y, this.tileSize);
        const centreX = (bx0 + bx1) * 0.5;
        const centreZ = -(by0 + by1) * 0.5;
        const distance = Math.hypot(centreX - target.x, centreZ - target.z);
        candidates.push({ x: address.x, y: address.y, entry, distance });
      }
      // Forced (preloaded) tiles join the visible set so they stay resident.
      for (const key of this.forcedKeys) {
        const entry = this.tileIndex.get(key);
        if (!entry) continue;
        if (candidates.some((candidate) => tileKey(candidate.x, candidate.y) === key)) continue;
        const [bx0, by0, bx1, by1] = tileBounds(entry.x, entry.y, this.tileSize);
        const distance = Math.hypot(
          (bx0 + bx1) * 0.5 - target.x,
          -(by0 + by1) * 0.5 - target.z,
        );
        candidates.push({ x: entry.x, y: entry.y, entry, distance });
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);
    // Deterministic streaming budget: keep the nearest `desiredBudget` tiles.
    // The budget starts at `initialBudget` (fast first render) and, once the
    // camera has been idle for `idleTopUpAfterMs`, grows in steps towards the
    // hard `maxLoadedTiles` cap (which is also the LRU eviction limit). This
    // gives a quick nearest-first city centre and a complete city a moment later
    // without ever loading 100% of a 400-tile visible set synchronously.
    const viewCap = Math.max(MAX_TILES_IN_VIEW, this.maxLoadedTiles);
    if (candidates.length > viewCap) candidates = candidates.slice(0, viewCap);
    const budget = Math.min(this.desiredBudget, this.maxLoadedTiles);
    if (candidates.length > budget) {
      candidates = candidates.slice(0, budget);
    }
    this.desired = candidates.map((candidate) => ({
      entry: candidate.entry,
      key: tileKey(candidate.x, candidate.y),
      distance: candidate.distance,
    }));
    this.visibleKeys = new Set(this.desired.map((entry) => entry.key));
  }

  /** Idle top-up: grow the visible budget towards the hard cap after the camera
   * settles (and stop if the geometry memory guard is reached). */
  private maybeTopUpIdle(now: number): void {
    if (this.topUpStopped) return;
    if (this.desiredBudget >= this.maxLoadedTiles) return;
    if (!this.readyNotified || this.idleTopUpAfterMs <= 0) return;
    if (now - Math.max(this.lastCameraMotionAt, this.readyAt) < this.idleTopUpAfterMs) {
      return;
    }
    // Only start upgrading once the current budget is actually resident.
    const residentTarget = Math.min(this.desiredBudget, this.desired.length);
    if (this.tiles.size < residentTarget) return;
    if (now - this.lastTopUpAt < 1200) return;
    if (this.maxTopUpGeometryMB > 0 && this.geometryMB >= this.maxTopUpGeometryMB) {
      this.topUpStopped = true;
      this.diagnostics.push(
        `idle top-up stopped at ${this.geometryMB.toFixed(0)} MB geometry (cap ${this.maxTopUpGeometryMB} MB)`,
      );
      return;
    }
    this.lastTopUpAt = now;
    this.desiredBudget = Math.min(
      this.maxLoadedTiles,
      this.desiredBudget + this.topUpStepTiles,
    );
    this.desiredDirty = true;
  }

  private beginInitialPhaseIfNeeded(): void {
    if (this.initialKeys) return;
    const keys = this.desired.map((entry) => entry.key);
    // Ready after the nearest `initialTileTarget` tiles (48 at city scale) so the
    // first render is quick; the remaining visible tiles stream in afterwards.
    const eligible = Math.max(1, Math.min(keys.length, this.initialTileTarget));
    this.initialKeys = new Set(keys.slice(0, eligible));
    this.initialTarget = eligible;
    // The initial phase always finishes even if some tiles fail.
    if (this.initialTarget === 0) {
      this.initialTarget = 1;
      this.loadingProgress = 1;
    }
  }

  private touchAndEvict(): void {
    const now = performance.now();
    for (const key of this.visibleKeys) {
      const entry = this.tiles.get(key);
      if (!entry) continue;
      if (now - entry.lastUsed > 1000) {
        entry.lastUsed = now;
        // Re-insert to move the entry to the most-recently-used end of the map.
        this.tiles.delete(key);
        this.tiles.set(key, entry);
      }
    }

    if (this.tiles.size <= this.maxLoadedTiles) return;
    for (const key of [...this.tiles.keys()]) {
      if (this.tiles.size <= this.maxLoadedTiles) break;
      if (this.visibleKeys.has(key)) continue;
      this.evictTile(key);
    }
  }

  private requestMissingTiles(): void {
    let inFlightCount = this.inflight.size;
    for (const desired of this.desired) {
      if (inFlightCount >= MAX_CONCURRENT_TILE_LOADS) break;
      if (this.tiles.has(desired.key)) continue;
      if (this.inflight.has(desired.key)) continue;
      if (this.failedKeys.has(desired.key)) continue;
      this.startRequest(desired.entry, desired.key);
      inFlightCount += 1;
    }
  }

  /** Preload the tiles around a local-metre point (used by loadAreaAround). */
  ensureArea(localX: number, localY: number, radiusTiles = 1): void {
    if (this.disposed || !this.manifest) return;
    this.desiredDirty = true;
    const address = {
      x: Math.floor(localX / this.tileSize),
      y: Math.floor(localY / this.tileSize),
    };
    for (let dy = -radiusTiles; dy <= radiusTiles; dy += 1) {
      for (let dx = -radiusTiles; dx <= radiusTiles; dx += 1) {
        const key = tileKey(address.x + dx, address.y + dy);
        const entry = this.tileIndex.get(key);
        if (!entry) continue;
        this.forcedKeys.add(key);
        if (!this.tiles.has(key) && !this.inflight.has(key) && !this.failedKeys.has(key)) {
          this.startRequest(entry, key);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // tile building
  // -------------------------------------------------------------------------

  private startRequest(entry: TileIndexEntry, key: string): void {
    const urls = this.tileUrlCandidates(entry);
    const task: InflightTask = {
      key,
      x: entry.x,
      y: entry.y,
      url: urls[0],
      alternateUrl: urls[1] ?? null,
      usedAlternate: false,
      attempts: 0,
      cancelled: false,
      requestId: null,
      retryTimer: null,
    };
    this.inflight.set(key, task);
    void this.attemptLoad(task);
  }

  /**
   * Candidate payload URLs for a manifest entry. The manifest stores the path
   * relative to the data root ("tiles/3_4.json"); the dataset resolver gives the
   * dataset base ("/data/tiles" or "/data/city-tiles"). Depending on how a
   * dataset is laid out the file can live directly under the base or in a nested
   * `tiles/` directory, so both are tried (the second only on failure).
   */
  private tileUrlCandidates(entry: TileIndexEntry): string[] {
    const direct = (file: string): string => {
      if (/^https?:/i.test(file)) return file;
      if (file.startsWith('/')) return file;
      return `${this.dataBaseUrl}/${file}`;
    };
    const fallbackName = `${tileKey(entry.x, entry.y)}.json`;
    if (!entry.file) {
      return [direct(fallbackName)];
    }
    const stripped = entry.file.replace(/^tiles\//, '');
    const flat = direct(stripped);
    const nested = direct(entry.file);
    const order =
      this.tileLayout === 'nested'
        ? [nested, flat]
        : this.tileLayout === 'flat'
          ? [flat, nested]
          : [flat, nested];
    return [...new Set(order)];
  }

  private async attemptLoad(task: InflightTask): Promise<void> {
    try {
      let payload: TileWirePayload | null = null;
      if (this.inlineMode || !this.pool.available) {
        payload = await this.loadInline(task);
      } else {
        const job = this.pool.load({
          key: task.key,
          url: task.url,
          facadeDetail: true,
          trees: true,
          groundMode: this.options.groundMode,
          groundRes: this.options.groundRes ?? this.groundResFor(this.groundBaseActive ? 'base' : 'coarse'),
        });
        task.requestId = job.id;
        payload = await job.promise;
        task.requestId = null;
      }
      if (this.disposed || task.cancelled) {
        this.finishTask(task);
        return;
      }
      this.finishTask(task);
      if (!payload) return;
      this.tileUrls.set(task.key, task.url);
      this.enqueuePayload(payload);
    } catch (error) {
      if (this.disposed || task.cancelled) {
        this.finishTask(task);
        return;
      }
      // Try the alternate layout first (flat file vs nested tiles/ directory).
      if (!task.usedAlternate && task.alternateUrl) {
        task.usedAlternate = true;
        const previous = task.url;
        task.url = task.alternateUrl;
        task.alternateUrl = previous;
        task.retryTimer = setTimeout(() => {
          task.retryTimer = null;
          if (this.disposed || task.cancelled) return;
          void this.attemptLoad(task);
        }, 150);
        return;
      }
      task.attempts += 1;
      if (task.attempts <= 1) {
        // Retry once, preferring the inline path when the worker pool died.
        task.retryTimer = setTimeout(() => {
          task.retryTimer = null;
          if (this.disposed || task.cancelled) return;
          void this.attemptLoad(task);
        }, 800);
        if (!this.pool.available) this.inlineMode = true;
      } else {
        this.finishTask(task);
        this.recordTileFailure(task, error);
      }
    }
  }

  private async loadInline(task: InflightTask): Promise<TileWirePayload> {
    return await new Promise<TileWirePayload>((resolve, reject) => {
      if (this.disposed || task.cancelled) {
        reject(new Error('cancelled'));
        return;
      }
      this.inlineQueue.push({ task, resolve, reject });
      void this.pumpInlineQueue();
    });
  }

  private async pumpInlineQueue(): Promise<void> {
    if (this.inlineRunning || this.disposed) return;
    this.inlineRunning = true;
    try {
      while (this.inlineQueue.length > 0 && !this.disposed) {
        const job = this.inlineQueue.shift();
        if (!job) break;
        if (job.task.cancelled) {
          job.reject(new Error('cancelled'));
          continue;
        }
        try {
          const response = await fetch(job.task.url, { cache: 'no-cache' });
          if (!response.ok) throw new Error(`HTTP ${response.status} for ${job.task.url}`);
          const data = (await response.json()) as TileData;
          // Yield once so the loading indicator can paint before the
          // synchronous geometry build.
          await nextTick();
          const payload = buildTilePayload(data, {
            facadeDetail: true,
            trees: true,
            groundMode: this.options.groundMode,
            groundRes: this.options.groundRes,
          });
          job.resolve(payload);
        } catch (error) {
          job.reject(error instanceof Error ? error : new Error(String(error)));
        }
        await nextTick();
      }
    } finally {
      this.inlineRunning = false;
      if (this.inlineQueue.length > 0 && !this.disposed) void this.pumpInlineQueue();
    }
  }

  private finishTask(task: InflightTask): void {
    if (task.retryTimer) {
      clearTimeout(task.retryTimer);
      task.retryTimer = null;
    }
    if (this.inflight.get(task.key) === task) this.inflight.delete(task.key);
  }

  private recordTileFailure(task: InflightTask, error: unknown): void {
    this.failedKeys.add(task.key);
    this.tileFailureCount += 1;
    const message = `tile ${task.key} failed: ${error instanceof Error ? error.message : String(error)}`;
    this.diagnostics.push(message);
    if (this.tileFailureCount === 3) {
      this.options.onWarning?.(`${this.tileFailureCount} tiles failed to load; keeping the map interactive`);
    }
  }

  private enqueuePayload(payload: TileWirePayload): void {
    if (payload.buildWarning) this.diagnostics.push(`tile ${payload.key}: ${payload.buildWarning}`);
    if (this.payloadQueue.length >= 24) {
      // Extremely unlikely: drop the oldest queued payload rather than grow
      // without bound.
      this.payloadQueue.shift();
    }
    this.payloadQueue.push(payload);
  }

  private processPayloadQueue(): void {
    let added = 0;
    while (this.payloadQueue.length > 0 && added < MAX_ADDS_PER_FRAME) {
      const payload = this.payloadQueue.shift();
      if (!payload) break;
      if (this.disposed) return;
      if (this.tiles.has(payload.key)) continue;
      if (
        !this.visibleKeys.has(payload.key) &&
        !this.initialKeys?.has(payload.key) &&
        this.tiles.size >= this.maxLoadedTiles
      ) {
        continue;
      }
      this.addTileFromPayload(payload);
      added += 1;
    }
  }

  // -------------------------------------------------------------------------
  // tile meshes
  // -------------------------------------------------------------------------

  private addTileFromPayload(payload: TileWirePayload): void {
    const group = new THREE.Group();
    group.name = `tile-${payload.key}`;
    group.matrixAutoUpdate = false;

    const buildings = new Map<FeatureId, BuildingFeature>();
    for (const building of payload.buildings) buildings.set(building.id, building);

    let triangleOwner: Uint32Array | null = null;
    if (payload.triangleOwner) {
      triangleOwner = new Uint32Array(payload.triangleOwner);
      if (triangleOwner.length !== payload.triangleOwnerLength) {
        const exact = new Uint32Array(payload.triangleOwnerLength);
        exact.set(triangleOwner.subarray(0, payload.triangleOwnerLength));
        triangleOwner = exact;
      }
    }

    let buildingMesh: THREE.Mesh | null = null;
    let triangles = 0;
    let bytes = 0;
    if (payload.buildingGeometry && payload.buildingGeometry.triangleCount > 0) {
      const geometry = unpackGeometry(payload.buildingGeometry);
      buildingMesh = new THREE.Mesh(geometry, this.options.facadeMaterialNear);
      buildingMesh.castShadow = true;
      buildingMesh.receiveShadow = true;
      buildingMesh.matrixAutoUpdate = false;
      buildingMesh.userData.tileKey = payload.key;
      buildingMesh.name = `buildings-${payload.key}`;
      group.add(buildingMesh);
      triangles += payload.buildingGeometry.triangleCount;
      bytes += wireMeshBytes(payload.buildingGeometry);
    }

    let environmentMesh: THREE.Mesh | null = null;
    if (payload.environment && payload.environment.triangleCount > 0) {
      const geometry = unpackGeometry(payload.environment);
      environmentMesh = new THREE.Mesh(geometry, this.options.environmentMaterial);
      environmentMesh.receiveShadow = true;
      environmentMesh.castShadow = false;
      environmentMesh.matrixAutoUpdate = false;
      environmentMesh.name = `environment-${payload.key}`;
      group.add(environmentMesh);
      triangles += payload.environment.triangleCount;
      bytes += wireMeshBytes(payload.environment);
    }

    let groundMesh: THREE.Mesh | null = null;
    if (payload.ground && payload.ground.data.byteLength > 0) {
      const texture = createGroundTexture(
        payload.ground.data,
        payload.ground.width,
        payload.ground.height,
      );
      const material = createGroundMaterial(texture);
      groundMesh = new THREE.Mesh(
        createGroundQuad(payload.ground.bounds, GROUND_LAYER_Y.base),
        material,
      );
      groundMesh.receiveShadow = true;
      groundMesh.castShadow = false;
      groundMesh.matrixAutoUpdate = false;
      groundMesh.name = `ground-${payload.key}`;
      group.add(groundMesh);
      triangles += 2;
      bytes += payload.ground.data.byteLength;
    }

    const deckMesh = createDeckMesh(payload);
    if (deckMesh && payload.decks) {
      group.add(deckMesh);
      triangles += payload.decks.mesh.triangleCount;
      bytes += wireMeshBytes(payload.decks.mesh) + payload.decks.texture.data.byteLength;
    }

    let treeMesh: THREE.Mesh | null = null;
    if (payload.trees && payload.trees.triangleCount > 0) {
      const geometry = unpackGeometry(payload.trees);
      treeMesh = new THREE.Mesh(geometry, this.options.treeMaterial);
      treeMesh.castShadow = true;
      treeMesh.receiveShadow = true;
      treeMesh.matrixAutoUpdate = false;
      treeMesh.name = `trees-${payload.key}`;
      group.add(treeMesh);
      triangles += payload.trees.triangleCount;
      bytes += wireMeshBytes(payload.trees);
    }

    group.updateMatrixWorld(true);
    this.root.add(group);

    const entry: TileEntry = {
      key: payload.key,
      x: payload.x,
      y: payload.y,
      bounds: payload.bounds,
      group,
      buildingMesh,
      environmentMesh,
      treeMesh,
      groundMesh,
      deckMesh,
      groundRes: payload.ground?.res ?? 0,
      buildings,
      buildingIds: payload.buildingIds,
      triangleOwner,
      lod: 'near',
      triangles,
      bytes,
      lastUsed: performance.now(),
    };

    this.tiles.delete(payload.key);
    this.tiles.set(payload.key, entry);
    this.buildingCount += buildings.size;
    this.geometryBytes += bytes;
    this.tilesChangedPending = true;
    this.failedKeys.delete(payload.key);
  }

  private evictTile(key: string): void {
    const entry = this.tiles.get(key);
    if (!entry) return;
    this.tiles.delete(key);
    this.root.remove(entry.group);
    entry.group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
      }
    });
    const upgrade = this.groundUpgrades.get(key);
    if (upgrade) {
      upgrade.cancelled = true;
      this.pool.cancel(upgrade.id);
      this.groundUpgrades.delete(key);
    }
    this.tileUrls.delete(key);
    const materials = new Set<THREE.Material>();
    for (const textured of [entry.groundMesh, entry.deckMesh]) {
      if (textured) materials.add(textured.material as THREE.Material);
    }
    for (const material of materials) {
      (material as THREE.MeshLambertMaterial).map?.dispose();
      material.dispose();
    }
    entry.group.clear();
    this.buildingCount = Math.max(0, this.buildingCount - entry.buildings.size);
    this.geometryBytes = Math.max(0, this.geometryBytes - entry.bytes);
    this.tilesChangedPending = true;
  }

  /** 0..1 night factor: at night we keep window detail on even for far tiles so
   * the overview shows warm lit-window dots instead of flat silhouettes. */
  setNightFactor(nightFactor: number): void {
    this.nightFactor = Number.isFinite(nightFactor)
      ? Math.max(0, Math.min(1, nightFactor))
      : 0;
  }

  private updateLod(renderHeightPx: number, rig: IsometricCameraRig): void {
    const orthoHeight = rig.getOrthoHeight();
    const worldPerPixel = (2 * orthoHeight) / Math.max(1, renderHeightPx);
    this.updateGroundLod(worldPerPixel, rig);
    const wantNear = worldPerPixel <= DETAIL_WORLD_PER_PIXEL || this.nightFactor > 0.35;
    for (const key of this.visibleKeys) {
      const entry = this.tiles.get(key);
      if (!entry || !entry.buildingMesh) continue;
      const targetLod = wantNear ? 'near' : 'far';
      if (entry.lod === targetLod) continue;
      entry.lod = targetLod;
      entry.buildingMesh.material =
        targetLod === 'near'
          ? this.options.facadeMaterialNear
          : this.options.facadeMaterialFar;
    }
  }

  /** Texel size of a ground LOD tier for this dataset's tiles. */
  private groundResFor(tier: GroundTier): number {
    const base = groundResolutionFor(this.tileSize);
    if (tier === 'fine') return Math.max(GROUND_FINE_MIN_RES, base / 2);
    if (tier === 'coarse') return base * GROUND_COARSE_FACTOR;
    return base;
  }

  /** Zoom-driven tier switches, with hysteresis. */
  private updateGroundTierState(worldPerPixel: number): void {
    if (!Number.isFinite(worldPerPixel)) return;
    this.groundFineActive = this.groundFineActive
      ? worldPerPixel <= GROUND_FINE_EXIT_WPP
      : worldPerPixel <= GROUND_FINE_ENTER_WPP;
    this.groundBaseActive = this.groundBaseActive
      ? worldPerPixel <= GROUND_BASE_EXIT_WPP
      : worldPerPixel <= GROUND_BASE_ENTER_WPP;
  }

  /** Choose every tile's ground tier and re-rasterise the ones that differ. */
  private updateGroundLod(worldPerPixel: number, rig: IsometricCameraRig): void {
    if (this.options.groundRes || this.inlineMode || !this.pool.available) return;
    this.updateGroundTierState(worldPerPixel);
    const target = rig.getTargetLocal();
    const ranked: { entry: TileEntry; distance: number }[] = [];
    for (const key of this.visibleKeys) {
      const entry = this.tiles.get(key);
      if (!entry?.groundMesh) continue;
      const [x0, y0, x1, y1] = entry.bounds;
      const dx = Math.max(x0 - target.x, 0, target.x - x1);
      const dy = Math.max(y0 - target.y, 0, target.y - y1);
      ranked.push({ entry, distance: Math.hypot(dx, dy) });
    }
    ranked.sort((a, b) => a.distance - b.distance);
    const wanted = new Map<string, number>();
    ranked.forEach(({ entry }, index) => {
      const tier: GroundTier =
        this.groundFineActive && index < MAX_FINE_GROUND_TILES
          ? 'fine'
          : this.groundBaseActive && index < MAX_BASE_GROUND_TILES
            ? 'base'
            : 'coarse';
      wanted.set(entry.key, this.groundResFor(tier));
    });
    // Nearest first, so the tiles under the camera upgrade before the rest.
    const order = [...ranked.map((item) => item.entry)];
    for (const entry of this.tiles.values()) if (!wanted.has(entry.key)) order.push(entry);
    for (const entry of order) {
      if (!entry.groundMesh) continue;
      const res = wanted.get(entry.key) ?? this.groundResFor('coarse');
      const pending = this.groundUpgrades.get(entry.key);
      if (Math.abs(res - entry.groundRes) < 1e-6) {
        if (pending) this.cancelGroundJob(entry.key);
        continue;
      }
      if (pending) {
        if (Math.abs(pending.res - res) < 1e-6) continue;
        this.cancelGroundJob(entry.key);
      }
      if (this.groundUpgrades.size >= MAX_GROUND_JOBS) continue;
      this.requestGround(entry, res);
    }
  }

  private cancelGroundJob(key: string): void {
    const pending = this.groundUpgrades.get(key);
    if (!pending) return;
    pending.cancelled = true;
    this.pool.cancel(pending.id);
    this.groundUpgrades.delete(key);
  }

  private requestGround(entry: TileEntry, res: number): void {
    const url = this.tileUrls.get(entry.key);
    if (!url) return;
    const job = this.pool.load({
      key: entry.key,
      url,
      facadeDetail: false,
      trees: false,
      groundMode: this.options.groundMode,
      groundRes: res,
      groundOnly: true,
    });
    const record = { id: job.id, res, cancelled: false };
    this.groundUpgrades.set(entry.key, record);
    job.promise
      .then((payload) => {
        if (record.cancelled || this.disposed || !payload) return;
        if (this.tiles.get(entry.key) !== entry) return;
        this.applyGround(entry, payload);
      })
      .catch((error) => {
        this.diagnostics.push(`tile ${entry.key}: ground LOD failed: ${String(error)}`);
      })
      .finally(() => {
        if (this.groundUpgrades.get(entry.key) === record) this.groundUpgrades.delete(entry.key);
      });
  }

  /** Swap in a re-rasterised ground texture (and deck atlas); dispose the old. */
  private applyGround(entry: TileEntry, payload: TileWirePayload): void {
    if (!entry.groundMesh || !payload.ground || payload.ground.data.byteLength === 0) return;
    const texture = createGroundTexture(payload.ground.data, payload.ground.width, payload.ground.height);
    const old = entry.groundMesh.material as THREE.MeshLambertMaterial;
    entry.groundMesh.material = createGroundMaterial(texture);
    old.map?.dispose();
    old.dispose();
    const decks = createDeckMesh(payload);
    if (entry.deckMesh) {
      entry.group.remove(entry.deckMesh);
      entry.deckMesh.geometry.dispose();
      const deckMaterial = entry.deckMesh.material as THREE.MeshLambertMaterial;
      deckMaterial.map?.dispose();
      deckMaterial.dispose();
    }
    if (decks) {
      entry.group.add(decks);
      decks.updateMatrixWorld(true);
    }
    entry.deckMesh = decks;
    entry.groundRes = payload.ground.res;
  }

  /** Resident ground textures per texel size (diagnostics / QA). */
  get groundTiers(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const entry of this.tiles.values()) {
      if (!entry.groundMesh) continue;
      const key = String(entry.groundRes);
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }

  private updateLoadingProgress(): void {
    if (this.readyNotified) {
      if (this.loadingNotified) {
        this.loadingNotified = false;
        this.options.onLoadingChange?.(false, 1);
      }
      return;
    }
    if (!this.initialKeys) return;
    let loaded = 0;
    for (const key of this.initialKeys) {
      if (this.tiles.has(key)) loaded += 1;
    }
    const total = Math.max(this.initialKeys.size, 1);
    const progress = Math.min(1, loaded / total);
    this.loadingProgress = progress;
    if (progress !== 1 || this.payloadQueue.length > 0) {
      this.options.onLoadingChange?.(true, progress);
      this.loadingNotified = true;
    }
    const allLoaded = loaded >= this.initialKeys.size || loaded >= this.initialTarget;
    if (allLoaded && this.payloadQueue.length === 0) {
      this.options.onLoadingChange?.(false, 1);
      this.loadingNotified = true;
      this.notifyReady('initial tiles loaded');
    }
  }

  private notifyReady(reason: string): void {
    if (this.readyNotified) return;
    this.readyNotified = true;
    this.readyAt = performance.now();
    if (this.readyWatchdog) {
      clearTimeout(this.readyWatchdog);
      this.readyWatchdog = null;
    }
    this.options.onLoadingChange?.(false, 1);
    this.options.onReady?.();
    void reason;
  }

  // -------------------------------------------------------------------------
  // queries used by picking / highlight / stats / debug
  // -------------------------------------------------------------------------

  get loadedTileCount(): number {
    return this.tiles.size;
  }

  /** Tile grid size in metres, owned by the manifest (512 central / 1024 city). */
  get tileSizeM(): number {
    return this.tileSize;
  }

  get residentBudget(): number {
    return this.maxLoadedTiles;
  }

  get desiredTileCount(): number {
    return this.desired.length;
  }

  get visibleBudget(): number {
    return this.desiredBudget;
  }

  get hardBudget(): number {
    return this.maxLoadedTiles;
  }

  get topUpStoppedByMemory(): boolean {
    return this.topUpStopped;
  }

  get tileLayoutUsed(): 'flat' | 'nested' | 'auto' {
    return this.tileLayout;
  }

  get manifestUrlUsed(): string {
    return this.manifestUrl;
  }

  get dataBaseUrlUsed(): string {
    return this.dataBaseUrl;
  }

  get usesGroundPlate(): boolean {
    return this.keepBasePlate;
  }

  get visibleTileCount(): number {
    let count = 0;
    for (const key of this.visibleKeys) if (this.tiles.has(key)) count += 1;
    return count;
  }

  get loadedBuildingCount(): number {
    return this.buildingCount;
  }

  get geometryMB(): number {
    return this.geometryBytes / (1024 * 1024);
  }

  get isReady(): boolean {
    return this.readyNotified;
  }

  get isLoading(): boolean {
    if (this.readyNotified) return false;
    return this.loadingNotified;
  }

  get progress(): number {
    return this.loadingProgress;
  }

  getDiagnostics(): string[] {
    return [...this.diagnostics, ...this.failedKeys].slice(0, 32);
  }

  get fetchFailures(): number {
    return this.tileFailureCount;
  }

  *loadedTiles(): IterableIterator<TileEntry> {
    yield* this.tiles.values();
  }

  getTile(key: string): TileEntry | undefined {
    return this.tiles.get(key);
  }

  /** Find the loaded tile that owns a building id. */
  findBuilding(id: FeatureId): { entry: TileEntry; feature: BuildingFeature } | null {
    for (const entry of this.tiles.values()) {
      const feature = entry.buildings.get(id);
      if (feature) return { entry, feature };
    }
    return null;
  }
}

/** Textured bridge-deck mesh of a payload (payload 0.4.2), or null. */
function createDeckMesh(payload: TileWirePayload): THREE.Mesh | null {
  if (!payload.decks || payload.decks.mesh.triangleCount <= 0) return null;
  const texture = createGroundTexture(
    payload.decks.texture.data,
    payload.decks.texture.width,
    payload.decks.texture.height,
  );
  const material = createGroundMaterial(texture);
  material.name = 'IsometricMinskBridgeDeck';
  const mesh = new THREE.Mesh(unpackGeometry(payload.decks.mesh), material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.name = `decks-${payload.key}`;
  return mesh;
}
