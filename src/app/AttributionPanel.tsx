import type { TileManifest } from '../shared/types';

interface AttributionPanelProps {
  manifest: TileManifest | null;
}

const DEFAULT_ATTRIBUTION = [
  {
    name: 'OpenStreetMap',
    url: 'https://www.openstreetmap.org/copyright',
    licence: 'ODbL 1.0',
    note: 'Buildings, roads, landuse and trees',
  },
];

/**
 * ODbL requires visible attribution. The compact badge is always on screen;
 * the expandable panel adds the full provider/licence list and provenance note.
 */
export function AttributionPanel({ manifest }: AttributionPanelProps) {
  const entries = manifest?.attribution?.length ? manifest.attribution : DEFAULT_ATTRIBUTION;
  return (
    <div className="attribution-wrap">
      <div className="attribution-badge" data-testid="attribution-badge">
        ©{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">
          OpenStreetMap
        </a>{' '}
        contributors · ODbL 1.0 · generated{' '}
        {manifest?.generatedAt ?? '2026-10'}
      </div>
      <details className="hud attribution" data-testid="attribution-panel">
        <summary>Data sources &amp; limitations</summary>
        <ul>
          {entries.map((entry) => (
            <li key={entry.name}>
              <a href={entry.url} target="_blank" rel="noreferrer noopener">
                {entry.name}
              </a>{' '}
              — {entry.licence}
              {entry.note ? `. ${entry.note}` : ''}
            </li>
          ))}
        </ul>
        {manifest && (
          <p>
            {manifest.counts.buildings.toLocaleString()} buildings · {manifest.tiles.length} tiles ·
            projection EPSG:{manifest.epsg} · tile size {manifest.tileSize} m · origin UTM 35N{' '}
            {Math.round(manifest.originUtm[0])} / {Math.round(manifest.originUtm[1])}
          </p>
        )}
        <p>
          Heights and roof shapes are partly inferred when OpenStreetMap has no explicit values;
          some trees are procedurally placed inside mapped parks. These are estimates, not surveyed
          measurements — see docs/LIMITATIONS.md.
        </p>
      </details>
    </div>
  );
}
