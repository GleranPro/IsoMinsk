/**
 * L1 building-family gallery (QA entry, not a public map mode).
 *
 * Renders one deterministic fixture per recipe (27 panels) with the production
 * geometry builder and the production facade material, in recipe-id order and in
 * a second seeded order, so palette/variant collapse is visible instead of being
 * hidden by one lucky sample.
 *
 * It exposes `window.__BUILDING_GALLERY__` for the Playwright capture script and
 * `tests/e2e/buildingGallery.spec.ts`:
 *
 *   ready, readyPanels, expectedPanels, consoleErrors, panels[],
 *   setCamera({ panel?, azimuth?, elevation?, orthoHeight?, timeHours?,
 *               pixelArt?, order? }), resetCamera()
 *
 * The gallery never becomes a second city selector: it is served from `qa/`
 * (not from the application route) and is excluded from the Pages artifact.
 */

import * as THREE from 'three';
import { buildBuildingsMesh } from '../city/buildings/buildingsMesh';
import { createFacadeMaterial, updateFacadeUniforms } from '../engine/materials/facadeMaterial';
import { LightingRig } from '../engine/renderer/lighting';
import { PixelArtPipeline } from '../engine/postprocess/pixelArtPipeline';
import { ISO_CAMERA } from '../shared/config';
import {
  LEGACY_RECIPE_OFFSET,
  STYLE_RECIPES,
  type StyleRecipe,
} from '../shared/buildingStyles';
import type { Archetype, BuildingFeature, BuildingVolume, RoofShape } from '../shared/types';
import type { PixelArtSettings } from '../shared/appApi';

export interface GalleryPanelInfo {
  index: number;
  recipeId: number;
  name: string;
  archetype: Archetype;
  profile: string;
  facade: string;
  roof: string;
  height: number;
  floors: number;
  sourceRoof: RoofShape;
  triangles: number;
  wallTriangles: number;
  roofTriangles: number;
  trimTriangles: number;
  detailTriangles: number;
  bytes: number;
}

export interface GalleryCameraOptions {
  panel?: number;
  azimuth?: number;
  elevation?: number;
  orthoHeight?: number;
  timeHours?: number;
  pixelArt?: boolean;
  order?: 'recipe' | 'seeded';
}

export interface BuildingGalleryApi {
  ready: boolean;
  readyPanels: number;
  expectedPanels: number;
  consoleErrors: string[];
  panels: GalleryPanelInfo[];
  setCamera(options: GalleryCameraOptions): void;
  resetCamera(): void;
  renderOnce(): void;
  /** Luminance / coverage statistics of the last rendered frame (capture QA). */
  canvasStats(): { meanLuma: number; coveredPixels: number; sampledPixels: number };
  /** Current camera/focus state (capture QA). */
  debugState(): {
    orthoHeight: number;
    azimuth: number;
    elevation: number;
    focusPanel: number | null;
    camera: { left: number; right: number; top: number; bottom: number; position: number[] };
  };
}

declare global {
  interface Window {
    /** QA-only gallery handle (never present in the public application). */
    __BUILDING_GALLERY__?: BuildingGalleryApi;
  }
}

interface GalleryPanel {
  info: GalleryPanelInfo;
  /** Panel centre in local plan metres. */
  x: number;
  y: number;
  mesh: THREE.Mesh;
  label: HTMLDivElement;
}

const PANEL_SPACING_X = 64;
const PANEL_SPACING_Y = 52;
const GRID_COLUMNS = 7;
const DEFAULT_PIXEL_ART: PixelArtSettings = {
  enabled: false,
  resolution: 360,
  outline: 0.55,
  colorLevels: 20,
  dither: 0.35,
};

