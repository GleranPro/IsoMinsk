/**
 * Bridge decks (payload 0.4.2): raised 3D slabs textured by the ground compositor.
 *
 * The pipeline (`scripts/normalize/bridge_decks.py`) ships every deck chunk with
 * its top triangles (height baked in: 0 at the ends, the span height in the
 * middle, smoothstep ramps), its outline rings with per-vertex heights and edge
 * kinds, and the bridge strokes it carries. Here:
 *
 *  - `rasterizeDecks` paints every deck of a tile into one small atlas with the
 *    very same compositor as the ground (`paintGround` + crisp overlays) on a
 *    transparent canvas over a paving-coloured underlay — so a bridge carries
 *    exactly the asphalt, kerbs, pavements and lane paint of its street. Each
 *    deck's texel grid is anchored to world coordinates like the ground's, so
 *    the deck end meets the street texel-for-texel;
 *  - `buildDeckTopGeometry` turns the triangles into a textured mesh (world
 *    UVs into the atlas);
 *  - `emitDeckSides` adds the vertex-coloured structure to the environment
 *    sink: a concrete fascia under every side edge (deck thickness, down to the
 *    ground where the deck is low — the abutment), a parapet on top of it, and
 *    nothing on end edges (the deck runs into the street) or chunk cuts.
 *
 * Under the span the fascia stops `DECK_SLAB_M` below the deck, so the river or
 * the road underneath stays visible, darkened by the painted deck shadow.
 */

import * as THREE from 'three';
import { GROUND_LAYER_Y } from '../../shared/config';
import type { GroundDeck, GroundDeckRing, TileData } from '../../shared/types';
import type { GeometrySink, Vec3 } from '../environment/meshBuilder';
import {
  GROUND_COLORS,
  MARKINGS_MAX_RES_M,
  groundRasterAvailable,
  paintCrispOverlays,
  paintGround,
  paintRailHeads,
  type GroundContext2D,
} from './groundRaster';

/** Deck top height offset above the ground plane (clears the ground quad). */
export const DECK_BASE_Y = GROUND_LAYER_Y.markings + 0.04;
/** Structural thickness of the deck slab under the span, metres. */
export const DECK_SLAB_M = 1.1;
/** Parapet height above the deck and its thickness, metres. */
export const PARAPET_HEIGHT_M = 1.1;
export const PARAPET_THICKNESS_M = 0.45;

export const DECK_COLORS = {
  /** Deck surface outside the strokes (between carriageway and footway). */
  surface: GROUND_COLORS.sidewalk,
  // Light concrete: the bright outline is what makes a bridge read as one.
  // (vertex colours are linearised twice by the environment material, so
  // these are brighter than the matching texture colours.)
  fascia: '#cbc5b6',
  fasciaInner: '#6d685f',
  parapetTop: '#f1ede3',
  parapetSide: '#dcd6c8',
} as const;

/** Texel padding around each deck in the atlas (mipmap bleed guard). */
const ATLAS_PAD = 4;
const ATLAS_MAX_WIDTH = 1024;

export interface DeckAtlasRect {
  /** Texel origin of this deck in the atlas. */
  ax: number;
  ay: number;
  /** World x of texel column 0 and world y of texel row 0 (north edge). */
  x0: number;
  y1: number;
}

export interface DeckAtlas {
  width: number;
  height: number;
  res: number;
  data: Uint8ClampedArray;
  rects: DeckAtlasRect[];
}

export function isValidDeck(deck: GroundDeck | null | undefined): deck is GroundDeck {
  if (!deck || !Array.isArray(deck.t) || deck.t.length < 9 || deck.t.length % 9 !== 0) return false;
  if (!Array.isArray(deck.bb) || deck.bb.length !== 4 || !deck.bb.every(Number.isFinite)) return false;
  if (!Array.isArray(deck.r)) return false;
  for (const value of deck.t) if (!Number.isFinite(value)) return false;
  return true;
}

export function tileDecks(tile: TileData | null | undefined): GroundDeck[] {
  const decks = tile?.ground?.decks;
  return Array.isArray(decks) ? decks.filter(isValidDeck) : [];
}

/** True when the tile describes its bridges as 0.4.2 decks (vector decks off). */
export function usesGroundDecks(tile: TileData | null | undefined): boolean {
  return Number(tile?.ground?.version) >= 2;
}

