/**
 * Isometric Minsk — public contract between the React UI shell (`src/app`) and
 * the imperative Three.js engine (`src/engine`).
 *
 * React never creates scene objects. It mounts a single canvas container and
 * talks to the engine exclusively through `CityAppHandle`.
 */

import type { BuildingFeature, FeatureId } from './types';

export interface BuildingSelection {
  id: FeatureId;
  feature: BuildingFeature;
  /** Screen-space pixel coordinates of the picked point, for the tooltip. */
  screenX: number;
  screenY: number;
}

export interface EngineStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  visibleTiles: number;
  loadedTiles: number;
  buildings: number;
  renderWidth: number;
  renderHeight: number;
  /** Approximate GPU geometry memory in megabytes. */
  geometryMB: number;
}

export interface CityAppOptions {
  container: HTMLElement;
  /** Called when the renderer is ready to accept input. */
  onReady?: () => void;
  /** Called every ~500 ms with fresh performance numbers. */
  onStats?: (stats: EngineStats) => void;
  /** Called when a building pick completes (or is cleared with null). */
  onSelection?: (selection: BuildingSelection | null) => void;
  /** Called when a tile finishes loading (for the loading indicator). */
  onLoadingChange?: (loading: boolean, progress: number) => void;
  /** Called on fatal initialisation errors (e.g. WebGL2 unavailable). */
  onError?: (message: string) => void;
}

export interface PixelArtSettings {
  enabled: boolean;
  /** Internal vertical render resolution in pixels (before upscaling). */
  resolution: number;
  /** Outline strength 0..1. */
  outline: number;
  /** Colour quantisation steps per channel (0 = off). */
  colorLevels: number;
  /** Dither strength 0..1. */
  dither: number;
}

export interface CameraSettings {
  /** Vertical half-extent of the orthographic frustum in metres. */
  orthoHeight: number;
  /** Rotation about the vertical axis, radians. */
  azimuth: number;
  /** Elevation of the camera above the horizontal plane, radians. */
  elevation: number;
}

export interface CityAppHandle {
  /** Render loop control. */
  start(): void;
  stop(): void;
  dispose(): void;

  /** Camera */
  resetCamera(): void;
  getCameraSettings(): CameraSettings;
  setCameraSettings(settings: Partial<CameraSettings>): void;
  /** Instantly move the camera focus to local-metre coordinates. */
  focusOnLocal(localX: number, localY: number): void;
  /** Fly to the Lipki aviation museum exhibits (city dataset only). */
  focusMuseum(): void;

  /** Rendering */
  setPixelArt(settings: Partial<PixelArtSettings>): void;
  getPixelArt(): PixelArtSettings;
  setTimeOfDay(hours: number): void;
  getTimeOfDay(): number;
  setFacadeDetail(enabled: boolean): void;
  setDebugWireframe(enabled: boolean): void;
  setPixelEffectEnabled(enabled: boolean): void;
  isPixelEffectEnabled(): boolean;

  /** Data */
  loadAreaAround(localX: number, localY: number): void;
  getStats(): EngineStats;

  /** Selection */
  clearSelection(): void;
  highlightBuilding(id: FeatureId | null): void;
}