/** Floor counts chosen so the fixture height suits the recipe's eligibility. */
const RECIPE_FLOORS: Record<string, number> = {
  ensemble_symmetric: 8,
  end_pavilion: 7,
  restrained_monument: 6,
  brick_punched: 5,
  balcony_slab: 5,
  pitched_low_block: 4,
  recessed_loggia: 9,
  endwall_tower: 10,
  staircore_spine: 9,
  podium_tower: 12,
  stepped_residential: 8,
  framed_residential: 9,
  curtain_ribbon: 8,
  framed_stone_grid: 7,
  commercial_podium: 6,
  plaster_street_house: 3,
  brick_gabled_house: 3,
  mansard_attic: 3,
  sawtooth_factory: 2,
  broad_clerestory_hall: 2,
  service_workshop: 2,
  hipped_house: 2,
  flat_service_annex: 1,
  gabled_workshop: 1,
  school_hospital_wings: 4,
  public_colonnade: 4,
  assembly_hall: 3,
};

/** Footprint per recipe; sawtooth/clerestory halls need long, wide halls. */
function footprintFor(recipe: StyleRecipe): { width: number; depth: number } {
  if (recipe.roof === 'sawtooth' || recipe.roof === 'clerestory') return { width: 42, depth: 18 };
  if (recipe.name === 'assembly_hall') return { width: 32, depth: 18 };
  if (recipe.name === 'public_colonnade') return { width: 30, depth: 16 };
  if (recipe.archetype === 'historic' || recipe.archetype === 'small') return { width: 20, depth: 12 };
  return { width: 26, depth: 14 };
}

/** Source roof a panel declares: flat for variant recipes, else archetype-typical. */
function sourceRoofFor(recipe: StyleRecipe): RoofShape {
  if (recipe.roof === 'hip' || recipe.roof === 'mansard' || recipe.roof === 'sawtooth' || recipe.roof === 'clerestory') {
    return 'flat';
  }
  if (recipe.archetype === 'historic' || recipe.archetype === 'small') return 'gabled';
  return 'flat';
}

