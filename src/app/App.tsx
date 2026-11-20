/**
 * Isometric Minsk — React UI shell.
 *
 * React owns menus, panels and the loading indicator only. It never creates
 * scene objects: the canvas is mounted once and driven through CityAppHandle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createCityApp } from '../engine/createCityApp';
import type {
  BuildingSelection,
  CityAppHandle,
  EngineStats,
  LandmarkSelection,
  MobilityVehicleSelection,
  MuseumExhibitSelection,
  SeasonOverride,
  TimeOfDayMode,
  WeatherKind,
} from '../shared/appApi';
import type { MobilityStatus } from '../shared/mobility';
import type { TileManifest } from '../shared/types';
import { resolveManifestUrl } from '../shared/config';
import { MUSEUM } from '../shared/museum';
import { InfoPanel } from './InfoPanel';
import { MobilityPanel } from './MobilityPanel';
import { MuseumPanel } from './MuseumPanel';
import { LandmarkPanel } from './LandmarkPanel';
import { ControlPanel } from './ControlPanel';
import { AttributionPanel } from './AttributionPanel';
import { LoadingOverlay } from './LoadingOverlay';

export interface UiState {
  pixelEffect: boolean;
  facadeDetail: boolean;
  wireframe: boolean;
  /** Lighting clock source: live Minsk time or the fixed slider value. */
  timeMode: TimeOfDayMode;
  timeOfDay: number;
  /** Cloud shades (drifting shadow fields) on/off. */
  clouds: boolean;
  /** Screen-space precipitation. */
  weather: WeatherKind;
  /** Season: auto follows the real calendar date. */
  season: SeasonOverride;
  orthoHeight: number;
  azimuth: number;
  azimuthMode: 'iso' | 'north' | 'free';
  /** Mobility: show vehicles (rules keep running while hidden). */
  mobilityVehicles: boolean;
  /** Mobility: show signal heads (rules keep running while hidden). */
  mobilitySignals: boolean;
  /** Mobility: pause the simulation clock. */
  mobilityPaused: boolean;
}

const DEFAULT_UI: UiState = {
  pixelEffect: true,
  facadeDetail: true,
  wireframe: false,
  timeMode: 'auto',
  timeOfDay: 13,
  clouds: true,
  weather: 'off',
  season: 'auto',
  orthoHeight: 420,
  azimuth: Math.PI / 4,
  azimuthMode: 'iso',
  mobilityVehicles: true,
  mobilitySignals: true,
  mobilityPaused: false,
};

