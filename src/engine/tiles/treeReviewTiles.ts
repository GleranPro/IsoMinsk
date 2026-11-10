/** Synthetic specimens in the actual city renderer, never mixed with OSM data. */
import type { TileData, TreeInstance } from '../../shared/types';

export function createTreeReviewTiles(): TileData[] {
  const tree = (x: number, y: number, seed: number, height = 12, radius = 4): TreeInstance =>
    ({ x, y, height, radius, variation: ((seed * 0.61803398875) % 1), mapped: false });
  const specimens: TreeInstance[] = [];
  for (let i = 0; i < 7; i++) specimens.push(tree(196 + i * 20, 180, i, 8 + i * 1.8, 3 + i * 0.4));
  for (let i = 0; i < 18; i++) {
    specimens.push(tree(154 + i * 12, 274, i + 11));
    specimens.push(tree(154 + i * 12, 306, i + 11));
  }
  const forest: TreeInstance[] = [];
  for (let y = 0; y < 27; y++) for (let x = 0; x < 27; x++) {
    const seed = y * 27 + x;
    forest.push(tree(670 + x * 7.3 + Math.sin(seed) * 1.4, 155 + y * 7.3 + Math.cos(seed) * 1.4,
      seed + 41, 9 + ((seed * 7) % 9), 3.2 + (seed % 4) * 0.35));
  }
  const tile = (tileX: number, trees: TreeInstance[]): TileData => ({ tileX, tileY: 0,
    bounds: [tileX * 512, 0, (tileX + 1) * 512, 512], trees, buildings: [], surfaces: [], roads: [] });
  const first = tile(0, specimens);
  first.surfaces = [{ kind: 'grass', polygon: [[[0, 0], [512, 0], [512, 512], [0, 512]]] }];
  first.roads = [{ kind: 'road', class: 'residential', width: 14,
    polygon: [[[130, 283], [390, 283], [390, 297], [130, 297]]] }];
  const second = tile(1, forest);
  second.surfaces = [{ kind: 'park', polygon: [[[512, 0], [1024, 0], [1024, 512], [512, 512]]] }];
  return [first, second];
}
