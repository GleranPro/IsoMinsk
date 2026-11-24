/**
 * Isometric Minsk — public contract between the React UI shell (`src/app`) and
 * the imperative Three.js engine (`src/engine`).
 *
 * React never creates scene objects. It mounts a single canvas container and
 * talks to the engine exclusively through `CityAppHandle`.
 */

import type { BuildingFeature, FeatureId } from './types';
import type { MobilityDebugDump, MobilitySettings, MobilityStatus } from './mobility';

export interface BuildingSelection {
  id: FeatureId;
  feature: BuildingFeature;
  /** Screen-space pixel coordinates of the picked point, for the tooltip. */
  screenX: number;
  screenY: number;
}

/** A Lipki museum exhibit picked in the 3D scene. */
export interface MuseumExhibitSelection {
  /** Index inside the museum payload. */
  index: number;
  slug: string;
  ref: string;
  /** Local metres (x east, y north). */
  x: number;
  y: number;
  heading: number;
  lengthM: number;
  spanM: number;
  /** Screen-space pixel coordinates of the click, for the card anchor. */
  screenX: number;
  screenY: number;
}

/** Geometry of one exhibit, centred and ready for the card's 3D preview. */
export interface MuseumExhibitPreview {
  positions: Float32Array;
  colors: Float32Array;
  lengthM: number;
  spanM: number;
}

/** A landmark model (Red Church, National Library, …) picked in the 3D scene. */
export interface LandmarkSelection {
  slug: string;
  /** Localised name from the baked payload. */
  label: string;
  /** OSM object the model is named after (`w123` / `n123`). */
  osm: string;
  /** Local metres of the model anchor (x east, y north). */
  x: number;
  y: number;
  /** Footprint centre in local metres — camera focus for the card. */
  centreX: number;
  centreY: number;
  heightM: number;
  /** Footprint extent [minEast, minNorth, maxEast, maxNorth] around the anchor. */
  extent: [number, number, number, number];
  triangles: number;
  /** Screen-space pixel coordinates of the click, for the card anchor. */
  screenX: number;
  screenY: number;
}

/** Geometry of one landmark, centred and ready for the card's 3D preview. */
export interface LandmarkPreview {
  positions: Float32Array;
  colors: Float32Array;
}

/** A public-transport vehicle picked on the map. */
export interface MobilityVehicleSelection {
  tripId: string;
  /** Public route number as shown to passengers ("39", "9"). */
  ref: string;
  mode: 'bus' | 'trolleybus' | 'tram';
  /** Destination / headsign text of this direction. */
  headSign: string;
  /** Name of the next stop on the trip (empty when unavailable). */
  nextStopName: string;
  /** Schedule delay in seconds (positive = late). */
  delayS: number;
  /** Current speed, m/s. */
  speed: number;
  /** Trip phase shown to the user ("moving" | "dwelling" | …). */
  phase: string;
  /** Screen-space anchor for the card. */
  screenX: number;
  screenY: number;
}

/** Atmosphere state reported with the stats (honesty contract). */
export interface AtmosphereStats {
  /** Lighting clock mode (live Minsk time or manual). */
  timeMode: TimeOfDayMode;
  /** Active season (override resolved to a concrete season). */
  season: 'spring' | 'summer' | 'autumn';
  /** Cloud-shade strength 0..1 (0 when disabled). */
  clouds: number;
  /** Current precipitation. */
  weather: WeatherKind;
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
  /**
   * Mobility layer counters (active/drawn trips, chunks, simulation cost).
   * Absent when the mobility layer is disabled or failed to load: the existing
   * city counters alone do not cover the dynamic layer.
   */
  mobility?: MobilityStatus;
  /** Atmosphere state (time clock, season, clouds, weather, lamps). */
  atmosphere?: AtmosphereStats;
}

