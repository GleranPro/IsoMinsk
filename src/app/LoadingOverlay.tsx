interface LoadingOverlayProps {
  visible: boolean;
  progress: number;
  error: string | null;
}

export function LoadingOverlay({ visible, progress, error }: LoadingOverlayProps) {
  return (
    <div className={`loading-overlay${visible && !error ? '' : ' hidden'}`} data-testid="loading-overlay">
      <div className="loading-title">Isometric Minsk</div>
      <div className="loading-bar">
        <span style={{ width: `${Math.round(Math.min(Math.max(progress, 0), 1) * 100)}%` }} />
      </div>
      <div style={{ color: '#9fb0bd', fontSize: 12 }}>
        loading central Minsk tiles… {Math.round(Math.min(Math.max(progress, 0), 1) * 100)}%
      </div>
      {error && (
        <div className="loading-error" data-testid="error-message">
          {error}
        </div>
      )}
    </div>
  );
}
