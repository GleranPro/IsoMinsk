/**
 * Isometric Minsk — React UI shell.
 *
 * React owns menus, panels and the loading indicator only. It never creates
 * scene objects: the canvas is mounted once and driven through CityAppHandle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createCityApp } from '../engine/createCityApp';
import type { BuildingSelection, CityAppHandle, EngineStats } from '../shared/appApi';
import type { TileManifest } from '../shared/types';
import { InfoPanel } from './InfoPanel';
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
        setStats(next);
        const exposed = (window as unknown as Record<string, unknown>).__CITY_APP__ as
          | Record<string, unknown>
          | undefined;
        if (exposed) exposed.stats = next;
        (window as unknown as Record<string, unknown>).__CITY_STATS__ = next;
      },
      onSelection: (next) => setSelection(next),
      onLoadingChange: (isLoading, value) => {
        setLoading(isLoading);
        setProgress(value);
      },
      onError: (message) => setError(message),
    });
    appRef.current = app;
    // Debug/testing handle: Playwright and the Lead's QA depend on this.
    (window as unknown as Record<string, unknown>).__CITY_APP__ = {
      ready: false,
      app,
      stats: null,
    };
    app.start();
    fetch('/data/tiles/manifest.json')
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

  const snapshotStats = useCallback(() => {
    const next = appRef.current?.getStats();
    if (next) setStats(next);
  }, []);

  return (
    <div className="app-root">
      <div className="canvas-container" ref={containerRef} data-testid="city-canvas-container" />

      <header className="hud hud-topleft">
        <h1>Isometric Minsk</h1>
        <p className="subtitle">pixel-art 3D map · central district · OSM data</p>
        {manifest && (
          <p className="data-note">
            {(manifest.counts.buildings ?? 0).toLocaleString()} buildings ·{' '}
            {manifest.tiles.length} tiles
          </p>
        )}
      </header>

      <ControlPanel
        ui={ui}
        onChange={(patch) => setUi((prev) => ({ ...prev, ...patch }))}
        onReset={resetCamera}
        onRefreshStats={snapshotStats}
        stats={stats}
        disabled={!ready}
      />

      <InfoPanel selection={selection} onClose={() => appRef.current?.clearSelection()} />

      <AttributionPanel manifest={manifest} />

      <LoadingOverlay visible={loading} progress={progress} error={error} />
    </div>
  );
}
