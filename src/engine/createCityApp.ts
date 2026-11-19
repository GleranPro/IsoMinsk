/**
 * City app bootstrap — the imperative Three.js engine behind the React shell.
 *
 * Builds and owns: the WebGL2 renderer, the isometric orthographic camera +
 * custom controls, the lighting rig (real Minsk solar position + palette
 * presets), the streamed tile city, building picking/highlighting and the
 * pixel-art post-processing pipeline. React only calls the CityAppHandle
 * methods declared in src/shared/appApi.ts.
 *
 * Debug/QA hooks:
 *   window.__CITY_APP__   = { ready, app, stats, errors, diagnostics }
 *   window.__CITY_STATS__ = EngineStats (updated ~2×/second)
 * URL parameters (development / screenshots only):
 *   ?demo=1     synthetic demo city (works without public/data)
 *   ?nolimit=1  load every manifest tile regardless of the visible frustum
 *   ?pixel=0    start with the pixel-art effect disabled
 *   ?time=23    initial time of day
 *   ?zoom=800   initial ortho height
 *   ?az=0.785   initial azimuth in radians
 *   ?detail=0   start with facade detail disabled
 */

import * as THREE from 'three';
import type {
  BuildingSelection,
  CameraSettings,
  MuseumExhibitSelection,
  CityAppHandle,
  CityAppOptions,
  EngineStats,
  MobilityVehicleSelection,
  PixelArtSettings,
} from '../shared/appApi';
import type { FeatureId, TileManifest } from '../shared/types';
import type {
  MobilityDebugDump,
  MobilitySettings,
  MobilityStatus,
  MobilityTripSnapshot,
} from '../shared/mobility';
import {
  ISO_CAMERA,
  resolveDataBaseUrl,
  resolveDatasetName,
  resolveManifestUrl,
} from '../shared/config';
import { publicAssetUrl } from '../shared/assets';
import { MUSEUM, WAR_MUSEUM, isLi2Focus, isMuseumFocus } from '../shared/museum';
import { MuseumLayer } from './museum/museumLayer';
import { LandmarkLayer } from './landmarks/landmarkLayer';
import { landmarkFocusSlug } from '../shared/landmarks';
import { MobilityController } from './mobility/controller';
import { IsometricCameraRig } from './camera/isometricCamera';
import { CameraControls } from './camera/controls';
import { createRendererHost, type RendererHost } from './renderer/createRenderer';
import { LightingRig } from './renderer/lighting';
import {
  createFacadeMaterialSafe,
  disposeFacadeMaterialSafe,
  updateFacadeMaterialSafe,
} from './renderer/facadeBridge';
import { createEnvironmentMaterialSet, setEnvironmentWireframe } from './materials/environmentMaterial';
import { TileStreamer } from './tiles/tileStreamer';
import { BuildingPicker } from './picking/buildingPicker';
import { BuildingHighlighter } from './picking/highlightOverlay';
import { PixelArtPipeline, type PixelArtEnvironment } from './postprocess/pixelArtPipeline';
import { hexToRgb, mixHex } from './postprocess/palette';
import { resolveTreeStyle } from '../city/environment/treeInstances';
import type { CanopyAppearance } from './tiles/instancedTrees';

const EXPOSURE = 1.02;
const STATS_INTERVAL_MS = 500;
const DEFAULT_PIXEL_ART: PixelArtSettings = {
  enabled: true,
  resolution: 360,
  outline: 0.55,
  colorLevels: 20,
  dither: 0.35,
};
const FOG_NEAR_FACTOR = 0.55;
const FOG_FAR_FACTOR = 2.1;
/** Reference camera distance the palette fog presets were authored for. */
const FOG_REFERENCE_DISTANCE = 3000;

/** Mobility switches before the layer has any data: layer off, nothing simulated. */
const DEFAULT_MOBILITY_SETTINGS: MobilitySettings = {
  vehiclesVisible: true,
  signalsVisible: true,
  debug: false,
  paused: false,
};

/**
 * Status before the mobility payload is attached. It is deliberately `idle`
 * with an explanatory note: an empty map must never look like "transport is
 * running but you cannot see it".
 */
const IDLE_MOBILITY_STATUS: MobilityStatus = {
  state: 'idle',
  scheduleStatus: 'absent',
  serviceDate: '',
  serviceSeconds: 0,
  fixedDate: null,
  release: '',
  notes: ['mobility layer not loaded'],
  activeVariants: 0,
  scheduledTrips: 0,
  activeTrips: 0,
  drawnTrips: 0,
  blockedTrips: 0,
  loadedChunks: 0,
  loadedBytes: 0,
  signalNodes: 0,
  signalNodesDrawn: 0,
  simulationMs: 0,
  templateBytes: 0,
  instanceBytes: 0,
};

/**
 * The mobility runtime attached to the engine (public transport, signals and
 * their shared clock). Declared as a narrow interface here so the renderer core
 * never depends on the simulation implementation; `MobilityController` in
 * `src/engine/mobility/controller.ts` provides it.
 */
interface MobilityRuntime {
  setSettings(settings: Partial<MobilitySettings>): void;
  getSettings(): MobilitySettings;
  getStatus(): MobilityStatus;
  getDump(): MobilityDebugDump | null;
  setServiceDate(date: string | null, secondsOfDay?: number): void;
  /** Highlight the vehicle card's trip on the map (null clears it). */
  setSelectedTrip(tripId: string | null): void;
  /** Route/direction/next-stop data for the vehicle card. */
  describeTrip(tripId: string): {
    tripId: string;
    ref: string;
    mode: 'bus' | 'trolleybus' | 'tram';
    headSign: string;
    nextStopName: string;
    delayS: number;
    speed: number;
    phase: string;
  } | null;
}

interface DebugGlobals {
  ready: boolean;
  app: CityAppHandle;
  stats: EngineStats;
  /** Active dataset: always 'city' (the only public payload). */
  dataset: string;
  errors: string[];
  diagnostics: string[];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clampPixelArt(settings: Partial<PixelArtSettings>, base: PixelArtSettings): PixelArtSettings {
  const next: PixelArtSettings = { ...base };
  if (typeof settings.enabled === 'boolean') next.enabled = settings.enabled;
  if (typeof settings.resolution === 'number' && Number.isFinite(settings.resolution)) {
    next.resolution = Math.round(clamp(settings.resolution, 120, 720));
  }
  if (typeof settings.outline === 'number' && Number.isFinite(settings.outline)) {
    next.outline = clamp(settings.outline, 0, 1);
  }
  if (typeof settings.colorLevels === 'number' && Number.isFinite(settings.colorLevels)) {
    next.colorLevels = Math.round(clamp(settings.colorLevels, 0, 32));
  }
  if (typeof settings.dither === 'number' && Number.isFinite(settings.dither)) {
    next.dither = clamp(settings.dither, 0, 1);
  }
  return next;
}

function rgbUnit(hex: string): [number, number, number] {
  const { r, g, b } = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

function createZeroStats(): EngineStats {
  return {
    fps: 0,
    frameMs: 0,
    drawCalls: 0,
    triangles: 0,
    visibleTiles: 0,
    loadedTiles: 0,
    buildings: 0,
    renderWidth: 0,
    renderHeight: 0,
    geometryMB: 0,
  };
}

interface PixelSummary {
  samples: number;
  minLuminance: number;
  maxLuminance: number;
  meanLuminance: number;
  uniqueColors: number;
  center: [number, number, number, number] | null;
}

/** Summarise a pixel buffer in-page (never ship raw megabytes to the QA shell). */
function summarisePixels(
  data: Uint8Array | null,
  width: number,
  height: number,
): PixelSummary | null {
  if (!data) return null;
  const colors = new Set<number>();
  let min = 255;
  let max = 0;
  let sum = 0;
  let samples = 0;
  for (let i = 0; i + 3 < data.length; i += 4 * 11) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luminance < min) min = luminance;
    if (luminance > max) max = luminance;
    sum += luminance;
    colors.add((r << 16) | (g << 8) | b);
    samples += 1;
  }
  const centerIndex = (((height >> 1) * width + (width >> 1)) | 0) * 4;
  return {
    samples,
    minLuminance: Math.round(min * 10) / 10,
    maxLuminance: Math.round(max * 10) / 10,
    meanLuminance: samples > 0 ? Math.round((sum / samples) * 10) / 10 : 0,
    uniqueColors: colors.size,
    center:
      data.length > centerIndex + 3
        ? [data[centerIndex], data[centerIndex + 1], data[centerIndex + 2], data[centerIndex + 3]]
        : null,
  };
}

