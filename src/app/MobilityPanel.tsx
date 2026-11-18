import type { MobilityVehicleSelection } from '../shared/appApi';

interface MobilityPanelProps {
  selection: MobilityVehicleSelection;
  onClose: () => void;
}

const MODE_LABEL: Record<MobilityVehicleSelection['mode'], string> = {
  bus: 'Автобус',
  trolleybus: 'Троллейбус',
  tram: 'Трамвай',
};

const PHASE_LABEL: Record<string, string> = {
  moving: 'в движении',
  braking: 'тормозит',
  dwelling: 'на остановке',
  waiting: 'ожидает отправления',
  signal: 'ожидает сигнал',
  finished: 'рейс завершён',
};

function formatDelay(seconds: number): string {
  const rounded = Math.round(seconds);
  if (Math.abs(rounded) < 10) return 'по расписанию';
  const sign = rounded > 0 ? '+' : '−';
  const total = Math.abs(rounded);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${sign}${minutes}:${String(rest).padStart(2, '0')} ${rounded > 0 ? 'опоздание' : 'рано'}`;
}

/** Card for a clicked public-transport vehicle: route, direction, next stop, delay. */
export function MobilityPanel({ selection, onClose }: MobilityPanelProps) {
  return (
    <aside className="hud info-panel mobility-panel" data-testid="mobility-panel">
      <button className="close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <h2>
        <span className="mobility-badge" data-testid="mobility-panel-ref">
          {selection.ref}
        </span>{' '}
        {MODE_LABEL[selection.mode]}
      </h2>
      <dl>
        <dt>Направление</dt>
        <dd data-testid="mobility-panel-headsign">{selection.headSign || '—'}</dd>
        <dt>Следующая остановка</dt>
        <dd data-testid="mobility-panel-next-stop">{selection.nextStopName || '—'}</dd>
        <dt>Задержка</dt>
        <dd data-testid="mobility-panel-delay">{formatDelay(selection.delayS)}</dd>
        <dt>Скорость</dt>
        <dd>{(selection.speed * 3.6).toFixed(0)} км/ч</dd>
        <dt>Состояние</dt>
        <dd>{PHASE_LABEL[selection.phase] ?? selection.phase}</dd>
        <dt>Рейс</dt>
        <dd className="mobility-trip-id">{selection.tripId}</dd>
      </dl>
    </aside>
  );
}
