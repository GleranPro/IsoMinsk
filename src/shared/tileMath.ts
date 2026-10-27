/**
 * Isometric Minsk — tile grid + coordinate math.
 *
 * Tile space: a square grid of TILE_SIZE_M cells aligned to the local metric
 * origin (local 0,0 is the SW corner of tile (0,0)... in local metres; local X
 * grows east, local Y grows north).
 *
 * Local metres -> tile index:  tileX = floor(localX / TILE_SIZE_M)
 *                              tileY = floor(localY / TILE_SIZE_M)
 * Tile index -> local bounds:  minX = tileX * TILE_SIZE_M ...
 *
 * Renderer world space (Three.js):
 *      worldX =  localX
 *      worldY =  height
 *      worldZ = -localY
 */

import { TILE_SIZE_M } from './config';
import type { Ring, TileAddress, TileData } from './types';

/** Local-metre point -> tile index. */
export function localToTile(x: number, y: number, tileSize: number = TILE_SIZE_M): TileAddress {
  return { x: Math.floor(x / tileSize), y: Math.floor(y / tileSize) };
}

/** Tile index -> local bounds [minX, minY, maxX, maxY]. */
export function tileBounds(
  x: number,
  y: number,
  tileSize: number = TILE_SIZE_M,
): [number, number, number, number] {
  return [x * tileSize, y * tileSize, (x + 1) * tileSize, (y + 1) * tileSize];
}

/** Tile storage key. */
export function tileKey(x: number, y: number): string {
  return `${x}_${y}`;
}

/** Local metres -> renderer world position. */
export function localToWorld(x: number, y: number, height: number): [number, number, number] {
  return [x, height, -y];
}

/** Renderer world position -> local metres. */
export function worldToLocal(wx: number, wy: number, wz: number): [number, number, number] {
  return [wx, wy, -wz];
}

/** Signed area of a ring in local metres (positive = CCW). */
export function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return a / 2;
}

/** Absolute area of a polygon (exterior minus holes). */
export function polygonArea(polygon: Ring[]): number {
  if (polygon.length === 0) return 0;
  let area = Math.abs(ringArea(polygon[0]));
  for (let i = 1; i < polygon.length; i++) area -= Math.abs(ringArea(polygon[i]));
  return area;
}

/** Axis-aligned bounds of a ring. */
export function ringBounds(ring: Ring): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** Axis-aligned bounds of a whole polygon. */
export function polygonBounds(polygon: Ring[]): [number, number, number, number] {
  if (!polygon.length) return [0, 0, 0, 0];
  return ringBounds(polygon[0]);
}

export function boundsIntersect(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

/** Squared distance in the XZ plane between world points. */
export function distanceSq2D(
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/** Tile addresses that overlap the given local-metre rectangle. */
export function tilesInRect(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  tileSize: number = TILE_SIZE_M,
): TileAddress[] {
  const out: TileAddress[] = [];
  const t0 = localToTile(minX, minY, tileSize);
  const t1 = localToTile(maxX, maxY, tileSize);
  for (let y = t0.y; y <= t1.y; y++) {
    for (let x = t0.x; x <= t1.x; x++) out.push({ x, y });
  }
  return out;
}

/** True when the tile contains the given local-metre point. */
export function tileContains(tile: TileAddress, x: number, y: number, tileSize = TILE_SIZE_M): boolean {
  const [minX, minY, maxX, maxY] = tileBounds(tile.x, tile.y, tileSize);
  return x >= minX && x < maxX && y >= minY && y < maxY;
}

/** Compact human readable id of a tile, used in tile file names. */
export function tileFileName(x: number, y: number): string {
  return `tiles/${x}_${y}.json`;
}

/** Empty tile payload, used for tiles with no rendered content. */
export function emptyTile(x: number, y: number, tileSize = TILE_SIZE_M): TileData {
  return {
    tileX: x,
    tileY: y,
    bounds: tileBounds(x, y, tileSize),
    buildings: [],
    surfaces: [],
    roads: [],
    trees: [],
  };
}
