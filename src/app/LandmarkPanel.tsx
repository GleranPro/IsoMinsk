/**
 * Landmark card.
 *
 * Opens when the user clicks a landmark model (Red Church, National Library,
 * Minsk Arena, …) or follows an `?info=<slug>` deep link. Mirrors the Warsaw
 * reference: title, kind, description, facts and a link, plus the same
 * interactive 3D preview the museum card uses.
 */

import { useMemo } from 'react';
import type { CityAppHandle, LandmarkSelection } from '../shared/appApi';
import { LANDMARK_INFO, osmObjectUrl } from './landmarkInfo';
import { ModelPreview } from './ModelPreview';

interface LandmarkPanelProps {
  selection: LandmarkSelection;
  app: CityAppHandle | null;
  onClose: () => void;
}

export function LandmarkPanel({ selection, app, onClose }: LandmarkPanelProps) {
  const info = LANDMARK_INFO[selection.slug];
  const preview = useMemo(
    () => (app ? app.getLandmarkPreview(selection.slug) : null),
    [app, selection.slug],
  );
  const [minE, minN, maxE, maxN] = selection.extent;
  const footprintW = Math.max(0, maxE - minE);
  const footprintD = Math.max(0, maxN - minN);

  return (
    <aside className="hud landmark-card" data-testid="landmark-card">
      <header>
        <div>
          <h2>{info?.title ?? selection.label}</h2>
          <p className="landmark-subtitle">
            {info ? info.kind : 'лендмарк'}
            {info?.years ? ` · ${info.years}` : ''}
          </p>
        </div>
        <button
          type="button"
          className="landmark-close"
          onClick={onClose}
          aria-label="Закрыть карточку"
        >
          ×
        </button>
      </header>

      <ModelPreview preview={preview} testId="landmark-preview" />

      {info && <p className="landmark-description">{info.description}</p>}
      {info?.detail && <p className="landmark-detail">{info.detail}</p>}

      <dl className="landmark-facts">
        <div>
          <dt>Высота</dt>
          <dd>{selection.heightM.toFixed(1)} м</dd>
        </div>
        <div>
          <dt>Габариты</dt>
          <dd>
            {footprintW.toFixed(0)} × {footprintD.toFixed(0)} м
          </dd>
        </div>
        <div>
          <dt>Модель</dt>
          <dd>{selection.triangles.toLocaleString('ru-RU')} тр.</dd>
        </div>
        <div>
          <dt>OSM</dt>
          <dd>{selection.osm}</dd>
        </div>
      </dl>

      <div className="landmark-links">
        {info && (
          <a href={info.wiki} target="_blank" rel="noreferrer">
            Статья в Википедии →
          </a>
        )}
        <a href={osmObjectUrl(selection.osm)} target="_blank" rel="noreferrer">
          Объект на OpenStreetMap →
        </a>
      </div>
      <p className="landmark-hint">Потяните модель, чтобы повернуть.</p>
    </aside>
  );
}
