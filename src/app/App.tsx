/**
 * Isometric Minsk — React UI shell.
 *
 * React owns menus, panels and the loading indicator only. It never creates
 * scene objects: the canvas is mounted once and driven through CityAppHandle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createCityApp } from '../engine/createCityApp';
import type { BuildingSelection, CityAppHandle, EngineStats, MuseumExhibitSelection } from '../shared/appApi';
import type { TileManifest } from '../shared/types';
import { resolveManifestUrl } from '../shared/config';
import { MUSEUM } from '../shared/museum';
import { InfoPanel } from './InfoPanel';
import { MuseumPanel } from './MuseumPanel';
import { ControlPanel } from './ControlPanel';
import { AttributionPanel } from './AttributionPanel';
import { LoadingOverlay } from './LoadingOverlay';

export interface UiState {
  pixelEffect: boolean;
  facadeDetail: boolean;
  wireframe: boolean;
  timeOfDay: number;
  orthoHeight: number;
  azimuth: number;
  azimuthMode: 'iso' | 'north' | 'free';
}

const DEFAULT_UI: UiState = {
  pixelEffect: true,
  facadeDetail: true,
  wireframe: false,
  timeOfDay: 13,
  orthoHeight: 420,
  azimuth: Math.PI / 4,
  azimuthMode: 'iso',
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
  const [ui, setUi] = useState<UiState>(DEFAULT_UI);
  const [manifest, setManifest] = useState<TileManifest | null>(null);

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
        setUi((prev) => ({ ...prev, orthoHeight: camera.orthoHeight, azimuth: camera.azimuth }));
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
        if (next) setExhibit(null);
      },
      onExhibitSelect: (next) => setExhibit(next),
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
    app.setTimeOfDay(ui.timeOfDay);
  }, [ready, ui.pixelEffect, ui.facadeDetail, ui.wireframe, ui.timeOfDay]);

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
        stats={stats}
        disabled={!ready}
      />

      <InfoPanel selection={selection} onClose={() => appRef.current?.clearSelection()} />

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

      <AttributionPanel manifest={manifest} />

      <LoadingOverlay visible={loading} progress={progress} error={error} />
    </div>
  );
}