/** Handle returned when WebGL2 is unavailable: keeps React alive, reports once. */
function createUnavailableHandle(container: HTMLElement, message: string): CityAppHandle {
  const notice = document.createElement('div');
  notice.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:#e7edf2;font:14px/1.6 system-ui,sans-serif;background:#141922;';
  notice.textContent = message;
  container.appendChild(notice);
  const noop = () => undefined;
  return {
    start: noop,
    stop: noop,
    dispose() {
      notice.remove();
    },
    resetCamera: noop,
    getCameraSettings: () => ({ orthoHeight: 0, azimuth: 0, elevation: 0 }),
    setCameraSettings: noop,
    focusOnLocal: noop,
    focusMuseum: noop,
    getExhibitPreview: () => null,
    clearExhibit: noop,
    setPixelArt: noop,
    getPixelArt: () => ({ ...DEFAULT_PIXEL_ART }),
    setTimeOfDay: noop,
    getTimeOfDay: () => 13,
    setFacadeDetail: noop,
    setDebugWireframe: noop,
    setPixelEffectEnabled: noop,
    isPixelEffectEnabled: () => false,
    loadAreaAround: noop,
    getStats: createZeroStats,
    clearSelection: noop,
    highlightBuilding: noop,
    setMobilitySettings: noop,
    getMobilitySettings: () => ({ ...DEFAULT_MOBILITY_SETTINGS }),
    getMobilityStatus: () => ({ ...IDLE_MOBILITY_STATUS }),
    getMobilityDump: () => null,
    setMobilityServiceDate: noop,
    clearMobilitySelection: noop,
  };
}