export function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<CityAppHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [selection, setSelection] = useState<BuildingSelection | null>(null);
  const [exhibit, setExhibit] = useState<MuseumExhibitSelection | null>(null);
  const [landmark, setLandmark] = useState<LandmarkSelection | null>(null);
  const [vehicle, setVehicle] = useState<MobilityVehicleSelection | null>(null);
  const [ui, setUi] = useState<UiState>(DEFAULT_UI);
  const [manifest, setManifest] = useState<TileManifest | null>(null);
  const [mobilityStatus, setMobilityStatus] = useState<MobilityStatus | null>(null);

  // engine lifecycle
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const app = createCityApp({
      container,
      onReady: () => {
        setReady(true);
        const exposed = (window as unknown as Record<string, unknown>).__CITY_APP__ as
          | Record<string, unknown>
          | undefined;
        if (exposed) exposed.ready = true;
        else (window as unknown as Record<string, unknown>).__CITY_APP__ = { ready: true };
        const camera = app.getCameraSettings();
        const timeInfo = app.getTimeOfDayInfo();
        setUi((prev) => ({
          ...prev,
          orthoHeight: camera.orthoHeight,
          azimuth: camera.azimuth,
          timeMode: timeInfo.mode,
          timeOfDay: timeInfo.hours,
          clouds: app.getCloudsEnabled(),
          weather: app.getWeather().kind,
          season: app.getSeason(),
        }));
      },
      onStats: (next) => {
        // The engine mutates one stats object and re-emits the same reference;
        // React bails out on identical references, so copy before storing.
        const snapshot = { ...next };
        setStats(snapshot);
        const exposed = (window as unknown as Record<string, unknown>).__CITY_APP__ as
          | Record<string, unknown>
          | undefined;
        if (exposed) exposed.stats = snapshot;
        (window as unknown as Record<string, unknown>).__CITY_STATS__ = snapshot;
      },
      onSelection: (next) => {
        setSelection(next);
        if (next) {
          setExhibit(null);
          setVehicle(null);
        }
      },
      onMobilitySelect: (next) => setVehicle(next),
      onExhibitSelect: (next) => setExhibit(next),
      onLandmarkSelect: (next) => setLandmark(next),
      onLoadingChange: (isLoading, value) => {
        setLoading(isLoading);
        setProgress(value);
      },
      onError: (message) => setError(message),
    });
    appRef.current = app;
    // Debug/testing handle: Playwright and the Lead's QA depend on this. The
    // engine may already have published its own debug surface on the same
    // global — merge instead of overwriting it.
    const existing = (window as unknown as Record<string, unknown>).__CITY_APP__ as
      | Record<string, unknown>
      | undefined;
    (window as unknown as Record<string, unknown>).__CITY_APP__ = {
      ...(existing ?? {}),
      ready: false,
      app,
      stats: null,
    };
    app.start();
    fetch(resolveManifestUrl(), { cache: 'no-cache' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setManifest(data as TileManifest | null))
      .catch(() => setManifest(null));
    return () => {
      app.dispose();
      appRef.current = null;
    };
  }, []);

  // keep UI state in sync with engine
  useEffect(() => {
    const app = appRef.current;
    if (!app || !ready) return;
    app.setPixelEffectEnabled(ui.pixelEffect);
    app.setFacadeDetail(ui.facadeDetail);
    app.setDebugWireframe(ui.wireframe);
    if (ui.timeMode === 'manual') app.setTimeOfDay(ui.timeOfDay);
    else app.setTimeMode('auto');
    app.setCloudsEnabled(ui.clouds);
    app.setWeather(ui.weather);
    app.setSeason(ui.season);
  }, [
    ready,
    ui.pixelEffect,
    ui.facadeDetail,
    ui.wireframe,
    ui.timeMode,
    ui.timeOfDay,
    ui.clouds,
    ui.weather,
    ui.season,
  ]);

  // Live clock mirror: while the lighting runs on real Minsk time, the panel
  // label follows the engine clock (1 Hz is enough — the look drifts 1 h/h).
  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => {
      const app = appRef.current;
      if (!app) return;
      const info = app.getTimeOfDayInfo();
      setUi((prev) =>
        prev.timeMode === info.mode && Math.abs(prev.timeOfDay - info.hours) < 0.005
          ? prev
          : { ...prev, timeMode: info.mode, timeOfDay: info.hours },
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, [ready]);

  // mobility switches go through the public handle; the engine keeps the rules
  // running even when vehicles/signals are hidden.
  useEffect(() => {
    const app = appRef.current;
    if (!app || !ready) return;
    app.setMobilitySettings({
      vehiclesVisible: ui.mobilityVehicles,
      signalsVisible: ui.mobilitySignals,
      paused: ui.mobilityPaused,
    });
  }, [ready, ui.mobilityVehicles, ui.mobilitySignals, ui.mobilityPaused]);

  // Clock/data status is polled at 1 Hz: it carries the service date and the
  // simulation counters, which are not part of the renderer stats.
  useEffect(() => {
    if (!ready) return;
    const update = () => {
      const app = appRef.current;
      if (!app) return;
      const next = app.getMobilityStatus();
      setMobilityStatus((prev) =>
        prev &&
        prev.state === next.state &&
        prev.serviceDate === next.serviceDate &&
        Math.floor(prev.serviceSeconds) === Math.floor(next.serviceSeconds) &&
        prev.activeTrips === next.activeTrips &&
        prev.drawnTrips === next.drawnTrips &&
        prev.loadedChunks === next.loadedChunks &&
        prev.notes.length === next.notes.length
          ? prev
          : next,
      );
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [ready]);

  const resetCamera = useCallback(() => {
    appRef.current?.resetCamera();
    const camera = appRef.current?.getCameraSettings();
    if (camera) {
      setUi((prev) => ({
        ...prev,
        orthoHeight: camera.orthoHeight,
        azimuth: camera.azimuth,
        azimuthMode: 'iso',
      }));
    }
  }, []);

  const focusMuseum = useCallback(() => {
    const app = appRef.current;
    if (!app) return;
    // The complete city always covers Lipki (x ≈ 9.3 km east of the pilot
    // centre): focus in the same document, never reload or switch datasets.
    app.focusMuseum();
    setUi((prev) => ({ ...prev, orthoHeight: MUSEUM.orthoHeight }));
  }, []);

  const rotateCamera = useCallback((direction: -1 | 1) => {
    const app = appRef.current;
    if (!app) return;
    const { azimuth } = app.getCameraSettings();
    app.setCameraSettings({ azimuth: azimuth + (direction * Math.PI) / 4 });
  }, []);

  const snapshotStats = useCallback(() => {
    const next = appRef.current?.getStats();
    if (next) setStats(next);
  }, []);

  return (
    <div className="app-root">
      <div className="canvas-container" ref={containerRef} data-testid="city-canvas-container" />

      <header className="hud hud-topleft">
        <h1>Isometric Minsk</h1>
        <p className="subtitle" data-testid="app-subtitle">
          pixel-art 3D map · whole city of Minsk · OSM data
        </p>
        {manifest && (
          <p className="data-note" data-testid="data-note">
            {(manifest.counts.buildings ?? 0).toLocaleString()} buildings ·{' '}
            {manifest.tiles.length} tiles · {manifest.tileSize} m grid · complete city
          </p>
        )}
      </header>

      <ControlPanel
        ui={ui}
        onChange={(patch) => setUi((prev) => ({ ...prev, ...patch }))}
        onReset={resetCamera}
        onFocusMuseum={focusMuseum}
        onRefreshStats={snapshotStats}
        onRotate={rotateCamera}
        stats={stats}
        mobilityStatus={mobilityStatus}
        disabled={!ready}
      />

      <InfoPanel selection={selection} onClose={() => appRef.current?.clearSelection()} />

      {vehicle && (
        <MobilityPanel
          selection={vehicle}
          onClose={() => {
            appRef.current?.clearMobilitySelection();
            setVehicle(null);
          }}
        />
      )}

      {exhibit && (
        <MuseumPanel
          selection={exhibit}
          app={appRef.current}
          onClose={() => {
            appRef.current?.clearExhibit();
            setExhibit(null);
          }}
        />
      )}

      {landmark && (
        <LandmarkPanel
          selection={landmark}
          app={appRef.current}
          onClose={() => {
            appRef.current?.clearLandmark();
            setLandmark(null);
          }}
        />
      )}

      <AttributionPanel manifest={manifest} />

      <LoadingOverlay visible={loading} progress={progress} error={error} />
    </div>
  );
}