/** Shelf-pack the deck rectangles; returns atlas size and per-deck texel rects. */
export function layoutDeckAtlas(
  decks: readonly GroundDeck[],
  res: number,
): { width: number; height: number; rects: DeckAtlasRect[]; sizes: [number, number][] } {
  const sizes: [number, number][] = [];
  const origins: [number, number][] = [];
  for (const deck of decks) {
    const ix0 = Math.floor(deck.bb[0] / res) - ATLAS_PAD;
    const ix1 = Math.ceil(deck.bb[2] / res) + ATLAS_PAD;
    const iy0 = Math.floor(deck.bb[1] / res) - ATLAS_PAD;
    const iy1 = Math.ceil(deck.bb[3] / res) + ATLAS_PAD;
    sizes.push([ix1 - ix0, iy1 - iy0]);
    origins.push([ix0 * res, iy1 * res]);
  }
  const order = decks.map((_, i) => i).sort((a, b) => sizes[b][1] - sizes[a][1]);
  const rects: DeckAtlasRect[] = new Array(decks.length);
  let x = 0;
  let y = 0;
  let shelf = 0;
  let width = 1;
  for (const i of order) {
    const [w, h] = sizes[i];
    if (x > 0 && x + w > ATLAS_MAX_WIDTH) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    rects[i] = { ax: x, ay: y, x0: origins[i][0], y1: origins[i][1] };
    x += w;
    shelf = Math.max(shelf, h);
    width = Math.max(width, x);
  }
  return { width, height: Math.max(1, y + shelf), rects, sizes };
}

/** Paint every deck of a tile into one RGBA atlas. Null without OffscreenCanvas. */
export function rasterizeDecks(decks: readonly GroundDeck[], res: number): DeckAtlas | null {
  if (decks.length === 0 || !groundRasterAvailable()) return null;
  const layout = layoutDeckAtlas(decks, res);
  const atlas = new OffscreenCanvas(layout.width, layout.height);
  const actx = atlas.getContext('2d', { willReadFrequently: true });
  if (!actx) return null;
  const crisp = res <= MARKINGS_MAX_RES_M;
  for (let i = 0; i < decks.length; i++) {
    const deck = decks[i];
    const [w, h] = layout.sizes[i];
    const rect = layout.rects[i];
    const bounds: [number, number, number, number] = [rect.x0, rect.y1 - h * res, rect.x0 + w * res, rect.y1];
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) continue;
    const pseudo = {
      surfaces: [],
      junctions: [],
      ground: {
        version: 2,
        strokes: Array.isArray(deck.s) ? deck.s : [],
        fills: Array.isArray(deck.f) ? deck.f : [],
        dividers: Array.isArray(deck.dv) ? deck.dv : [],
      },
    } as unknown as TileData;
    paintGround(ctx as unknown as GroundContext2D, pseudo, bounds, res, w, h, {
      railHeads: false,
      base: null,
      underlay: deck.r.map((ring) => ring.p),
      underlayColor: DECK_COLORS.surface,
    });
    if (crisp) paintCrispOverlays(ctx, pseudo, bounds, res, w, h);
    paintRailHeads(ctx, pseudo, bounds, res);
    // Strokes reach past the deck outline; geometry clips them, but the atlas
    // cell is shared with mip levels, so keep only texels inside the cell.
    actx.drawImage(canvas, rect.ax, rect.ay);
  }
  const image = actx.getImageData(0, 0, layout.width, layout.height);
  return { width: layout.width, height: layout.height, res, data: image.data, rects: layout.rects };
}

