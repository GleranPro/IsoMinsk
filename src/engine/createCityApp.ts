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
  CityAppHandle,
  CityAppOptions,
  EngineStats,
  PixelArtSettings,
} from '../shared/appApi';
import type { FeatureId, TileManifest } from '../shared/types';
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

const EXPOSURE = 1.0;
const STATS_INTERVAL_MS = 500;
const DEFAULT_PIXEL_ART: PixelArtSettings = {
  enabled: true,
  resolution: 360,
  outline: 0.62,
  colorLevels: 14,
  dither: 0.35,
};
const FOG_NEAR_FACTOR = 0.55;
const FOG_FAR_FACTOR = 2.1;

interface DebugGlobals {
  ready: boolean;
  app: CityAppHandle;
  stats: EngineStats;
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
  const demoMode = params.get('demo') === '1';
  const noLimit = params.get('nolimit') === '1';

  const errors: string[] = [];
  const diagnostics: string[] = [];
  let disposed = false;
  let ready = false;
  let readyNotified = false;

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
  const maxShadowMapSize = renderer.capabilities.maxTextureSize >= 8192 ? 4096 : 2048;
  const lighting = new LightingRig(scene, maxShadowMapSize);
  let look = lighting.state.look;
  let timeHours = 13;

  // --- camera --------------------------------------------------------------
  const rig = new IsometricCameraRig({
    aspect: host.width / Math.max(1, host.height),
    widthCss: host.width,
    heightCss: host.height,
  });

  // --- pixel-art pipeline --------------------------------------------------
  const pixelArt: PixelArtSettings = { ...DEFAULT_PIXEL_ART };
  if (params.get('pixel') === '0') pixelArt.enabled = false;
  if (params.get('pixel') === '1') pixelArt.enabled = true;
  const post = new PixelArtPipeline(renderer, pixelArt);
  post.setSize(host.width, host.height, pixelArt);

