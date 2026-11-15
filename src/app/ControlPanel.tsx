import { useCallback, useState } from 'react';
import type { EngineStats } from '../shared/appApi';
import type { UiState } from './App';

interface ControlPanelProps {
  ui: UiState;
  onChange: (patch: Partial<UiState>) => void;
  onReset: () => void;
  onFocusMuseum: () => void;
  onRefreshStats: () => void;
  onRotate: (direction: -1 | 1) => void;
  stats: EngineStats | null;
  disabled: boolean;
}

/** Exact localStorage key for the panel fold state. */
const COLLAPSED_STORAGE_KEY = 'minsk.hud.controlsCollapsed';

/** Phones, and coarse-pointer devices that are not desktop-wide. */
const COMPACT_QUERY = '(max-width: 820px), (pointer: coarse) and (max-width: 1100px)';

function readStoredCollapsed(): boolean | null {
  try {
    const stored = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    // Private mode / disabled storage: fall through to the media query.
  }
  return null;
}

function readInitialCollapsed(): boolean {
  const stored = readStoredCollapsed();
  if (stored !== null) return stored;
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(COMPACT_QUERY).matches;
}

export function ControlPanel({ ui, onChange, onReset, onFocusMuseum, onRefreshStats, onRotate, stats, disabled }: ControlPanelProps) {
  const [collapsed, setCollapsed] = useState(readInitialCollapsed);

  const toggle = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    // Persist only on an explicit user toggle, never on mount.
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // Remembering the choice is best-effort.
    }
  }, [collapsed]);

  return (
    <aside
      className={`hud controls${collapsed ? ' is-collapsed' : ''}`}
      data-testid="control-panel"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <h2 className="controls-title">
        <button
          type="button"
          className="controls-toggle"
          aria-expanded={!collapsed}
          aria-controls="controls-body"
          data-testid="control-panel-toggle"
          onClick={toggle}
        >
          <span>Settings</span>
          <span className="controls-chevron" aria-hidden="true">
            ▾
          </span>
        </button>
      </h2>
      <div
        className="controls-body"
        id="controls-body"
        data-testid="control-panel-body"
        inert={collapsed ? true : undefined}
      >
        <div className="controls-sections">
          <section>
            <h2>View</h2>
            <button onClick={onReset} disabled={disabled} data-testid="reset-camera">
              Reset isometric view
            </button>
            <button onClick={onFocusMuseum} disabled={disabled} data-testid="focus-museum">
              Авиамузей Липки
            </button>
            <div className="button-row">
              <button
                onClick={() => onRotate(-1)}
                disabled={disabled}
                data-testid="rotate-left"
                aria-label="Rotate view left by 45 degrees"
              >
                ↺ 45°
              </button>
              <button
                onClick={() => onRotate(1)}
                disabled={disabled}
                data-testid="rotate-right"
                aria-label="Rotate view right by 45 degrees"
              >
                ↻ 45°
              </button>
            </div>
            <label>
              <input
                type="checkbox"
                checked={ui.pixelEffect}
                disabled={disabled}
                onChange={(event) => onChange({ pixelEffect: event.target.checked })}
                data-testid="toggle-pixel"
              />
              Pixel-art mode
            </label>
            <label>
              <input
                type="checkbox"
                checked={ui.facadeDetail}
                disabled={disabled}
                onChange={(event) => onChange({ facadeDetail: event.target.checked })}
                data-testid="toggle-facades"
              />
              Facade details
            </label>
            <label>
              <input
                type="checkbox"
                checked={ui.wireframe}
                disabled={disabled}
                onChange={(event) => onChange({ wireframe: event.target.checked })}
                data-testid="toggle-wireframe"
              />
              Debug wireframe
            </label>
          </section>

          <section>
            <h2>Time of day</h2>
            <label>
              <span data-testid="time-label">{formatHours(ui.timeOfDay)}</span>
            </label>
            <input
              type="range"
              min={0}
              max={24}
              step={0.25}
              value={ui.timeOfDay}
              disabled={disabled}
              onChange={(event) => onChange({ timeOfDay: Number(event.target.value) })}
              data-testid="time-slider"
            />
          </section>

          <section>
            <h2>Performance</h2>
            <button onClick={onRefreshStats} disabled={disabled} data-testid="refresh-stats">
              Refresh stats
            </button>
            <div className="stat-grid" data-testid="stats">
              <span>FPS</span>
              <strong data-testid="stat-fps">{stats ? stats.fps.toFixed(0) : '—'}</strong>
              <span>Draw calls</span>
              <strong data-testid="stat-drawcalls">{stats?.drawCalls ?? '—'}</strong>
              <span>Triangles</span>
              <strong data-testid="stat-triangles">{stats?.triangles?.toLocaleString() ?? '—'}</strong>
              <span>Tiles loaded</span>
              <strong data-testid="stat-tiles">{stats?.loadedTiles ?? '—'}</strong>
              <span>Buildings</span>
              <strong data-testid="stat-buildings">{stats?.buildings?.toLocaleString() ?? '—'}</strong>
              <span>Render size</span>
              <strong>
                {stats ? `${stats.renderWidth}×${stats.renderHeight}` : '—'}
              </strong>
            </div>
          </section>

          <section>
            <h2>Controls</h2>
            <div className="stat-grid">
              <span>Pan</span>
              <strong>drag · WASD · 1 finger</strong>
              <span>Zoom</span>
              <strong>wheel · pinch</strong>
              <span>Rotate</span>
              <strong>Q/E · right-drag · twist</strong>
              <span>Select</span>
              <strong>click · tap</strong>
            </div>
          </section>
        </div>
      </div>
    </aside>
  );
}

function formatHours(value: number): string {
  const hours = Math.floor(value) % 24;
  const minutes = Math.round((value - Math.floor(value)) * 60) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
