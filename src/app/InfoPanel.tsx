import type { BuildingSelection } from '../shared/appApi';

interface InfoPanelProps {
  selection: BuildingSelection | null;
  onClose: () => void;
}

const HEIGHT_SOURCE_LABEL: Record<string, string> = {
  osm_height: 'OSM height tag',
  osm_levels: 'OSM building:levels',
  heuristic: 'inferred (architecture heuristic)',
  default: 'default value',
};

function formatHeight(value: number | undefined): string {
  return value == null ? '—' : `${value.toFixed(1)} m`;
}

export function InfoPanel({ selection, onClose }: InfoPanelProps) {
  if (!selection) return null;
  const { feature } = selection;
  const tags = Object.entries(feature.tags)
    .filter(([key]) => key !== 'name')
    .slice(0, 24);

  return (
    <aside className="hud info-panel" data-testid="info-panel">
      <button className="close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <h2>{feature.name || 'Building'}</h2>
      <dl>
        <dt>OSM id</dt>
        <dd data-testid="info-osm-id">
          {feature.osmType[0]}
          {feature.osmId}
        </dd>
        <dt>Address</dt>
        <dd>{feature.address || '—'}</dd>
        <dt>Archetype</dt>
        <dd>{feature.archetype}</dd>
        <dt>Height</dt>
        <dd>{formatHeight(feature.height)}</dd>
        <dt>Floors</dt>
        <dd>{feature.levels ?? '—'}</dd>
        <dt>Roof shape</dt>
        <dd>{feature.roofShape}</dd>
        <dt>Volumes</dt>
        <dd>{feature.volumes.length}</dd>
        <dt>Height source</dt>
        <dd>{HEIGHT_SOURCE_LABEL[feature.volumes[0]?.heightSource ?? 'default'] ?? '—'}</dd>
      </dl>
      {tags.length > 0 && (
        <div className="tags">
          {tags.map(([key, value]) => (
            <div key={key}>
              <strong>{key}</strong> = {value}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
