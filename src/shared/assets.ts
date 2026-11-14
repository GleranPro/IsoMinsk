/**
 * Isometric Minsk — public asset URLs.
 *
 * The application is published below a project path on GitHub Pages
 * (`https://<owner>.github.io/VoxelMinsk/`), so static payloads must be
 * addressed relative to the deployment base rather than the host root.
 *
 * Vite exposes its configured `base` as `import.meta.env.BASE_URL`. Lazy,
 * defensive access matters because the shared config is also imported from
 * plain Node contexts (vitest, Playwright) where `import.meta.env` — and
 * therefore `BASE_URL` — may be undefined.
 */

/** Deployment base of the current runtime ('/' when it cannot be read). */
function deploymentBase(): string {
  try {
    // Vite statically replaces this expression at build time. Outside Vite the
    // access throws (or yields undefined), so the root base is the safe default.
    return import.meta.env.BASE_URL ?? '/';
  } catch {
    return '/';
  }
}

/**
 * Resolve a public asset path against the deployment base.
 *
 * - `'/'` (development and root-hosted deployments) becomes `'./'`, keeping
 *   the URL relative to the document instead of pinned to the host root.
 * - an explicit project base (`'/VoxelMinsk/'`) is preserved and receives
 *   exactly one trailing slash.
 * - leading slashes on `path` are stripped, so both `data/city-tiles` and
 *   `/data/city-tiles` resolve to the same URL.
 */
export function publicAssetUrl(path: string, configuredBase: string = deploymentBase()): string {
  const base =
    configuredBase === '' || configuredBase === '/'
      ? './'
      : configuredBase.endsWith('/')
        ? configuredBase
        : `${configuredBase}/`;
  return `${base}${path.replace(/^\/+/, '')}`;
}