function rectRing(minX: number, minY: number, maxX: number, maxY: number): [number, number][] {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

/** Deterministic gallery fixture for one recipe (declared eligibility included). */
export function galleryFixture(recipe: StyleRecipe): { building: BuildingFeature; floors: number } {
  const floors = RECIPE_FLOORS[recipe.name] ?? 4;
  const { width, depth } = footprintFor(recipe);
  const floorHeight =
    recipe.archetype === 'industrial' ? 6.0 : recipe.archetype === 'civic' ? 4.2 : 3.0;
  const height = Math.max(4, Math.round(floors * floorHeight * 10) / 10);
  const roofShape = sourceRoofFor(recipe);
  const volume: BuildingVolume = {
    footprint: [rectRing(0, 0, width, depth)],
    minHeight: 0,
    height,
    roofShape,
    roofHeight: roofShape === 'gabled' ? Math.min(4, depth * 0.28) : 0,
    ...(roofShape === 'gabled' ? { roofDirection: 0 } : {}),
    heightSource: 'heuristic',
  };
  const building: BuildingFeature = {
    id: `w${900000 + recipe.id}`,
    osmType: 'way',
    osmId: 900000 + recipe.id,
    name: recipe.name,
    archetype: recipe.archetype,
    levels: floors,
    height,
    roofShape,
    volumes: [volume],
    tags: {},
    styleVariant: {
      schema: 1,
      recipeId: recipe.id,
      source: 'heuristic',
      eligibility: ['synthetic_gallery'],
    },
  };
  return { building, floors };
}

function seededOrder(recipes: readonly StyleRecipe[]): StyleRecipe[] {
  // Deterministic second order (golden-ratio stride over the id space).
  const order: StyleRecipe[] = [];
  const used = new Set<number>();
  let cursor = 0;
  for (let step = 0; step < recipes.length; step++) {
    cursor = (cursor + 11) % recipes.length;
    while (used.has(cursor)) cursor = (cursor + 1) % recipes.length;
    used.add(cursor);
    order.push(recipes[cursor]);
  }
  return order;
}

export function createBuildingGallery(container: HTMLElement): BuildingGalleryApi {
  const consoleErrors: string[] = [];
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    consoleErrors.push(args.map((value) => String(value)).join(' '));
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map((value) => String(value)).join(' '));
    originalError(...args);
  };

  const width = Math.max(320, container.clientWidth || 1600);
  const height = Math.max(240, container.clientHeight || 900);
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    // The capture script samples the canvas after a frame; without this the
    // drawing buffer is cleared and every panel reads as black.
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Match the production renderer: neutral tone mapping with the same exposure.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.02;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#cfd6dc');
  const rig = new LightingRig(scene, 4096);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 6000);

  const pixelArt = { ...DEFAULT_PIXEL_ART };
  const post = new PixelArtPipeline(renderer, pixelArt);
  post.setSize(width, height, pixelArt);
  post.setEffectEnabled(false);

  const material = createFacadeMaterial({ detail: true, night: 0, quantise: true });
  const panels: GalleryPanel[] = [];
  const expectedPanels = STYLE_RECIPES.length;
  let currentOrder: 'recipe' | 'seeded' = 'recipe';
  let focusPanel: number | null = null;
  let azimuth = ISO_CAMERA.azimuth;
  let elevation = ISO_CAMERA.elevation;
  let orthoHeight = 420;

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID_COLUMNS * PANEL_SPACING_X + 80, Math.ceil(expectedPanels / GRID_COLUMNS) * PANEL_SPACING_Y + 80),
    new THREE.MeshLambertMaterial({ color: '#8d9089' }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(
    ((GRID_COLUMNS - 1) * PANEL_SPACING_X) / 2,
    -0.02,
    -((Math.ceil(expectedPanels / GRID_COLUMNS) - 1) * PANEL_SPACING_Y) / 2,
  );
  scene.add(ground);

  const layout = (order: 'recipe' | 'seeded'): void => {
    currentOrder = order;
    const sequence = order === 'recipe' ? [...STYLE_RECIPES] : seededOrder(STYLE_RECIPES);
    for (let index = 0; index < sequence.length; index++) {
      const recipe = sequence[index];
      const column = index % GRID_COLUMNS;
      const row = Math.floor(index / GRID_COLUMNS);
      const x = column * PANEL_SPACING_X;
      const y = -row * PANEL_SPACING_Y;
      const panel = panels[index];
      panel.mesh.position.set(x, 0, -y);
      panel.x = x;
      panel.y = y;
      panel.label.style.left = `${(column / GRID_COLUMNS) * 100}%`;
      panel.label.style.top = `${(row / Math.ceil(expectedPanels / GRID_COLUMNS)) * 100}%`;
      panel.label.textContent = `#${recipe.id} ${recipe.name} · ${recipe.archetype} · ${panel.info.floors}F ${panel.info.height}m · ${recipe.roof}`;
      panel.info.recipeId = recipe.id;
      panel.info.name = recipe.name;
    }
    focusPanel = null;
    applyFocusVisibility();
  };

  /**
   * A focused panel is isolated: the other meshes and labels are hidden so a
   * 90 m close capture shows exactly one family, not its neighbours. The grid
   * views (ocusPanel === null) show every panel.
   */
  const applyFocusVisibility = (): void => {
    for (let index = 0; index < panels.length; index++) {
      const visible = focusPanel === null || focusPanel === index;
      panels[index].mesh.visible = visible;
      panels[index].label.style.display = visible ? 'block' : 'none';
    }
  };

  for (let index = 0; index < expectedPanels; index++) {
    const recipe = STYLE_RECIPES[index];
    const { building, floors } = galleryFixture(recipe);
    const result = buildBuildingsMesh([building], { facadeDetail: true, detailScale: 1 });
    const mesh = new THREE.Mesh(result.geometry, material);
    mesh.name = `panel-${recipe.id}-${recipe.name}`;
    mesh.position.set(0, 0, 0);
    scene.add(mesh);
    const label = document.createElement('div');
    label.className = 'gallery-label';
    container.appendChild(label);
    const counts = faceKindCounts(result.geometry);
    panels.push({
      info: {
        index,
        recipeId: recipe.id,
        name: recipe.name,
        archetype: recipe.archetype,
        profile: recipe.profile,
        facade: recipe.facade,
        roof: recipe.roof,
        height: building.height,
        floors,
        sourceRoof: building.roofShape,
        triangles: result.triangleCount,
        wallTriangles: counts.wall,
        roofTriangles: counts.roof,
        trimTriangles: counts.trim,
        detailTriangles: result.stats.detailTriangles,
        bytes: result.stats.geometryBytes,
      },
      x: 0,
      y: 0,
      mesh,
      label,
    });
  }
  layout('recipe');

  const aspect = width / height;
  const applyCamera = (): void => {
    camera.left = -orthoHeight * aspect;
    camera.right = orthoHeight * aspect;
    camera.top = orthoHeight;
    camera.bottom = -orthoHeight;
    camera.updateProjectionMatrix();
    const targetX = focusPanel !== null ? panels[focusPanel].x : ((GRID_COLUMNS - 1) * PANEL_SPACING_X) / 2;
    const targetY = focusPanel !== null ? panels[focusPanel].y : -((Math.ceil(expectedPanels / GRID_COLUMNS) - 1) * PANEL_SPACING_Y) / 2;
    const distance = ISO_CAMERA.distance;
    const horizontal = Math.cos(elevation) * distance;
    const dirX = Math.cos(azimuth) * horizontal;
    const dirZ = Math.sin(azimuth) * horizontal;
    const dirY = Math.sin(elevation) * distance;
    camera.position.set(targetX + dirX, dirY, -targetY + dirZ);
    camera.lookAt(targetX, 0, -targetY);
    camera.updateMatrixWorld();
    // Fit the shadow frustum to the framed panel: the default city-scale
    // frustum is far too coarse for a 10-30 m building and would self-shadow it.
    rig.updateShadow(
      { minX: targetX - 40, maxX: targetX + 40, minZ: -targetY - 40, maxZ: -targetY + 40 },
      40,
      orthoHeight,
    );
  };
  applyCamera();

  const api: BuildingGalleryApi = {
    ready: false,
    readyPanels: 0,
    expectedPanels,
    consoleErrors,
    panels: panels.map((panel) => panel.info),
    setCamera(options: GalleryCameraOptions) {
      if (options.order) layout(options.order);
      if (typeof options.panel === 'number') focusPanel = Math.max(0, Math.min(panels.length - 1, options.panel));
      applyFocusVisibility();
      if (typeof options.azimuth === 'number' && Number.isFinite(options.azimuth)) azimuth = options.azimuth;
      if (typeof options.elevation === 'number' && Number.isFinite(options.elevation)) elevation = options.elevation;
      if (typeof options.orthoHeight === 'number' && Number.isFinite(options.orthoHeight)) {
        orthoHeight = Math.max(20, options.orthoHeight);
      }
      if (typeof options.timeHours === 'number' && Number.isFinite(options.timeHours)) {
        rig.setTimeOfDay(options.timeHours);
        updateFacadeUniforms(material, {
          night: sampleNightFactor(options.timeHours),
          timeHours: options.timeHours,
        });
      }
      if (typeof options.pixelArt === 'boolean') {
        pixelArt.enabled = options.pixelArt;
        post.setEffectEnabled(options.pixelArt);
      }
      applyCamera();
      api.renderOnce();
    },
    resetCamera() {
      focusPanel = null;
      applyFocusVisibility();
      azimuth = ISO_CAMERA.azimuth;
      elevation = ISO_CAMERA.elevation;
      orthoHeight = 420;
      applyCamera();
      api.renderOnce();
    },
    renderOnce() {
      updateFacadeUniforms(material, { pixelSize: (2 * orthoHeight) / Math.max(1, height) });
      if (pixelArt.enabled) {
        post.render(scene, camera);
      } else {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
      }
    },
    debugState() {
      return {
        orthoHeight,
        azimuth,
        elevation,
        focusPanel,
        camera: {
          left: camera.left,
          right: camera.right,
          top: camera.top,
          bottom: camera.bottom,
          position: camera.position.toArray(),
        },
      };
    },
    canvasStats() {
      // Copy the WebGL canvas into a 2D canvas and sample its luminance. Used by
      // the capture script to fail a black or empty panel instead of trusting the
      // triangle count alone.
      const source = renderer.domElement;
      const sampleWidth = Math.min(240, source.width);
      const sampleHeight = Math.min(160, source.height);
      const scratch = document.createElement('canvas');
      scratch.width = sampleWidth;
      scratch.height = sampleHeight;
      const context = scratch.getContext('2d', { willReadFrequently: true });
      if (!context) return { meanLuma: 0, coveredPixels: 0, sampledPixels: 0 };
      context.drawImage(source, 0, 0, sampleWidth, sampleHeight);
      const data = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
      let sum = 0;
      let covered = 0;
      const total = sampleWidth * sampleHeight;
      // Background is the flat sky colour; anything clearly different is geometry.
      const bgR = 0xcf;
      const bgG = 0xd6;
      const bgB = 0xdc;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB) > 18) covered++;
      }
      return {
        meanLuma: total > 0 ? sum / total : 0,
        coveredPixels: covered,
        sampledPixels: total,
      };
    },
  };

  // One warm-up render so shader compilation errors surface before `ready`.
  api.renderOnce();
  api.readyPanels = panels.filter((panel) => panel.info.triangles > 0).length;
  api.ready = api.readyPanels === expectedPanels;
  api.renderOnce();

  window.__BUILDING_GALLERY__ = api;
  return api;
}