export function createCityApp(options: CityAppOptions): CityAppHandle {
  const container = options.container;
  console.info('[city] booting renderer');

  // --- feature flags from the URL (QA / screenshots only) -------------------
  const params =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const treeReview = params.get('treeReview') === '1';
  const demoMode = params.get('demo') === '1' || treeReview;
  const treeStyle = resolveTreeStyle(params.get('treeStyle'));
  const noLimit = params.get('nolimit') === '1';
  const shadowParam = Number.parseInt(params.get('shadow') ?? '', 10);
  const resolutionParam = Number.parseInt(params.get('res') ?? '', 10);
  // QA-only resident budget override (?budget=400) for city-scale captures.
  const budgetParam = Number.parseInt(params.get('budget') ?? '', 10);
  const budgetOverride =
    Number.isFinite(budgetParam) && budgetParam >= 4 ? Math.min(budgetParam, 800) : null;

  // --- dataset selection (single source of truth: src/shared/config.ts) ----
  // The public application has exactly one dataset: the complete city. Legacy
  // `?dataset=` links resolve to it, and every endpoint is project-relative so
  // the app also works below a deployment prefix such as /VoxelMinsk/.
  const search = typeof window !== 'undefined' ? window.location.search : '';
  const dataset = resolveDatasetName(search);
  const dataBaseUrl = resolveDataBaseUrl(search);
  const manifestUrl = resolveManifestUrl(search);
  /**
   * Complete-city runtime budgets. The fitted overview sees ~400 tiles: we
   * deterministically keep the nearest 400 resident (the rest show the ground
   * plate) and become ready after the nearest 48 so the first render is quick;
   * zooming into a district shrinks the visible set below the budget and
   * restores full detail. The initial/hard + idle top-up split is kept for
   * future, denser city payloads: the visible budget grows after the camera
   * idles (memory-guarded), while the hard cap also bounds LRU eviction.
   *
   * `?nolimit=1` (with the optional `?budget=…` override) is a hidden QA
   * escape hatch only; the public deployment must not rely on it to pretend
   * the complete city is resident.
   */
  const datasetConfig = noLimit
    ? {
        // ?nolimit=1 keeps loading every manifest tile regardless of the budget
        // (used by QA/screenshots); the LRU still evicts beyond this cap.
        maxLoadedTiles: budgetOverride ?? 800,
        initialBudget: budgetOverride ?? 800,
        initialTileTarget: 48,
        keepBasePlate: true,
        workerCount: 3,
        // The accepted city payload stores tiles directly under the data base;
        // manifest entries only carry a legacy `tiles/` prefix to strip.
        tileLayout: 'flat' as const,
        idleTopUpAfterMs: 0,
        topUpStepTiles: 0,
        maxTopUpGeometryMB: 0,
      }
    : {
        maxLoadedTiles: budgetOverride ?? 400,
        initialBudget: budgetOverride ?? 400,
        initialTileTarget: 48,
        keepBasePlate: true,
        workerCount: 3,
        tileLayout: 'flat' as const,
        idleTopUpAfterMs: 2000,
        topUpStepTiles: 48,
        maxTopUpGeometryMB: 700,
      };

  const errors: string[] = [];
  const diagnostics: string[] = [];
  let disposed = false;
  let ready = false;
  let readyNotified = false;
  /**
   * Mobility runtime (transport + signals) and its UI switches. Kept in one
   * mutable record: the integration assigns `runtime` once its payload has
   * loaded, and the handle below degrades to "idle" while it is absent.
   */
  const mobilityState: { runtime: MobilityRuntime | null; settings: MobilitySettings } = {
    runtime: null,
    settings: { ...DEFAULT_MOBILITY_SETTINGS },
  };

  const recordError = (message: string): void => {
    if (disposed) return;
    errors.push(message);
    if (errors.length > 16) errors.shift();
    diagnostics.push(message);
    try {
      options.onError?.(message);
    } catch {
      /* the shell must never crash the engine */
    }
  };
  const recordDiagnostic = (message: string): void => {
    diagnostics.push(message);
    if (diagnostics.length > 64) diagnostics.shift();
  };

  // --- renderer ------------------------------------------------------------
  let host: RendererHost | null = null;
  try {
    host = createRendererHost(container, {
      exposure: EXPOSURE,
      onError: recordError,
      onContextLost: () => {
        recordError('WebGL context lost — the browser will try to restore it.');
      },
      onContextRestored: () => {
        recordDiagnostic('WebGL context restored');
        renderer.shadowMap.needsUpdate = true;
      },
    });
  } catch (error) {
    host = null;
    recordError(`Renderer initialisation failed: ${String(error)}`);
  }
  if (!host) {
    return createUnavailableHandle(
      container,
      'WebGL2 is required to display the isometric city but is not available in this browser.',
    );
  }
  const renderer = host.renderer;
  const scene = new THREE.Scene();
  const background = new THREE.Color('#e6ecef');
  scene.background = background;
  const fog = new THREE.Fog(new THREE.Color('#e6ecef'), 1_000_000, 2_000_000);
  scene.fog = fog;

  // --- art-direction materials --------------------------------------------
  const facadeDetail = { enabled: params.get('detail') !== '0' };
  const facadeNear = createFacadeMaterialSafe({ detail: true, night: 0, quantise: false });
  const facadeFar = createFacadeMaterialSafe({ detail: true, night: 0, quantise: false });
  const environment = createEnvironmentMaterialSet();

  // --- lights --------------------------------------------------------------
  const defaultShadowSize = renderer.capabilities.maxTextureSize >= 4096 ? 2048 : 1024;
  const shadowSize =
    Number.isFinite(shadowParam) && shadowParam >= 256
      ? Math.min(shadowParam, renderer.capabilities.maxTextureSize)
      : defaultShadowSize;
  const lighting = new LightingRig(scene, shadowSize);
  // Stylised summer-solstice sun by default; `?realsun=1` restores today's date.
  if (params.get('realsun') === '1') lighting.setUseRealDateSun(true);
  let look = lighting.state.look;
  let timeHours = 13;

  // --- camera --------------------------------------------------------------
  const rig = new IsometricCameraRig({
    aspect: host.width / Math.max(1, host.height),
    widthCss: host.width,
    heightCss: host.height,
  });

  /**
   * Default isometric framing: the whole complete-city extent, centred on its
   * centre (local metres). Recomputed from `manifest.bounds` when the manifest
   * arrives and when the viewport aspect changes.
   */
  const defaultView = {
    orthoHeight: ISO_CAMERA.orthoHeight as number,
    targetLocalX: 0,
    targetLocalY: 0,
  };
  let defaultFitBounds: [number, number, number, number] | null = null;

  // --- pixel-art pipeline --------------------------------------------------
  const pixelArt: PixelArtSettings = { ...DEFAULT_PIXEL_ART };
  if (params.get('pixel') === '0') pixelArt.enabled = false;
  if (params.get('pixel') === '1') pixelArt.enabled = true;
  if (Number.isFinite(resolutionParam) && resolutionParam > 0) {
    pixelArt.resolution = Math.round(clamp(resolutionParam, 120, 720));
  }
  const post = new PixelArtPipeline(renderer, pixelArt);
  post.setSize(host.width, host.height, pixelArt);
  post.setEffectEnabled(pixelArt.enabled);

  const postEnvironment: PixelArtEnvironment = {
    fogColor: [0.9, 0.92, 0.94],
    skyColor: [0.9, 0.92, 0.94],
    outlineColor: [0.07, 0.09, 0.11],
    // Atmospheric fog is done by the scene materials in both render paths;
    // the post pass must not add a second fog layer.
    fogNear: 1_000_000_000,
    fogFar: 2_000_000_000,
    pixelWorld: 1,
    edgeLow: 1,
    edgeHigh: 4,
    exposure: EXPOSURE,
  };

  // --- city content --------------------------------------------------------
  const cityRoot = new THREE.Group();
  cityRoot.name = 'city';
  scene.add(cityRoot);

  let maxCasterHeight = 160;
  let shadowDirty = true;
  let highlightId: FeatureId | null = null;
  /**
   * Extra frames during which the shadow map is re-rendered unconditionally.
   * Tiles finish loading asynchronously, so a single `needsUpdate` can be
   * consumed by a render that happened before the last tile became resident;
   * keeping the flag alive for a few frames guarantees the final shadow map
   * includes every caster.
   */
  let shadowRefreshFrames = 12;

  const highlighter = new BuildingHighlighter(cityRoot);
  let picker: BuildingPicker | null = null;
  let controls: CameraControls | null = null;

  // --- Lipki aviation museum (static exhibit payload, loaded once) ---------
  const museum = new MuseumLayer({
    baseUrl: MUSEUM.dataUrl,
    onReady: () => {
      renderer.shadowMap.needsUpdate = true;
      shadowRefreshFrames = Math.max(shadowRefreshFrames, 3);
    },
    onError: recordDiagnostic,
  });
  scene.add(museum.root);
  // The complete city always covers Lipki, so the static exhibit payload can be
  // loaded unconditionally. Failure is non-fatal: the map renders without them.
  void museum.load();

  // --- War Museum Li-2 (one static exhibit, same binary format) ------------
  const warMuseum = new MuseumLayer({
    baseUrl: WAR_MUSEUM.dataUrl,
    onReady: () => {
      renderer.shadowMap.needsUpdate = true;
      shadowRefreshFrames = Math.max(shadowRefreshFrames, 3);
    },
    onError: recordDiagnostic,
  });
  warMuseum.root.name = 'war-museum';
  scene.add(warMuseum.root);
  void warMuseum.load();

  // --- Low-poly landmark models (baked payload, one mesh per landmark) ------
  // The tile builder skips the OSM buildings these models replace
  // (LANDMARK_HIDDEN_BUILDING_IDS), so a failed load leaves a hole: keep the
  // payload next to the tiles in every deployment.
  const landmarkModels = new LandmarkLayer({
    onReady: () => {
      renderer.shadowMap.needsUpdate = true;
      shadowRefreshFrames = Math.max(shadowRefreshFrames, 3);
    },
    onError: recordDiagnostic,
  });
  scene.add(landmarkModels.root);
  void landmarkModels.load();

  // --- mobility: public transport + traffic signals ------------------------
  // Independent of the tile pipeline: a missing/incompatible payload leaves the
  // map fully usable (the status reports why nothing moves).
  // По умолчанию — полный городской payload `public/data/mobility-city`
  // (195 маршрутов); он входит в публикацию Pages. `?mobility=corridors`
  // оставляет лёгкий набор из двух проверенных коридоров
  // (`public/data/mobility/`), `?mobility=city` сохранён для совместимости.
  const mobilityParam = params.get('mobility');
  const useCityMobility = mobilityParam !== 'corridors';
  const mobility = new MobilityController({
    baseUrl: useCityMobility ? publicAssetUrl('data/mobility-city') : undefined,
    mobile: typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(pointer: coarse)').matches
      : false,
    paused: false,
  });
  scene.add(mobility.root);
  mobilityState.runtime = mobility;
  void mobility.start();

  const streamer = new TileStreamer({
    scene,
    root: cityRoot,
    environmentMaterial: environment.environment,
    treeMaterial: environment.trees,
    treeTrunkMaterial: environment.treeTrunks,
    treeCanopyMaterial: environment.treeCanopies,
    attractionMaterial: environment.attractions,
    treeStyle,
    treeReview,
    facadeMaterialNear: facadeNear,
    facadeMaterialFar: facadeFar,
    demo: demoMode,
    nolimit: noLimit,
    manifestUrl,
    dataBaseUrl,
    maxLoadedTiles: datasetConfig.maxLoadedTiles,
    initialTileTarget: datasetConfig.initialTileTarget,
    keepBasePlate: datasetConfig.keepBasePlate,
    workerCount: datasetConfig.workerCount,
    initialBudget: datasetConfig.initialBudget,
    idleTopUpAfterMs: datasetConfig.idleTopUpAfterMs,
    topUpStepTiles: datasetConfig.topUpStepTiles,
    maxTopUpGeometryMB: datasetConfig.maxTopUpGeometryMB,
    tileLayout: datasetConfig.tileLayout,
    // Raster ground compositor (payload 0.4.0) by default; `?ground=vector`
    // keeps the legacy polygon partition for A/B comparison.
    groundMode: params.get('ground') === 'vector' ? 'vector' : 'raster',
    groundRes: Number(params.get('groundRes')) > 0 ? Number(params.get('groundRes')) : undefined,
    onError: recordError,
    onWarning: recordDiagnostic,
    onLoadingChange: (loading, progress) => {
      if (disposed) return;
      try {
        options.onLoadingChange?.(loading, progress);
      } catch {
        /* ignore shell errors */
      }
    },
    onTilesChanged: () => {
      renderer.shadowMap.needsUpdate = true;
      shadowDirty = true;
      shadowRefreshFrames = Math.max(shadowRefreshFrames, 3);
      if (highlightId) applyHighlight(highlightId);
    },
    onManifestLoaded: (manifest: TileManifest) => {
      applyManifestBounds(manifest);
    },
    onReady: () => {
      markReady();
    },
  });

  picker = new BuildingPicker(streamer, rig.camera);
  const museumRaycaster = new THREE.Raycaster();
  museumRaycaster.near = 0;
  museumRaycaster.far = Number.POSITIVE_INFINITY;

  // --- state shared with the frame loop ------------------------------------
  const stats: EngineStats = createZeroStats();
  const frames = { count: 0, windowStart: performance.now(), lastFrame: performance.now(), frameMsAvg: 0 };
  let selected: BuildingSelection | null = null;
  let lastPixelSize = 0;
  let running = false;
  let rafId = 0;
  let resizePending = true;
  let frameErrors = 0;
  const debugOverrides = {
    exposure: null as number | null,
    paletteMix: null as number | null,
    facadePaletteMix: null as number | null,
    outline: null as number | null,
    toneMode: null as number | null,
  };

  const handle: CityAppHandle = {
    start() {
      if (running || disposed) return;
      running = true;
      frames.lastFrame = performance.now();
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    },
    dispose,
    resetCamera() {
      rig.reset(defaultView.orthoHeight, defaultView.targetLocalX, defaultView.targetLocalY);
      markCameraDirty();
    },
    getCameraSettings: () => rig.getSettings(),
    setCameraSettings(settings: Partial<CameraSettings>) {
      rig.setSettings(settings);
      markCameraDirty();
    },
    focusOnLocal(localX: number, localY: number) {
      if (!Number.isFinite(localX) || !Number.isFinite(localY)) return;
      rig.focusOnLocal(localX, localY, true);
      streamer.ensureArea(localX, localY, 1);
      markCameraDirty();
    },
    focusMuseum() {
      focusMuseum();
    },
    setPixelArt(settings: Partial<PixelArtSettings>) {
      Object.assign(pixelArt, clampPixelArt(settings, pixelArt));
      post.setSettings(pixelArt);
      post.setSize(host.width, host.height, pixelArt);
      post.setEffectEnabled(pixelArt.enabled);
      applyPixelArtFlags();
    },
    getPixelArt: () => ({ ...pixelArt }),
    setTimeOfDay(hours: number) {
      applyTimeOfDay(hours);
    },
    getTimeOfDay: () => timeHours,
    setFacadeDetail(enabled: boolean) {
      facadeDetail.enabled = Boolean(enabled);
      applyFacadeDetailFlags();
      shadowRefreshFrames = Math.max(shadowRefreshFrames, 3);
    },
    setDebugWireframe(enabled: boolean) {
      const on = Boolean(enabled);
      for (const material of [facadeNear, facadeFar]) {
        const lambert = material as THREE.MeshLambertMaterial;
        if ('wireframe' in lambert) lambert.wireframe = on;
        material.needsUpdate = true;
      }
      setEnvironmentWireframe(environment, on);
    },
    setPixelEffectEnabled(enabled: boolean) {
      pixelArt.enabled = Boolean(enabled);
      post.setSize(host.width, host.height, pixelArt);
      post.setEffectEnabled(pixelArt.enabled);
      applyPixelArtFlags();
    },
    isPixelEffectEnabled: () => pixelArt.enabled,
    loadAreaAround(localX: number, localY: number) {
      if (!Number.isFinite(localX) || !Number.isFinite(localY)) return;
      streamer.ensureArea(localX, localY, 2);
      markCameraDirty();
    },
    getStats: () => ({ ...stats }),
    clearSelection() {
      selected = null;
      highlightId = null;
      highlighter.setHighlight(null);
      try {
        options.onSelection?.(null);
      } catch {
        /* ignore */
      }
    },
    getExhibitPreview(index: number) {
      return museum.getExhibitPreview(index);
    },
    clearExhibit() {
      try {
        options.onExhibitSelect?.(null);
      } catch {
        /* ignore shell errors */
      }
    },
    highlightBuilding(id: FeatureId | null) {
      highlightId = id;
      applyHighlight(id);
    },
    setMobilitySettings(settings: Partial<MobilitySettings>) {
      mobilityState.settings = { ...mobilityState.settings, ...settings };
      mobilityState.runtime?.setSettings(settings);
    },
    getMobilitySettings: () =>
      mobilityState.runtime ? mobilityState.runtime.getSettings() : { ...mobilityState.settings },
    getMobilityStatus: () => mobilityState.runtime?.getStatus() ?? { ...IDLE_MOBILITY_STATUS },
    getMobilityDump: () => mobilityState.runtime?.getDump() ?? null,
    setMobilityServiceDate(date: string | null, secondsOfDay?: number) {
      mobilityState.runtime?.setServiceDate(date, secondsOfDay);
    },
    clearMobilitySelection() {
      mobilityState.runtime?.setSelectedTrip(null);
      try {
        options.onMobilitySelect?.(null);
      } catch {
        /* ignore shell errors */
      }
    },
  };

  // --- debug globals -------------------------------------------------------
  const debugGlobals: DebugGlobals = {
    ready: false,
    app: handle,
    stats,
    dataset,
    errors,
    diagnostics,
  };
  if (typeof window !== 'undefined') {
    (window as unknown as { __CITY_APP__?: DebugGlobals }).__CITY_APP__ = debugGlobals;
    (window as unknown as { __CITY_STATS__?: EngineStats }).__CITY_STATS__ = stats;
  }

  // --- debug surface (X-ray for the QA harness) ----------------------------
  const debugApi = {
    trees: () => ({ style: treeStyle, ...streamer.getTreeDiagnostics() }),
    setCanopyAppearance: (change: Partial<CanopyAppearance>) => streamer.setCanopyAppearance(change),
    camera: () => {
      const camera = rig.camera;
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      return {
        position: camera.position.toArray(),
        direction: direction.toArray(),
        lookTarget: rig.getTargetWorld().toArray(),
        left: camera.left,
        right: camera.right,
        top: camera.top,
        bottom: camera.bottom,
        near: camera.near,
        far: camera.far,
        projectionMatrix: camera.projectionMatrix.elements.slice(),
        matrixWorld: camera.matrixWorld.elements.slice(),
        cameraDistance: rig.getCameraDistanceValue(),
        settings: rig.getSettings(),
      };
    },
    /**
     * Project a local-metre position to CSS pixels (QA/click harness). Uses the
     * camera's own matrices, so it can never disagree with the rendered frame.
     */
    projectLocal: (localX: number, localY: number, heightM = 0) => {
      const rect = host!.canvas.getBoundingClientRect();
      const projected = new THREE.Vector3(localX, heightM, -localY).project(rig.camera);
      return {
        x: rect.left + ((projected.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - projected.y) / 2) * rect.height,
        ndcX: projected.x,
        ndcY: projected.y,
        depth: projected.z,
        visible: projected.x >= -1 && projected.x <= 1 && projected.y >= -1 && projected.y <= 1,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      };
    },
    gl: () => {
      const gl = renderer.getContext();
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        version: String(gl.getParameter(gl.VERSION)),
        renderer: debugInfo
          ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
          : 'unknown',
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        contextLost: gl.isContextLost(),
      };
    },
    target: () => ({
      ...post.getRenderSize(),
      enabled: pixelArt.enabled,
      framebufferStatus: post.checkTargetFramebufferStatus(),
      cssWidth: host!.width,
      cssHeight: host!.height,
    }),
    scene: () => {
      const camera = rig.camera;
      camera.updateMatrixWorld();
      const frustum = new THREE.Frustum();
      const matrix = new THREE.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      frustum.setFromProjectionMatrix(matrix);
      const tiles = [...streamer.loadedTiles()].map((tile) => {
        const sphere = tile.buildingMesh?.geometry.boundingSphere ?? null;
        return {
          key: tile.key,
          meshes: tile.group.children.length,
          triangles: tile.triangles,
          center: sphere ? sphere.center.toArray() : null,
          radius: sphere ? Math.round(sphere.radius * 10) / 10 : 0,
          visibleInMainCamera: sphere ? frustum.intersectsSphere(sphere) : false,
        };
      });
      return {
        sceneChildren: scene.children.length,
        cityChildren: cityRoot.children.length,
        visibleTilesLoaded: streamer.visibleTileCount,
        loadedTiles: streamer.loadedTileCount,
        buildings: streamer.loadedBuildingCount,
        /** Ground LOD: resident ground textures per texel size (metres). */
        groundTiers: streamer.groundTiers,
        tiles: tiles.slice(0, 32),
      };
    },
    rendererInfo: () => ({
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      points: renderer.info.render.points,
      lines: renderer.info.render.lines,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
    }),
    /** Render one frame into the low-res scene target and summarise it. */
    sceneTargetPixels: () => {
      post.renderSceneToTarget(scene, rig.camera);
      const size = post.getRenderSize();
      return {
        size,
        summary: summarisePixels(post.readTargetPixels(0, 0, size.width, size.height), size.width, size.height),
      };
    },
    /** Render one frame directly to the canvas and summarise the readback. */
    canvasPixels: () => {
      post.renderDirect(scene, rig.camera);
      const width = host!.width;
      const height = host!.height;
      const readWidth = Math.min(width, 256);
      const readHeight = Math.min(height, 256);
      return {
        size: { width, height },
        readRegion: { width: readWidth, height: readHeight },
        summary: summarisePixels(
          post.readCanvasPixels(
            Math.max(0, (width - readWidth) >> 1),
            Math.max(0, (height - readHeight) >> 1),
            readWidth,
            readHeight,
          ),
          readWidth,
          readHeight,
        ),
      };
    },
    forceFrame: () => {
      resizePending = true;
      tick(1 / 60, performance.now());
      return true;
    },
    pipelineSettings: () => ({ ...pixelArt }),
    diagnostics: () => [...diagnostics],
    // Raw handles for in-page inspection (not serialisable; use inside evaluate).
    three: () => THREE,
    sceneObject: () => scene,
    cameraObject: () => rig.camera,
    rendererObject: () => renderer,
    cityRootObject: () => cityRoot,
    museum: () => ({
      state: museum.state,
      triangles: museum.getTriangles(),
      exhibits: museum.manifest?.exhibits.length ?? 0,
      missing: museum.manifest?.missing.length ?? 0,
      error: museum.error,
      bounds: museum.manifest?.bounds ?? null,
    }),
    museumObject: () => museum,
    warMuseum: () => ({
      state: warMuseum.state,
      triangles: warMuseum.getTriangles(),
      exhibits: warMuseum.manifest?.exhibits.length ?? 0,
      error: warMuseum.error,
      bounds: warMuseum.manifest?.bounds ?? null,
    }),
    warMuseumObject: () => warMuseum,
    landmarkModels: () => ({
      state: landmarkModels.state,
      triangles: landmarkModels.getTriangles(),
      landmarks: landmarkModels.manifest?.landmarks.length ?? 0,
      error: landmarkModels.error,
    }),
    landmarkModelsObject: () => landmarkModels,
    targetObject: () => post.targetHandle,
    lightsObject: () => lighting,
    /** Grid samples (RGB) from the low-res scene target. */
    sampleTargetGrid: (cols = 6, rows = 4) => {
      post.renderSceneToTarget(scene, rig.camera);
      const size = post.getRenderSize();
      const pixels = post.readTargetPixels(0, 0, size.width, size.height);
      if (!pixels) return null;
      const grid: number[][] = [];
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const x = Math.min(size.width - 1, Math.floor(((col + 0.5) / cols) * size.width));
          const y = Math.min(size.height - 1, Math.floor(((row + 0.5) / rows) * size.height));
          const index = (y * size.width + x) * 4;
          grid.push([pixels[index], pixels[index + 1], pixels[index + 2]]);
        }
      }
      return { size, grid };
    },
    setPostUniform: (name: string, value: number | number[]) => {
      post.setUniformValue(name, value);
      return { name, value };
    },
    setDebugView: (mode: number) => {
      post.setDebugView(mode);
      return mode;
    },
    uniformNames: () => post.getUniformNames(),
    uniformValues: () => post.getUniformValues(),
    targetInfo: () => post.getTargetInfo(),
    /** Numeric luminance stats for direct vs post-processed full frames. */
    frameStats: () => {
      const statsOf = (pixels: Uint8Array | null): Record<string, number> | null => {
        if (!pixels) return null;
        let sum = 0;
        let count = 0;
        let min = 255;
        let max = 0;
        let under10 = 0;
        let under20 = 0;
        let under32 = 0;
        let bright = 0;
        const unique = new Set<number>();
        for (let i = 0; i + 2 < pixels.length; i += 4) {
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (luminance < min) min = luminance;
          if (luminance > max) max = luminance;
          if (luminance < 10) under10 += 1;
          if (luminance < 20) under20 += 1;
          if (luminance < 32) under32 += 1;
          if (luminance > 192) bright += 1;
          sum += luminance;
          count += 1;
          if (count % 7 === 1) unique.add((r << 16) | (g << 8) | b);
        }
        return {
          mean: Math.round((sum / Math.max(count, 1)) * 10) / 10,
          min: Math.round(min * 10) / 10,
          max: Math.round(max * 10) / 10,
          count,
          under10: Math.round((under10 / Math.max(count, 1)) * 1000) / 10,
          under20: Math.round((under20 / Math.max(count, 1)) * 1000) / 10,
          under32: Math.round((under32 / Math.max(count, 1)) * 1000) / 10,
          bright,
          uniqueColors: unique.size,
        };
      };
      post.renderDirect(scene, rig.camera);
      const direct = statsOf(post.readCanvasPixels(0, 0, host!.width, host!.height));
      post.render(scene, rig.camera);
      const postStats = statsOf(post.readCanvasPixels(0, 0, host!.width, host!.height));
      const targetSize = post.getRenderSize();
      post.renderSceneToTarget(scene, rig.camera);
      const targetPixels = post.readTargetPixels(0, 0, targetSize.width, targetSize.height);
      const target = statsOf(targetPixels);
      return { direct, post: postStats, target };
    },
    setExposure: (exposure: number) => {
      debugOverrides.exposure = exposure;
      return exposure;
    },
    setOverrides: (partial: Record<string, number | null>) => {
      for (const [key, value] of Object.entries(partial)) {
        if (key in debugOverrides) {
          (debugOverrides as unknown as Record<string, number | null>)[key] = value;
        }
      }
      return { ...debugOverrides };
    },
    /** 0 = neutral tonemapping, 1 = linear/clamp (both render paths). */
    setToneMode: (mode: number) => {
      renderer.toneMapping = mode > 0.5 ? THREE.LinearToneMapping : THREE.NeutralToneMapping;
      post.setToneMode(mode);
      return mode;
    },
    setAmbientScale: (scale: number) => {
      lighting.ambient.intensity = lighting.state.look.ambientIntensity * scale;
      lighting.fill.intensity = lighting.ambient.intensity * 0.3;
      return lighting.ambient.intensity;
    },
    /** Artistic sun elevation override in degrees (null restores real solar). */
    setSunElevation: (degrees: number | null) => {
      lighting.setSunElevationOverride(degrees);
      look = lighting.state.look;
      return lighting.state.elevation;
    },
    renderPostNow: () => {
      post.render(scene, rig.camera);
      return true;
    },
    renderDirectNow: () => {
      post.renderDirect(scene, rig.camera);
      return true;
    },
    /** Set a light intensity multiplier relative to the palette preset. */
    setLightScale: (scale: number) => {
      lighting.sun.intensity = lighting.state.look.sunIntensity * scale;
      return lighting.sun.intensity;
    },
    /** Render a full post-processed frame and sample the canvas output grid. */
    renderPostAndSampleGrid: (cols = 4, rows = 3) => {
      post.render(scene, rig.camera);
      const width = host!.width;
      const height = host!.height;
      const pixels = post.readCanvasPixels(0, 0, width, height);
      if (!pixels) return null;
      const grid: number[][] = [];
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const x = Math.min(width - 1, Math.floor(((col + 0.5) / cols) * width));
          const y = Math.min(height - 1, Math.floor(((row + 0.5) / rows) * height));
          const index = (y * width + x) * 4;
          grid.push([pixels[index], pixels[index + 1], pixels[index + 2]]);
        }
      }
      return { size: { width, height }, grid };
    },
    /** Compare the post-processed frame against the direct render numerically. */
    comparePostVsDirect: (cols = 4, rows = 3) => {
      const targetSize = post.getRenderSize();
      post.renderSceneToTarget(scene, rig.camera);
      const scenePixels = post.readTargetPixels(0, 0, targetSize.width, targetSize.height);
      if (!scenePixels) return { error: 'no target pixels' };
      const sample = (pixels: Uint8Array, width: number, height: number) => {
        const values: number[][] = [];
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            const x = Math.min(width - 1, Math.floor(((col + 0.5) / cols) * width));
            const y = Math.min(height - 1, Math.floor(((row + 0.5) / rows) * height));
            const index = (y * width + x) * 4;
            values.push([pixels[index], pixels[index + 1], pixels[index + 2]]);
          }
        }
        return values;
      };
      const linear = sample(scenePixels, targetSize.width, targetSize.height);
      // Expected post output, reproducing the GLSL path on the CPU.
      const neutral = (value: number): number => {
        const x = Math.min(value, 0.999);
        let offset = 0.04;
        if (x < 0.08) offset = x - 6.25 * x * x;
        const shifted = Math.max(value - offset, 0);
        return Math.min(Math.max(shifted, 0), 1);
      };
      const toSrgb = (value: number): number => {
        const c = Math.min(Math.max(value, 0), 1);
        return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
      };
      const expected = linear.map((rgb) =>
        rgb.map((channel) => Math.round(toSrgb(neutral(channel / 255)) * 255)),
      );
      post.render(scene, rig.camera);
      const canvasPixels = post.readCanvasPixels(0, 0, host!.width, host!.height);
      const actual = canvasPixels
        ? sample(canvasPixels, host!.width, host!.height)
        : null;
      return { targetSize, linear, expected, actual };
    },
    sampleCanvasGrid: (cols = 6, rows = 4) => {
      post.renderDirect(scene, rig.camera);
      const width = host!.width;
      const height = host!.height;
      const pixels = post.readCanvasPixels(0, 0, width, height);
      if (!pixels) return null;
      const grid: number[][] = [];
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const x = Math.min(width - 1, Math.floor(((col + 0.5) / cols) * width));
          const y = Math.min(height - 1, Math.floor(((row + 0.5) / rows) * height));
          const index = (y * width + x) * 4;
          grid.push([pixels[index], pixels[index + 1], pixels[index + 2]]);
        }
      }
      return { size: { width, height }, grid };
    },
    tileDebug: () => {
      const entry = streamer.loadedTiles().next().value as
        | { key: string; buildingMesh: THREE.Mesh | null; environmentMesh: THREE.Mesh | null }
        | undefined;
      if (!entry) return { error: 'no tiles loaded' };
      const describe = (mesh: THREE.Mesh | null) => {
        if (!mesh) return null;
        const geometry = mesh.geometry;
        const position = geometry.getAttribute('position');
        let min = [Infinity, Infinity, Infinity];
        let max = [-Infinity, -Infinity, -Infinity];
        const array = (position as THREE.BufferAttribute | undefined)?.array;
        if (array) {
          for (let i = 0; i + 2 < array.length; i += 3) {
            for (let c = 0; c < 3; c += 1) {
              const value = array[i + c];
              if (!Number.isFinite(value)) continue;
              if (value < min[c]) min[c] = value;
              if (value > max[c]) max[c] = value;
            }
          }
        }
        return {
          materialType: mesh.material instanceof THREE.Material ? mesh.material.type : 'array',
          materialName: mesh.material instanceof THREE.Material ? mesh.material.name : '',
          materialVisible: mesh.material instanceof THREE.Material ? mesh.material.visible : null,
          visible: mesh.visible,
          frustumCulled: mesh.frustumCulled,
          positionCount: position ? position.count : 0,
          indexCount: geometry.getIndex() ? geometry.getIndex()!.count : 0,
          drawRange: { ...geometry.drawRange },
          groups: geometry.groups.length,
          bounds: { min, max },
          matrixWorld: mesh.matrixWorld.elements.slice(),
          boundingSphere: geometry.boundingSphere
            ? {
                center: geometry.boundingSphere.center.toArray(),
                radius: geometry.boundingSphere.radius,
              }
            : null,
          attributes: Object.keys(geometry.attributes),
        };
      };
      return { key: entry.key, building: describe(entry.buildingMesh), environment: describe(entry.environmentMesh) };
    },
    /**
     * QA helper: find loaded buildings whose name/tags contain `query` and
     * return their local-metre footprint centroids (for canonical screenshots).
     */
    buildingSearch: (query: string) => {
      const needle = query.toLowerCase();
      const matches: Array<{ id: string; name: string; archetype: string; localX: number; localY: number }> = [];
      for (const tile of streamer.loadedTiles()) {
        for (const feature of tile.buildings.values()) {
          const name = feature.name ?? feature.tags?.name ?? '';
          const haystack = `${name} ${feature.tags?.building ?? ''} ${feature.tags?.['building:use'] ?? ''}`.toLowerCase();
          if (!haystack.includes(needle)) continue;
          const ring = feature.volumes[0]?.footprint[0];
          if (!ring || ring.length === 0) continue;
          let sx = 0;
          let sy = 0;
          for (const [x, y] of ring) { sx += x; sy += y; }
          matches.push({
            id: feature.id,
            name,
            archetype: feature.archetype,
            localX: sx / ring.length,
            localY: sy / ring.length,
          });
        }
      }
      return matches.slice(0, 60);
    },
    /** QA helper: loaded buildings of one archetype with local positions. */
    archetypeSamples: (archetype: string, limit = 120) => {
      const samples: Array<{ id: string; name: string; localX: number; localY: number; height: number }> = [];
      for (const tile of streamer.loadedTiles()) {
        for (const feature of tile.buildings.values()) {
          if (feature.archetype !== archetype) continue;
          const ring = feature.volumes[0]?.footprint[0];
          if (!ring || ring.length === 0) continue;
          let sx = 0;
          let sy = 0;
          for (const [x, y] of ring) { sx += x; sy += y; }
          samples.push({
            id: feature.id,
            name: feature.name ?? '',
            localX: sx / ring.length,
            localY: sy / ring.length,
            height: feature.height,
          });
          if (samples.length >= limit) return samples;
        }
      }
      return samples;
    },
    /** QA helper: first loaded building of an archetype and its local position. */
    archetypeSample: (archetype: string) => {
      for (const tile of streamer.loadedTiles()) {
        for (const feature of tile.buildings.values()) {
          if (feature.archetype !== archetype) continue;
          const ring = feature.volumes[0]?.footprint[0];
          if (!ring || ring.length === 0) continue;
          let sx = 0;
          let sy = 0;
          for (const [x, y] of ring) { sx += x; sy += y; }
          return {
            id: feature.id,
            name: feature.name ?? '',
            archetype: feature.archetype,
            localX: sx / ring.length,
            localY: sy / ring.length,
            height: feature.height,
          };
        }
      }
      return null;
    },
    /** Dataset + streaming/zoom state (city dataset acceptance checks). */
    datasetInfo: () => ({
      dataset,
      dataBaseUrl,
      manifestUrl,
      tileSize: streamer.tileSizeM,
      residentBudget: streamer.residentBudget,
      visibleBudget: streamer.visibleBudget,
      hardBudget: streamer.hardBudget,
      topUpStoppedByMemory: streamer.topUpStoppedByMemory,
      tileLayout: streamer.tileLayoutUsed,
      desiredTiles: streamer.desiredTileCount,
      loadedTiles: streamer.loadedTileCount,
      visibleTiles: streamer.visibleTileCount,
      keepBasePlate: streamer.usesGroundPlate,
      maxOrthoHeight: rig.getMaxOrthoHeight(),
      defaultView: { ...defaultView },
      shadowCasting: lighting.isShadowCasting(),
      fog: { near: fog.near, far: fog.far },
      pixelArt: post.getRenderSize(),
    }),
    materialDebug: () => ({
      background: background.getHexString(THREE.SRGBColorSpace),
      backgroundLinear: background.toArray(),
      fog: { near: fog.near, far: fog.far, color: fog.color.getHexString(THREE.SRGBColorSpace) },
      sun: {
        intensity: lighting.sun.intensity,
        color: lighting.sun.color.getHexString(THREE.SRGBColorSpace),
        position: lighting.sun.position.toArray(),
        elevationDeg: lighting.getSunElevationDeg(),
        stylisedSummerSun: !lighting.getUseRealDateSun(),
        shadowIntensity: lighting.sun.shadow.intensity,
        shadowMapSize: lighting.sun.shadow.mapSize.toArray(),
        shadowCast: lighting.sun.castShadow,
      },
      ambient: {
        intensity: lighting.ambient.intensity,
        color: lighting.ambient.color.getHexString(THREE.SRGBColorSpace),
        groundColor: lighting.ambient.groundColor.getHexString(THREE.SRGBColorSpace),
      },
      exposure: renderer.toneMappingExposure,
      toneMapping: renderer.toneMapping,
      post: {
        fogNear: fog.near,
        fogFar: fog.far,
        edgeLow: postEnvironment.edgeLow,
        edgeHigh: postEnvironment.edgeHigh,
        pixelWorld: postEnvironment.pixelWorld,
        outline: pixelArt.outline,
        vignette: 0.1,
        effectEnabled: pixelArt.enabled,
        target: post.getRenderSize(),
      },
      shadow: {
        extentMetres: lighting.getShadowExtent(),
        texelMetres: lighting.getMaxShadowTexel(),
        intensity: lighting.sun.shadow.intensity,
      },
      energyGains: lighting.getEnergyGains(),
      shadowCasting: lighting.isShadowCasting(),
      defaultView: { ...defaultView },
      zoomLimits: {
        minOrthoHeight: ISO_CAMERA.minOrthoHeight,
        maxOrthoHeight: rig.getMaxOrthoHeight(),
      },
      dataset,
    }),
  };
  if (typeof window !== 'undefined') {
    (window as unknown as { __CITY_DEBUG__?: unknown }).__CITY_DEBUG__ = debugApi;
  }

  // --- helpers -------------------------------------------------------------
  function markCameraDirty(): void {
    shadowDirty = true;
    shadowRefreshFrames = Math.max(shadowRefreshFrames, 3);
    renderer.shadowMap.needsUpdate = true;
    resizePending = false;
    const sceneRenderHeight = post.getRenderSize().height;
    updateFacadePixelSize(sceneRenderHeight);
  }

  function applyManifestBounds(manifest: TileManifest): void {
    const bounds = manifest.bounds;
    if (!Array.isArray(bounds) || bounds.length !== 4) return;
    const [minX, minY, maxX, maxY] = bounds;
    // local metres -> world: X unchanged, Z = -localY.
    rig.setBounds({ minX, maxX, minZ: -maxY, maxZ: -minY });

    // The complete-city payload is the only public map, so the initial view
    // always fits its full manifest bounds. `pilotBounds` is a legacy subset
    // field: fitting it would hide missing outer tiles behind a central view
    // and must never become the default framing.
    defaultFitBounds = [minX, minY, maxX, maxY];
    refreshDefaultView();
    // Initial framing: fit the whole city (the manifest arrives before the user
    // can interact in practice).
    rig.reset(defaultView.orthoHeight, defaultView.targetLocalX, defaultView.targetLocalY);

    if (manifest.counts && typeof manifest.counts.buildings === 'number') {
      recordDiagnostic(
        `manifest: ${manifest.tiles.length} tiles, ${manifest.counts.buildings} buildings; default view ${Math.round(defaultView.orthoHeight)} m`,
      );
    }
    markCameraDirty();
  }

  /** Fit the isometric view so `defaultFitBounds` (local metres) fits on screen. */
  /** Ortho half-height that fits `defaultFitBounds` with a 1% margin. */
  function computeFitOrthoHeight(): number {
    if (!defaultFitBounds) return ISO_CAMERA.orthoHeight;
    const [minX, minY, maxX, maxY] = defaultFitBounds;
    const halfX = Math.abs(maxX - minX) / 2;
    const halfY = Math.abs(maxY - minY) / 2;
    const azimuth = ISO_CAMERA.azimuth;
    const sinAzimuth = Math.abs(Math.sin(azimuth));
    const cosAzimuth = Math.abs(Math.cos(azimuth));
    const aspect = host!.width / Math.max(1, host!.height);
    const sinElevation = Math.sin(ISO_CAMERA.elevation);
    // Screen-x extent of the district = projection on the camera right axis;
    // screen-y extent = ground depth along the up-screen ground axis * sin(elev).
    const halfScreenX = halfX * cosAzimuth + halfY * sinAzimuth;
    const halfGroundDepth = halfX * sinAzimuth + halfY * cosAzimuth;
    const fitHeight = Math.max(
      halfScreenX / Math.max(aspect, 0.2),
      halfGroundDepth * sinElevation,
    );
    return Math.max(fitHeight * 1.01, ISO_CAMERA.orthoHeight);
  }

  function refreshDefaultView(): void {
    if (!defaultFitBounds) return;
    const [minX, minY, maxX, maxY] = defaultFitBounds;
    defaultView.targetLocalX = (minX + maxX) / 2;
    defaultView.targetLocalY = (minY + maxY) / 2;

    // Zoom-out limit follows the fitted complete-city view: never below the
    // shared 2600 m cap, and allow 1.35× the fitted overview for context.
    const fitHeight = computeFitOrthoHeight();
    rig.setMaxOrthoHeight(Math.max(ISO_CAMERA.maxOrthoHeight, fitHeight * 1.35));
    defaultView.orthoHeight = clamp(
      fitHeight,
      ISO_CAMERA.minOrthoHeight,
      rig.getMaxOrthoHeight(),
    );
  }

  function applyHighlight(id: FeatureId | null): void {
    if (!id) {
      highlighter.setHighlight(null);
      return;
    }
    const found = streamer.findBuilding(id);
    if (!found || !found.entry.buildingMesh || !found.entry.triangleOwner) {
      highlighter.setHighlight(null);
      return;
    }
    highlighter.setHighlight({
      id,
      geometry: found.entry.buildingMesh.geometry,
      triangleOwner: found.entry.triangleOwner,
      buildingIds: found.entry.buildingIds,
    });
  }

  function applyTimeOfDay(hours: number): void {
    if (!Number.isFinite(hours)) return;
    timeHours = clamp(hours, 0, 24);
    const state = lighting.setTimeOfDay(timeHours);
    look = state.look;
    background.copy(new THREE.Color(look.skyHex));
    fog.color.copy(new THREE.Color(look.fogHex));
    updateFacadeMaterialSafe(facadeNear, {
      night: look.nightFactor,
      timeHours,
    });
    updateFacadeMaterialSafe(facadeFar, {
      night: look.nightFactor,
      timeHours,
    });
    updateLookColors();
    streamer.setNightFactor(look.nightFactor);
    // Night exposure lift: ACES compresses the low-key night palette, so give
    // the lit windows enough headroom to read without washing out the darkness.
    const nightExposure = EXPOSURE * (1 + look.nightFactor * 0.22);
    postEnvironment.exposure = nightExposure;
    renderer.toneMappingExposure = nightExposure;
    shadowDirty = true;
    shadowRefreshFrames = Math.max(shadowRefreshFrames, 6);
    renderer.shadowMap.needsUpdate = true;
  }

  function updateLookColors(): void {
    const fogUnit = rgbUnit(look.fogHex);
    const skyUnit = rgbUnit(look.skyHex);
    postEnvironment.fogColor = fogUnit;
    postEnvironment.skyColor = skyUnit;
    const ink = mixHex('#1b232c', '#070a0e', clamp(look.nightFactor, 0, 1));
    postEnvironment.outlineColor = rgbUnit(ink);
  }

  function applyPixelArtFlags(): void {
    // Exactly one quantisation stage: the post pass snaps to the canonical
    // palette when the pixel-art effect is enabled; the facade shader keeps its
    // full-detail colour so the two stages never fight. Wireframe/debug views
    // stay clean.
    const paletteMix = 0;
    updateFacadeMaterialSafe(facadeNear, { paletteMix });
    updateFacadeMaterialSafe(facadeFar, { paletteMix });
    const sceneRenderHeight = post.getRenderSize().height;
    updateFacadePixelSize(sceneRenderHeight);
    shadowDirty = true;
  }

  function applyFacadeDetailFlags(): void {
    updateFacadeMaterialSafe(facadeNear, { detailScale: facadeDetail.enabled ? 1 : 0 });
    updateFacadeMaterialSafe(facadeFar, { detailScale: 0 });
  }

  function updateFacadePixelSize(sceneRenderHeight: number): void {
    const pixelSize = (2 * rig.getOrthoHeight()) / Math.max(1, sceneRenderHeight);
    if (Math.abs(pixelSize - lastPixelSize) < 1e-5) return;
    lastPixelSize = pixelSize;
    updateFacadeMaterialSafe(facadeNear, { pixelSize });
    updateFacadeMaterialSafe(facadeFar, { pixelSize });
  }

  function currentFogRange(): { near: number; far: number } {
    const camDistance = rig.getCameraDistanceValue();
    // Scale the preset fog distances with the visible extent: at a district view
    // (660 m) this is byte-identical to the old preset offsets, at the ~9.6 km
    // complete-city overview the haze grows with the view instead of fogging the
    // whole city out.
    const viewScale = Math.max(1, rig.getOrthoHeight() / 660);
    return {
      near: Math.max(60, camDistance + (look.fogNear - FOG_REFERENCE_DISTANCE) * viewScale),
      far: Math.max(300, camDistance + (look.fogFar - FOG_REFERENCE_DISTANCE) * viewScale),
    };
  }

  /**
   * Scene materials own the atmospheric fog in both render paths, so the
   * clean-3D debug view and the pixel-art view agree on the horizon. The post
   * pass fog is effectively disabled.
   */
  function updateSceneFog(): void {
    const range = currentFogRange();
    fog.near = range.near;
    fog.far = range.far;
  }

  function markReady(): void {
    if (readyNotified || disposed) return;
    readyNotified = true;
    ready = true;
    debugGlobals.ready = true;
    try {
      options.onReady?.();
    } catch {
      /* ignore shell errors */
    }
    if (isMuseumFocus()) focusMuseum();
    else if (isLi2Focus()) focusWarMuseum();
    else focusLandmarkModel();
  }

  /** Frame the War Museum Li-2 (`?focus=li2`, used by QA captures). */
  function focusWarMuseum(): void {
    if (disposed) return;
    rig.focusOnLocal(WAR_MUSEUM.focus.x, WAR_MUSEUM.focus.y, true);
    rig.setSettings({ orthoHeight: WAR_MUSEUM.orthoHeight });
    streamer.ensureArea(WAR_MUSEUM.focus.x, WAR_MUSEUM.focus.y, 1);
    void warMuseum.load();
    markCameraDirty();
  }

  /** Frame a landmark model (`?focus=<slug>`, used by QA captures). */
  function focusLandmarkModel(): void {
    const slug = landmarkFocusSlug();
    if (disposed || !slug) return;
    void landmarkModels.load().then(() => {
      const point = landmarkModels.focusPoint(slug);
      if (disposed || !point) return;
      const meta = landmarkModels.manifest?.landmarks.find((entry) => entry.slug === slug);
      const [minE, minN, maxE, maxN] = meta?.extent ?? [-40, -40, 40, 40];
      rig.focusOnLocal(point.x, point.y, true);
      rig.setSettings({ orthoHeight: Math.max(60, Math.max(maxE - minE, maxN - minN) * 1.6) });
      streamer.ensureArea(point.x, point.y, 1);
      markCameraDirty();
    });
  }

  /** Frame the Lipki exhibits; the complete city always contains them. */
  function focusMuseum(): void {
    if (disposed) return;
    rig.focusOnLocal(MUSEUM.focus.x, MUSEUM.focus.y, true);
    rig.setSettings({ orthoHeight: MUSEUM.orthoHeight });
    streamer.ensureArea(MUSEUM.focus.x, MUSEUM.focus.y, 1);
    void museum.load();
    markCameraDirty();
  }

  function pickMuseumExhibit(clientX: number, clientY: number, rect: DOMRect): MuseumExhibitSelection | null {
    const mesh = museum.getMesh();
    if (!mesh || museum.state !== 'ready') return null;
    const width = Math.max(rect.width, 1);
    const height = Math.max(rect.height, 1);
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / width) * 2 - 1,
      -((clientY - rect.top) / height) * 2 + 1,
    );
    museumRaycaster.setFromCamera(ndc, rig.camera);
    const hits = museumRaycaster.intersectObject(mesh, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    const index = museum.exhibitIndexForTriangle(hit.faceIndex ?? -1);
    const meta = index >= 0 ? museum.manifest?.exhibits[index] : null;
    if (!meta) return null;
    return {
      index,
      slug: meta.slug,
      ref: meta.ref,
      x: meta.x,
      y: meta.y,
      heading: meta.heading,
      lengthM: meta.lengthM,
      spanM: meta.spanM,
      screenX: clientX,
      screenY: clientY,
    };
  }

  function handleClick(clientX: number, clientY: number): void {
    if (disposed || !picker) return;
    const rect = host!.canvas.getBoundingClientRect();
    // Транспорт проверяется ПЕРВЫМ: машина на экране стоит перед зданиями, и
    // клик по ней должен открывать карточку рейса, а не выбор дома за ней.
    const vehicle = pickMobilityTrip(clientX, clientY, rect);
    if (vehicle) {
      selected = null;
      highlightId = null;
      highlighter.setHighlight(null);
      try {
        options.onSelection?.(null);
      } catch {
        /* ignore shell errors */
      }
      const info = mobilityState.runtime?.describeTrip(vehicle.tripId) ?? null;
      mobilityState.runtime?.setSelectedTrip(info ? vehicle.tripId : null);
      try {
        options.onMobilitySelect?.(
          info ? { ...info, screenX: clientX, screenY: clientY } : null,
        );
      } catch {
        /* ignore shell errors */
      }
      if (info) return;
    }
    const exhibit = pickMuseumExhibit(clientX, clientY, rect);
    if (exhibit) {
      selected = null;
      highlightId = null;
      highlighter.setHighlight(null);
      try {
        options.onSelection?.(null);
      } catch {
        /* ignore shell errors */
      }
      try {
        options.onExhibitSelect?.(exhibit);
      } catch {
        /* ignore shell errors */
      }
      return;
    }
    const selection = picker.pick(clientX, clientY, rect);
    selected = selection;
    if (selection) {
      highlightId = selection.id;
      applyHighlight(selection.id);
    } else {
      highlightId = null;
      highlighter.setHighlight(null);
    }
    try {
      options.onSelection?.(selection);
    } catch {
      /* ignore shell errors */
    }
    try {
      // Клик по земле/зданию закрывает карточку транспорта.
      mobilityState.runtime?.setSelectedTrip(null);
      options.onMobilitySelect?.(null);
    } catch {
      /* ignore shell errors */
    }
  }

  /**
   * Экранный выбор транспорта: позиции машин уже известны симуляции, поэтому
   * вместо raycast достаточно спроецировать ≤20 нарисованных кузовов и взять
   * ближайший к курсору. Это дешевле и не зависит от instance-буферов.
   */
  const mobilityPickVector = new THREE.Vector3();
  function pickMobilityTrip(
    clientX: number,
    clientY: number,
    rect: DOMRect,
  ): MobilityTripSnapshot | null {
    const runtime = mobilityState.runtime;
    if (!runtime) return null;
    const dump = runtime.getDump();
    if (!dump || dump.trips.length === 0) return null;
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const targetX = ((clientX - rect.left) / width) * 2 - 1;
    const targetY = 1 - ((clientY - rect.top) / height) * 2;
    const pixelTolerance = 18;
    let best: { trip: MobilityTripSnapshot; pixels: number } | null = null;
    for (const trip of dump.trips) {
      if (!trip.drawn) continue;
      mobilityPickVector.set(trip.x, trip.h + 1.6, -trip.y).project(rig.camera);
      if (
        !Number.isFinite(mobilityPickVector.x) ||
        mobilityPickVector.z < -1 ||
        mobilityPickVector.z > 1
      ) {
        continue;
      }
      const pixels = Math.hypot(
        ((mobilityPickVector.x - targetX) * width) / 2,
        ((mobilityPickVector.y - targetY) * height) / 2,
      );
      if (pixels <= pixelTolerance && (!best || pixels < best.pixels)) best = { trip, pixels };
    }
    return best?.trip ?? null;
  }

  function applyResize(): void {
    if (disposed) return;
    const changed = host!.resize();
    if (!changed && !resizePending) return;
    resizePending = false;
    rig.setViewport(host!.width, host!.height);
    post.setSize(host!.width, host!.height, pixelArt);
    post.setEffectEnabled(pixelArt.enabled);
    refreshDefaultView();
    const sceneRenderHeight = post.getRenderSize().height;
    updateFacadePixelSize(sceneRenderHeight);
    renderer.shadowMap.needsUpdate = true;
    shadowDirty = true;
  }

  function updateStats(now: number): void {
    frames.count += 1;
    const elapsed = now - frames.windowStart;
    if (frames.count === 1) frames.frameMsAvg = elapsed;
    if (elapsed >= STATS_INTERVAL_MS) {
      const fps = (frames.count * 1000) / Math.max(elapsed, 1);
      const renderSize = post.getRenderSize();
      stats.fps = Math.round(fps * 10) / 10;
      stats.frameMs = Math.round((elapsed / Math.max(frames.count, 1)) * 10) / 10;
      stats.drawCalls = renderer.info.render.calls;
      stats.triangles = renderer.info.render.triangles;
      stats.visibleTiles = streamer.visibleTileCount;
      stats.loadedTiles = streamer.loadedTileCount;
      stats.buildings = streamer.loadedBuildingCount;
      stats.renderWidth = renderSize.width;
      stats.renderHeight = renderSize.height;
      stats.geometryMB = Math.round(streamer.geometryMB * 100) / 100;
      stats.mobility = mobility.getStatus();
      frames.count = 0;
      frames.windowStart = now;
      try {
        options.onStats?.(stats);
      } catch {
        /* ignore shell errors */
      }
      if (typeof window !== 'undefined') {
        (window as unknown as { __CITY_STATS__?: EngineStats }).__CITY_STATS__ = stats;
        debugGlobals.stats = stats;
      }
    }
  }

  function applyDebugOverrides(): void {
    if (debugOverrides.exposure !== null) {
      renderer.toneMappingExposure = debugOverrides.exposure;
      post.setUniformValue('uExposure', debugOverrides.exposure);
    }
    if (debugOverrides.outline !== null) post.setUniformValue('uOutline', debugOverrides.outline);
    if (debugOverrides.paletteMix !== null) {
      post.setUniformValue('uPaletteMix', debugOverrides.paletteMix);
    }
    if (debugOverrides.toneMode !== null) {
      const mode = debugOverrides.toneMode;
      const tone =
        mode > 1.5
          ? THREE.ACESFilmicToneMapping
          : mode > 0.5
            ? THREE.LinearToneMapping
            : THREE.NeutralToneMapping;
      if (renderer.toneMapping !== tone) renderer.toneMapping = tone;
      post.setToneMode(mode);
    }
    if (debugOverrides.facadePaletteMix !== null) {
      updateFacadeMaterialSafe(facadeNear, { paletteMix: debugOverrides.facadePaletteMix });
      updateFacadeMaterialSafe(facadeFar, { paletteMix: debugOverrides.facadePaletteMix });
    }
  }

  // --- per-frame update ----------------------------------------------------
  function tick(dt: number, now: number): void {
    if (resizePending) applyResize();

    controls?.update(dt);
    const cameraChanged = rig.update(dt);
    if (cameraChanged) {
      shadowDirty = true;
      renderer.shadowMap.needsUpdate = true;
    }

    const sceneRenderHeight = post.getRenderSize().height;
    streamer.update(rig, sceneRenderHeight);

    // Dynamic mobility layer: same frame, no second render loop. The visible
    // ground rect is converted to local metres (x east, y north) for the loader.
    const groundFootprint = rig.getVisibleGroundRect(40);
    mobility.update(dt, {
      rect: {
        minX: groundFootprint.minX,
        maxX: groundFootprint.maxX,
        minY: -Math.max(groundFootprint.minZ, groundFootprint.maxZ),
        maxY: -Math.min(groundFootprint.minZ, groundFootprint.maxZ),
      },
      worldPerPixel: rig.getPixelWorldSize(sceneRenderHeight),
    });

    // Keep the shadow map fresh while tiles stream in (new casters) and for a
    // few frames after any camera/light/tile change.
    if (streamer.loadedTileCount < streamer.visibleTileCount) shadowDirty = true;
    if (shadowDirty || cameraChanged || shadowRefreshFrames > 0) {
      const footprint = rig.getVisibleGroundRect(240);
      lighting.updateShadow(footprint, maxCasterHeight, rig.getOrthoHeight());
      renderer.shadowMap.needsUpdate = true;
      shadowDirty = false;
      shadowRefreshFrames = Math.max(0, shadowRefreshFrames - 1);
    }

    updateFacadePixelSize(sceneRenderHeight);
    updateSceneFog();

    // Depth range + fog/edge uniforms for the post pass.
    const camera = rig.camera;
    const sinElevation = Math.max(0.2, Math.sin(rig.getElevation()));
    const pixelWorld = rig.getPixelWorldSize(sceneRenderHeight);
    postEnvironment.pixelWorld = pixelWorld;
    // View depth of a ground point changes by pixelWorld / tan(elevation) per
    // screen pixel along the up-screen ground direction (horizontal movement
    // does not change view depth at all). The edge detector sums opposite
    // neighbours (x2) plus four diagonals (x1.4), so a flat road produces a
    // baseline gradient of 3.4 * pixelWorld / tan(elevation). Thresholds sit
    // above that baseline so only real silhouettes get outlined.
    const tanElevation = Math.max(Math.tan(rig.getElevation()), 0.25);
    const groundDepthStep = pixelWorld / tanElevation;
    const groundSlopeGradient = groundDepthStep * 3.4;
    postEnvironment.edgeLow = groundSlopeGradient * 1.25;
    postEnvironment.edgeHigh = groundSlopeGradient * 2.3;
    void sinElevation;
    post.updateEnvironment(postEnvironment);
    post.setDepthRange(camera.near, camera.far);
    applyDebugOverrides();

    highlighter.update(now);

    renderer.info.reset();
    post.render(scene, camera);
    updateStats(now);
  }

  function frame(now: number): void {
    if (!running || disposed) return;
    rafId = requestAnimationFrame(frame);
    const dt = clamp((now - frames.lastFrame) / 1000, 0, 0.1);
    frames.lastFrame = now;
    try {
      tick(dt, now);
    } catch (error) {
      frameErrors += 1;
      if (frameErrors <= 3) {
        recordDiagnostic(`frame error: ${String(error)}`);
        console.warn('[city] frame error (renderer keeps running):', error);
      }
      if (frameErrors > 30) {
        running = false;
        recordError('Rendering stopped after repeated frame errors.');
      }
    }
  }

  // --- wiring --------------------------------------------------------------
  controls = new CameraControls({
    canvas: host.canvas,
    rig,
    onClick: handleClick,
    onDoubleClick: (_clientX, _clientY, localX, localY) => {
      rig.focusOnLocal(localX, localY, false);
      streamer.ensureArea(localX, localY, 1);
      markCameraDirty();
    },
    onReset: () => {
      rig.reset(defaultView.orthoHeight, defaultView.targetLocalX, defaultView.targetLocalY);
      markCameraDirty();
    },
    onEscape: () => handle.clearSelection(),
    isEnabled: () => !disposed,
  });

  const resizeObserver = new ResizeObserver(() => {
    resizePending = true;
  });
  resizeObserver.observe(container);

  // Initial view state.
  applyTimeOfDay(13);
  applyFacadeDetailFlags();
  applyFacadePixelFlagsInitial();

  function applyFacadePixelFlagsInitial(): void {
    applyPixelArtFlags();
    updateSceneFog();
  }

  // URL-driven initial camera/time overrides (QA convenience).
  const initialZoom = Number.parseFloat(params.get('zoom') ?? '');
  if (Number.isFinite(initialZoom)) {
    handle.setCameraSettings({ orthoHeight: initialZoom });
  }
  const initialAzimuth = Number.parseFloat(params.get('az') ?? '');
  if (Number.isFinite(initialAzimuth)) {
    handle.setCameraSettings({ azimuth: initialAzimuth });
  }
  const initialTime = Number.parseFloat(params.get('time') ?? '');
  if (Number.isFinite(initialTime)) {
    handle.setTimeOfDay(initialTime);
  }

  void streamer.start();
  // Render the first frame immediately (ground plane + camera) so the canvas is
  // never blank while tiles stream in.
  handle.start();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    try {
      resizeObserver.disconnect();
    } catch {
      /* ignore */
    }
    try {
      controls?.dispose();
    } catch {
      /* ignore */
    }
    controls = null;
    try {
      museum.dispose();
      warMuseum.dispose();
      landmarkModels.dispose();
      mobilityState.runtime = null;
      mobility.dispose();
      streamer.dispose();
    } catch (error) {
      recordDiagnostic(`streamer dispose failed: ${String(error)}`);
    }
    try {
      highlighter.dispose();
    } catch {
      /* ignore */
    }
    try {
      lighting.dispose();
    } catch {
      /* ignore */
    }
    try {
      disposeFacadeMaterialSafe(facadeNear);
      disposeFacadeMaterialSafe(facadeFar);
    } catch {
      /* ignore */
    }
    try {
      environment.dispose();
    } catch {
      /* ignore */
    }
    try {
      post.dispose();
    } catch {
      /* ignore */
    }
    scene.clear();
    try {
      host!.dispose();
    } catch {
      /* ignore */
    }
    if (typeof window !== 'undefined') {
      const globals = window as unknown as {
        __CITY_APP__?: DebugGlobals;
        __CITY_STATS__?: EngineStats;
        __CITY_DEBUG__?: unknown;
      };
      if (globals.__CITY_APP__ === debugGlobals) delete globals.__CITY_APP__;
      if (globals.__CITY_STATS__ === stats) delete globals.__CITY_STATS__;
      if (globals.__CITY_DEBUG__ === debugApi) delete globals.__CITY_DEBUG__;
    }
    selected = null;
    highlightId = null;
  }

  void selected;
  void ready;
  return handle;
}