export interface CityAppOptions {
  container: HTMLElement;
  /** Called when the renderer is ready to accept input. */
  onReady?: () => void;
  /** Called every ~500 ms with fresh performance numbers. */
  onStats?: (stats: EngineStats) => void;
  /** Called when a building pick completes (or is cleared with null). */
  onSelection?: (selection: BuildingSelection | null) => void;
  /** Called when a museum exhibit is clicked (or the selection is cleared). */
  onExhibitSelect?: (selection: MuseumExhibitSelection | null) => void;
  /** Called when a landmark model is clicked (or the selection is cleared). */
  onLandmarkSelect?: (selection: LandmarkSelection | null) => void;
  /**
   * Display titles for the landmark pins, keyed by slug (the card titles, so
   * the hover tooltip and the card never disagree). Slugs without an entry
   * fall back to the baked model label.
   */
  landmarkTitles?: Record<string, string>;
  /** Called when a vehicle is clicked (or the selection is cleared). */
  onMobilitySelect?: (selection: MobilityVehicleSelection | null) => void;
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

/** Where the lighting clock comes from. */
export type TimeOfDayMode = 'auto' | 'manual';

export interface TimeOfDayInfo {
  /** Lighting clock hours (0..24, fractional). */
  hours: number;
  /** `auto` = real Minsk time, `manual` = fixed slider / `?time=H` value. */
  mode: TimeOfDayMode;
}

/** Screen-space precipitation kinds. */
export type WeatherKind = 'off' | 'rain' | 'snow';

/** Season override: `auto` follows the real calendar date. */
export type SeasonOverride = 'auto' | 'spring' | 'summer' | 'autumn';

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
  /** Pin the lighting clock to a fixed hour (switches to manual mode). */
  setTimeOfDay(hours: number): void;
  getTimeOfDay(): number;
  /** Switch the lighting clock between live Minsk time and manual mode. */
  setTimeMode(mode: TimeOfDayMode): void;
  getTimeOfDayInfo(): TimeOfDayInfo;
  /** Atmosphere: cloud shades (drifting shadow fields), weather, season. */
  setCloudsEnabled(enabled: boolean): void;
  getCloudsEnabled(): boolean;
  setWeather(kind: WeatherKind, amount?: number): void;
  getWeather(): { kind: WeatherKind; amount: number };
  setSeason(season: SeasonOverride): void;
  getSeason(): SeasonOverride;
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
  /** Museum card data: centred geometry of one exhibit (null until loaded). */
  getExhibitPreview(index: number): MuseumExhibitPreview | null;
  /** Clear the museum exhibit selection (card closes). */
  clearExhibit(): void;
  /** Landmark card data: centred geometry of one model (null until loaded). */
  getLandmarkPreview(slug: string): LandmarkPreview | null;
  /** Clear the landmark selection highlight (the card closes in the shell). */
  clearLandmark(): void;

  /* --- Mobility layer (public transport + traffic signals) --------------- */

  /**
   * Layer switches. Hiding vehicles or signal heads never stops the rules:
   * the simulation clock and the signal controller keep running.
   */
  setMobilitySettings(settings: Partial<MobilitySettings>): void;
  getMobilitySettings(): MobilitySettings;
  /**
   * Clock/data status for the control panel. Always available (an unavailable
   * payload reports `state: 'unavailable'` instead of throwing).
   */
  getMobilityStatus(): MobilityStatus;
  /**
   * QA snapshot of the deterministic simulation (clock, trips, signal state).
   * Returns null until the mobility payload has loaded.
   */
  getMobilityDump(): MobilityDebugDump | null;
  /**
   * QA hook: pin the service date the schedule is resolved for (`null` returns
   * to the live clock). Changing it re-initialises trips explicitly.
   * `secondsOfDay` pins the local time of day (default 08:00); it exists so QA
   * can frame a specific vehicle deterministically instead of waiting for it.
   */
  setMobilityServiceDate(date: string | null, secondsOfDay?: number): void;
  /** Clear the vehicle selection highlight (the card closes in the shell). */
  clearMobilitySelection(): void;
}
