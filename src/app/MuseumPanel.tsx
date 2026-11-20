/**
 * Museum exhibit card.
 *
 * Opens when the user clicks an aircraft in the Lipki exhibition. Shows a small
 * interactive 3D preview (drag to rotate, it spins slowly on its own), the
 * exhibit reference and a short description, and links to the museum website.
 *
 * The preview is the shared `ModelPreview` viewer; the main city scene never
 * lives in React (see docs/ARCHITECTURE.md).
 */

import { useMemo } from 'react';
import type { CityAppHandle, MuseumExhibitSelection } from '../shared/appApi';
import { MUSEUM_INFO, MUSEUM_SITE_PAGE, museumExhibitUrl } from './museumInfo';
import { ModelPreview } from './ModelPreview';

interface MuseumPanelProps {
  selection: MuseumExhibitSelection;
  app: CityAppHandle | null;
  onClose: () => void;
}

export function MuseumPanel({ selection, app, onClose }: MuseumPanelProps) {
  const info = MUSEUM_INFO[selection.slug];
  const preview = useMemo(
    () => (app ? app.getExhibitPreview(selection.index) : null),
    [app, selection.index],
  );

  return (
    <aside className="hud museum-card" data-testid="museum-card">
      <header>
        <div>
          <h2>{selection.ref}</h2>
          <p className="museum-subtitle">
            {info?.title ?? selection.slug}
            {info ? ` · ${info.years}` : ''}
          </p>
        </div>
        <button type="button" className="museum-close" onClick={onClose} aria-label="Закрыть карточку">
          ×
        </button>
      </header>

      <ModelPreview preview={preview} testId="museum-preview" />

      {info && <p className="museum-description">{info.description}</p>}

      <dl className="museum-facts">
        <div>
          <dt>Длина</dt>
          <dd>{selection.lengthM.toFixed(1)} м</dd>
        </div>
        <div>
          <dt>Размах</dt>
          <dd>{selection.spanM.toFixed(1)} м</dd>
        </div>
        <div>
          <dt>Курс</dt>
          <dd>{Math.round(selection.heading)}°</dd>
        </div>
        <div>
          <dt>Место</dt>
          <dd>
            {selection.x.toFixed(0)}, {selection.y.toFixed(0)} м
          </dd>
        </div>
      </dl>

      <div className="museum-links">
        <a href={museumExhibitUrl(selection.slug, selection.ref)} target="_blank" rel="noreferrer">
          Найти этот борт на сайте музея →
        </a>
        <a href={MUSEUM_SITE_PAGE} target="_blank" rel="noreferrer">
          Минский авиамузей на «Белорусском авиадневнике»
        </a>
      </div>
      <p className="museum-hint">Потяните модель, чтобы повернуть.</p>
    </aside>
  );
}