/** Count triangles per face kind (wall / roof / trim) for the L1 checklist. */
function faceKindCounts(geometry: THREE.BufferGeometry): { wall: number; roof: number; trim: number } {
  const face = geometry.getAttribute('aFace');
  const index = geometry.getIndex();
  const triangleCount = index ? index.count / 3 : face ? face.count / 3 : 0;
  const counts = { wall: 0, roof: 0, trim: 0 };
  if (!face) return counts;
  for (let t = 0; t < triangleCount; t++) {
    const vertex = index ? index.getX(t * 3) : t * 3;
    const kind = Math.round(face.getX(vertex));
    if (kind === 0 || kind === 2 || kind === 4) counts.wall++;
    else if (kind === 1 || kind === 5) counts.roof++;
    else if (kind === 3) counts.trim++;
  }
  return counts;
}

function sampleNightFactor(hours: number): number {
  // Mirrors TIME_OF_DAY_PRESETS.nightFactor without importing the renderer loop.
  if (hours >= 22 || hours < 5) return 1;
  if (hours >= 20) return 0.55;
  if (hours >= 18) return 0.12;
  return 0;
}

/** Browser bootstrap used by `qa/building-gallery.html`. */
export function mountBuildingGallery(): void {
  const container = document.getElementById('gallery');
  if (!container) throw new Error('building gallery: #gallery container missing');
  const gallery = createBuildingGallery(container);
  gallery.setCamera({ timeHours: 13, pixelArt: false });
  const start = document.getElementById('gallery-start');
  if (start) start.textContent = `${gallery.readyPanels}/${gallery.expectedPanels} panels`;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const boot = (): void => {
    try {
      mountBuildingGallery();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = document.getElementById('gallery-start');
      if (status) status.textContent = `gallery error: ${message}`;
      console.error(error);
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}

/** Exported for tests: the seeded order used by the second gallery pass. */
export function gallerySeededOrder(): number[] {
  return seededOrder(STYLE_RECIPES).map((recipe) => recipe.id);
}

/** Legacy recipe ids never appear as gallery families. */
export const GALLERY_EXCLUDED_RECIPE_IDS = Array.from(
  { length: LEGACY_RECIPE_OFFSET },
  (_, index) => LEGACY_RECIPE_OFFSET + index,
);