/** Textured top surface of all decks (world space, UVs into the atlas). */
export function buildDeckTopGeometry(
  decks: readonly GroundDeck[],
  atlas: Pick<DeckAtlas, 'width' | 'height' | 'res' | 'rects'>,
): THREE.BufferGeometry | null {
  let count = 0;
  for (const deck of decks) count += deck.t.length / 9;
  if (count === 0) return null;
  const positions = new Float32Array(count * 9);
  const normals = new Float32Array(count * 9);
  const uvs = new Float32Array(count * 6);
  let p = 0;
  let q = 0;
  for (let d = 0; d < decks.length; d++) {
    const deck = decks[d];
    const rect = atlas.rects[d];
    const t = deck.t;
    for (let i = 0; i + 8 < t.length; i += 9) {
      // Local (x east, y north, z up) → world (x, y = up, z = -north).
      const ax = t[i], ay = t[i + 1], az = t[i + 2];
      const bx = t[i + 3], by = t[i + 4], bz = t[i + 5];
      const cx = t[i + 6], cy = t[i + 7], cz = t[i + 8];
      // Face normal in world space: (B - A) × (C - A), CCW from above → +y.
      const ux = bx - ax, uy = bz - az, uz = -(by - ay);
      const vx = cx - ax, vy = cz - az, vz = -(cy - ay);
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      // Keep the winding consistent with the +y normal (front face up).
      const verts: [number, number, number][] =
        (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz >= 0
          ? [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]
          : [[ax, ay, az], [cx, cy, cz], [bx, by, bz]];
      for (const [x, y, z] of verts) {
        positions[p] = x;
        positions[p + 1] = DECK_BASE_Y + z;
        positions[p + 2] = -y;
        // Shaded like the flat ground: a lit ramp would turn the deck asphalt
        // into a lighter/darker patch against the street it continues (the
        // slope reads from the parapets and fascia instead).
        normals[p] = 0;
        normals[p + 1] = 1;
        normals[p + 2] = 0;
        p += 3;
        uvs[q] = (rect.ax + (x - rect.x0) / atlas.res) / atlas.width;
        uvs[q + 1] = (rect.ay + (rect.y1 - y) / atlas.res) / atlas.height;
        q += 2;
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

export interface DeckSideStats {
  decks: number;
  sideEdges: number;
  endEdges: number;
  triangles: number;
}

/** Fascia + parapet along every side edge of every deck. */
export function emitDeckSides(sink: GeometrySink, decks: readonly GroundDeck[]): DeckSideStats {
  const stats: DeckSideStats = { decks: 0, sideEdges: 0, endEdges: 0, triangles: 0 };
  const before = sink.triangleCount;
  for (const deck of decks) {
    stats.decks++;
    for (const ring of deck.r) emitRingSides(sink, ring, stats);
  }
  stats.triangles = sink.triangleCount - before;
  return stats;
}

function emitRingSides(sink: GeometrySink, ring: GroundDeckRing, stats: DeckSideStats): void {
  const { p, z, e } = ring;
  if (!Array.isArray(p) || !Array.isArray(z) || !Array.isArray(e)) return;
  const n = Math.min(p.length / 2, z.length, e.length);
  if (n < 3) return;
  for (let i = 0; i < n; i++) {
    const kind = e[i];
    if (kind !== 1) {
      if (kind === 0) stats.endEdges++;
      continue;
    }
    const j = (i + 1) % n;
    const ax = p[2 * i], ay = p[2 * i + 1];
    const bx = p[2 * j], by = p[2 * j + 1];
    const za = z[i], zb = z[j];
    if (![ax, ay, bx, by, za, zb].every(Number.isFinite)) continue;
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (!(length > 1e-4)) continue;
    stats.sideEdges++;
    // Rings are CCW (holes CW): the outside of the deck is on the right.
    const ox = dy / length;
    const oy = -dx / length;
    const outward: Vec3 = [ox, 0, -oy];
    const inward: Vec3 = [-ox, 0, oy];
    const topA = DECK_BASE_Y + za;
    const topB = DECK_BASE_Y + zb;
    const botA = Math.max(0, topA - DECK_SLAB_M);
    const botB = Math.max(0, topB - DECK_SLAB_M);
    const capA = topA + PARAPET_HEIGHT_M;
    const capB = topB + PARAPET_HEIGHT_M;
    // Outer face: fascia + parapet in one plane.
    sink.addOrientedQuad([ax, capA, -ay], [bx, capB, -by], [bx, botB, -by], [ax, botA, -ay], outward, DECK_COLORS.fascia);
    // Inner face of the fascia below the deck (seen through the gap under the span).
    if (topA - botA > 0.05 || topB - botB > 0.05) {
      sink.addOrientedQuad([ax, topA, -ay], [bx, topB, -by], [bx, botB, -by], [ax, botA, -ay], inward, DECK_COLORS.fasciaInner);
    }
    // Parapet: top strip and inner face, PARAPET_THICKNESS_M inside the edge.
    const ix = -ox * PARAPET_THICKNESS_M;
    const iy = -oy * PARAPET_THICKNESS_M;
    sink.addOrientedQuad(
      [ax, capA, -ay],
      [bx, capB, -by],
      [bx + ix, capB, -(by + iy)],
      [ax + ix, capA, -(ay + iy)],
      [0, 1, 0],
      DECK_COLORS.parapetTop,
    );
    sink.addOrientedQuad(
      [ax + ix, capA, -(ay + iy)],
      [bx + ix, capB, -(by + iy)],
      [bx + ix, topB, -(by + iy)],
      [ax + ix, topA, -(ay + iy)],
      inward,
      DECK_COLORS.parapetSide,
    );
  }
}
