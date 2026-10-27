/**
 * Deterministic per-building seeds.
 *
 * Window rhythms, facade colours and roof colours must be stable across page
 * reloads and independent of iteration order, so they are derived from the
 * stable OSM feature id with an FNV-1a hash instead of Math.random().
 */

/** FNV-1a 32-bit string hash (unsigned). */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable seed in [0, 1) derived from a feature id. */
export function seedFromId(id: string): number {
  return hashString(id) / 4294967296;
}

/** Stable pseudo-random value in [0, 1) derived from a seed plus a salt. */
export function noiseFromSeed(seed: number, salt: number): number {
  const value = Math.sin(seed * 127.1 + salt * 311.7) * 43758.5453123;
  return value - Math.floor(value);
}
