import { useCallback, useState } from 'react';
import type { EngineStats, SeasonOverride, WeatherKind } from '../shared/appApi';
import type { MobilityStatus } from '../shared/mobility';
import type { UiState } from './App';

interface ControlPanelProps {
  ui: UiState;
  onChange: (patch: Partial<UiState>) => void;
  onReset: () => void;
  onFocusMuseum: () => void;
  onRefreshStats: () => void;
  onRotate: (direction: -1 | 1) => void;
  stats: EngineStats | null;
  mobilityStatus: MobilityStatus | null;
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

export function ControlPanel({ ui, onChange, onReset, onFocusMuseum, onRefreshStats, onRotate, stats, mobilityStatus, disabled }: ControlPanelProps) {
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
              <input
                type="checkbox"
                checked={ui.timeMode === 'auto'}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ timeMode: event.target.checked ? 'auto' : 'manual' })
                }
                data-testid="toggle-live-time"
              />
              Live Minsk time
            </label>
            <label>
              <span data-testid="time-label">{formatHours(ui.timeOfDay)}</span>
            </label>
            <input
              type="range"
              min={0}
              max={24}
              step={0.25}
              value={ui.timeOfDay}
              disabled={disabled || ui.timeMode === 'auto'}
              onChange={(event) =>
                onChange({ timeMode: 'manual', timeOfDay: Number(event.target.value) })
              }
              data-testid="time-slider"
            />
          </section>

          <section>
            <h2>Atmosphere</h2>
            <label>
              <input
                type="checkbox"
                checked={ui.clouds}
                disabled={disabled}
                onChange={(event) => onChange({ clouds: event.target.checked })}
                data-testid="toggle-clouds"
              />
              Cloud shades
            </label>
            <label>
              <span>Weather</span>
              <select
                value={ui.weather}
                disabled={disabled}
                onChange={(event) => onChange({ weather: event.target.value as WeatherKind })}
                data-testid="select-weather"
              >
                <option value="off">Clear</option>
                <option value="rain">Rain</option>
                <option value="snow">Snow</option>
              </select>
            </label>
            <label>
              <span>Season</span>
              <select
                value={ui.season}
                disabled={disabled}
                onChange={(event) => onChange({ season: event.target.value as SeasonOverride })}
                data-testid="select-season"
              >
                <option value="auto">Auto (real date)</option>
                <option value="spring">Spring</option>
                <option value="summer">Summer</option>
                <option value="autumn">Autumn</option>
              </select>
            </label>
          </section>

          <section>
            <h2>Transport</h2>
            <label>
              <input
                type="checkbox"
                checked={ui.mobilityVehicles}
                disabled={disabled}
                onChange={(event) => onChange({ mobilityVehicles: event.target.checked })}
                data-testid="toggle-mobility-vehicles"
              />
              Vehicles
            </label>
            <label>
              <input
                type="checkbox"
                checked={ui.mobilitySignals}
                disabled={disabled}
                onChange={(event) => onChange({ mobilitySignals: event.target.checked })}
                data-testid="toggle-mobility-signals"
              />
              Traffic signals
            </label>
            <label>
              <input
                type="checkbox"
                checked={ui.mobilityPaused}
                disabled={disabled}
                onChange={(event) => onChange({ mobilityPaused: event.target.checked })}
                data-testid="toggle-mobility-pause"
              />
              Pause simulation
            </label>
            <p className="mobility-note" data-testid="mobility-state">
              {mobilityStatus
                ? `${mobilityStateLabel(mobilityStatus.state)}${scheduleSuffix(mobilityStatus.scheduleStatus)} · ${formatServiceClock(mobilityStatus)}`
                : '—'}
            </p>
            {mobilityStatus && mobilityStatus.notes.length > 0 && (
              <p className="mobility-note" data-testid="mobility-notes" title={mobilityStatus.notes.join('\n')}>
                {mobilityStatus.notes[0]}
              </p>
            )}
            <div className="stat-grid" data-testid="mobility-stats">
              <span>Trips active</span>
              <strong data-testid="mobility-active-trips">{mobilityStatus?.activeTrips ?? '—'}</strong>
              <span>Trips drawn</span>
              <strong data-testid="mobility-drawn-trips">{mobilityStatus?.drawnTrips ?? '—'}</strong>
              <span>Scheduled today</span>
              <strong>{mobilityStatus?.scheduledTrips ?? '—'}</strong>
              <span>Delayed / blocked</span>
              <strong>{mobilityStatus ? `${mobilityStatus.blockedTrips}` : '—'}</strong>
              <span>Chunks / bytes</span>
              <strong>
                {mobilityStatus
                  ? `${mobilityStatus.loadedChunks} · ${formatBytes(mobilityStatus.loadedBytes)}`
                  : '—'}
              </strong>
              <span>Signals</span>
              <strong>
                {mobilityStatus
                  ? `${mobilityStatus.signalNodesDrawn}/${mobilityStatus.signalNodes}`
                  : '—'}
              </strong>
              <span>Simulation</span>
              <strong>
                {mobilityStatus ? `${mobilityStatus.simulationMs.toFixed(2)} ms` : '—'}
              </strong>
            </div>
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

/** Local (service time zone) date + seconds after service-day start. */
function formatServiceClock(status: MobilityStatus): string {
  if (!status.serviceDate) return 'no schedule';
  const total = Math.max(0, Math.floor(status.serviceSeconds));
  const hours = Math.floor(total / 3600) % 24;
  const minutes = Math.floor(total / 60) % 60;
  const clock = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  const suffix = status.fixedDate ? ' (QA)' : '';
  return `${status.serviceDate} ${clock}${suffix}`;
}

function mobilityStateLabel(state: MobilityStatus['state']): string {
  switch (state) {
    case 'ready':
      return 'Running';
    case 'loading':
      return 'Loading';
    case 'partial':
      return 'Partial data';
    case 'error':
      return 'Data error';
    case 'unavailable':
      return 'Schedule unavailable';
    default:
      return 'No data';
  }
}

/**
 * Timetable provenance next to the state: a synthetic timetable is never
 * presented as the operator's public schedule.
 */
function scheduleSuffix(status: MobilityStatus['scheduleStatus']): string {
  switch (status) {
    case 'ready':
      return ' · public schedule';
    case 'partial':
      return ' · partial schedule';
    case 'synthetic':
      return ' · demo timetable (not public)';
    case 'unavailable':
      return ' · no public schedule';
    default:
      return ' · no timetable';
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
