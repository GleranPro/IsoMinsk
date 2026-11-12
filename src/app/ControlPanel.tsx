import type { EngineStats } from '../shared/appApi';
import type { UiState } from './App';

interface ControlPanelProps {
  ui: UiState;
  onChange: (patch: Partial<UiState>) => void;
  onReset: () => void;
  onFocusMuseum: () => void;
  onRefreshStats: () => void;
  stats: EngineStats | null;
  disabled: boolean;
}

export function ControlPanel({ ui, onChange, onReset, onFocusMuseum, onRefreshStats, stats, disabled }: ControlPanelProps) {
  return (
    <aside className="hud controls" data-testid="control-panel">
      <section>
        <h2>View</h2>
        <button onClick={onReset} disabled={disabled} data-testid="reset-camera">
          Reset isometric view
        </button>
        <button onClick={onFocusMuseum} disabled={disabled} data-testid="focus-museum">
          Авиамузей Липки
        </button>
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
          <strong>drag / WASD</strong>
          <span>Zoom</span>
          <strong>wheel</strong>
          <span>Rotate</span>
          <strong>Q / E / right-drag</strong>
          <span>Select</span>
          <strong>left click</strong>
        </div>
      </section>
    </aside>
  );
}

function formatHours(value: number): string {
  const hours = Math.floor(value) % 24;
  const minutes = Math.round((value - Math.floor(value)) * 60) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