  const postEnvironment: PixelArtEnvironment = {
    fogColor: [0.9, 0.92, 0.94],
    skyColor: [0.9, 0.92, 0.94],
    outlineColor: [0.07, 0.09, 0.11],
    fogNear: 2000,
    fogFar: 6000,
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

  const highlighter = new BuildingHighlighter(cityRoot);
  let picker: BuildingPicker | null = null;
  let controls: CameraControls | null = null;

  const streamer = new TileStreamer({
    scene,
    root: cityRoot,
    environmentMaterial: environment.environment,
    treeMaterial: environment.trees,
    facadeMaterialNear: facadeNear,
    facadeMaterialFar: facadeFar,
    demo: demoMode,
    nolimit: noLimit,
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

  // --- state shared with the frame loop ------------------------------------
  const stats: EngineStats = createZeroStats();
  const frames = { count: 0, windowStart: performance.now(), lastFrame: performance.now(), frameMsAvg: 0 };
  let selected: BuildingSelection | null = null;
  let lastPixelSize = 0;
  let running = false;
  let rafId = 0;
  let resizePending = true;
  let frameErrors = 0;

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
      rig.reset();
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
    setPixelArt(settings: Partial<PixelArtSettings>) {
      Object.assign(pixelArt, clampPixelArt(settings, pixelArt));
      post.setSettings(pixelArt);
      post.setSize(host.width, host.height, pixelArt);
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
    highlightBuilding(id: FeatureId | null) {
      highlightId = id;
      applyHighlight(id);
    },
  };

  // --- debug globals -------------------------------------------------------
  const debugGlobals: DebugGlobals = {
    ready: false,
    app: handle,
    stats,
    errors,
    diagnostics,
  };
  if (typeof window !== 'undefined') {
    (window as unknown as { __CITY_APP__?: DebugGlobals }).__CITY_APP__ = debugGlobals;
    (window as unknown as { __CITY_STATS__?: EngineStats }).__CITY_STATS__ = stats;
  }

  // --- helpers -------------------------------------------------------------
  function markCameraDirty(): void {
    shadowDirty = true;
    renderer.shadowMap.needsUpdate = true;
    resizePending = false;
    const sceneRenderHeight = pixelArt.enabled ? post.getRenderSize().height : host!.height;
    updateFacadePixelSize(sceneRenderHeight);
  }

  function applyManifestBounds(manifest: TileManifest): void {
    const bounds = manifest.bounds;
    if (!Array.isArray(bounds) || bounds.length !== 4) return;
    const [minX, minY, maxX, maxY] = bounds;
    // local metres -> world: X unchanged, Z = -localY.
    rig.setBounds({ minX, maxX, minZ: -maxY, maxZ: -minY });
    if (manifest.counts && typeof manifest.counts.buildings === 'number') {
      recordDiagnostic(`manifest: ${manifest.tiles.length} tiles, ${manifest.counts.buildings} buildings`);
    }
    markCameraDirty();
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
    shadowDirty = true;
    renderer.shadowMap.needsUpdate = true;
  }

  function updateLookColors(): void {
    const fogUnit = rgbUnit(look.fogHex);
    const skyUnit = rgbUnit(look.skyHex);
    postEnvironment.fogColor = fogUnit;
    postEnvironment.skyColor = skyUnit;
    const ink = mixHex('#121821', '#05070b', clamp(look.nightFactor, 0, 1));
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
    const sceneRenderHeight = pixelArt.enabled ? post.getRenderSize().height : host!.height;
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
    const height = rig.getOrthoHeight();
    return {
      near: camDistance + height * FOG_NEAR_FACTOR,
      far: camDistance + height * FOG_FAR_FACTOR,
    };
  }

  function updateSceneFog(): void {
    const range = currentFogRange();
    if (pixelArt.enabled) {
      // The post pass owns atmospheric fog in pixel mode; keep the material fog
      // effectively disabled without recompiling shaders when the toggle flips.
      fog.near = 1_000_000;
      fog.far = 2_000_000;
    } else {
      fog.near = range.near;
      fog.far = range.far;
    }
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
  }

  function handleClick(clientX: number, clientY: number): void {
    if (disposed || !picker) return;
    const rect = host!.canvas.getBoundingClientRect();
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
  }

  function applyResize(): void {
    if (disposed) return;
    const changed = host!.resize();
    if (!changed && !resizePending) return;
    resizePending = false;
    rig.setViewport(host!.width, host!.height);
    post.setSize(host!.width, host!.height, pixelArt);
    const sceneRenderHeight = pixelArt.enabled ? post.getRenderSize().height : host!.height;
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
      const renderSize = pixelArt.enabled
        ? post.getRenderSize()
        : { width: host!.width, height: host!.height };
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

  // --- per-frame update ----------------------------------------------------
  function tick(dt: number, now: number): void {
    if (resizePending) applyResize();

    controls?.update(dt);
    const cameraChanged = rig.update(dt);
    if (cameraChanged) {
      shadowDirty = true;
      renderer.shadowMap.needsUpdate = true;
    }

    const sceneRenderHeight = pixelArt.enabled ? post.getRenderSize().height : host!.height;
    streamer.update(rig, sceneRenderHeight);

    if (shadowDirty || cameraChanged) {
      const footprint = rig.getVisibleGroundRect(240);
      lighting.updateShadow(footprint, maxCasterHeight);
      renderer.shadowMap.needsUpdate = true;
      shadowDirty = false;
    }

    updateFacadePixelSize(sceneRenderHeight);
    updateSceneFog();

    // Depth range + fog/edge uniforms for the post pass.
    const camera = rig.camera;
    const fogRange = currentFogRange();
    const sinElevation = Math.max(0.2, Math.sin(rig.getElevation()));
    const pixelWorld = rig.getPixelWorldSize(sceneRenderHeight);
    postEnvironment.pixelWorld = pixelWorld;
    postEnvironment.edgeLow = pixelWorld * (sinElevation + 0.35);
    postEnvironment.edgeHigh = postEnvironment.edgeLow + pixelWorld * 1.7;
    postEnvironment.fogNear = fogRange.near;
    postEnvironment.fogFar = fogRange.far;
    post.updateEnvironment(postEnvironment);
    post.setDepthRange(camera.near, camera.far);

    highlighter.update(now);

    renderer.info.reset();
    post.render(scene, camera, pixelArt.enabled);
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
      rig.reset();
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
      };
      if (globals.__CITY_APP__ === debugGlobals) delete globals.__CITY_APP__;
      if (globals.__CITY_STATS__ === stats) delete globals.__CITY_STATS__;
    }
    selected = null;
    highlightId = null;
  }

  void selected;
  void ready;
  return handle;
}
