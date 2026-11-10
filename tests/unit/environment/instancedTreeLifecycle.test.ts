import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TileData } from '../../../src/shared/types';
import { buildTilePayload } from '../../../src/engine/tiles/tileBuild';
import { collectTransferables, payloadBytes } from '../../../src/engine/tiles/serialization';
import { TileStreamer } from '../../../src/engine/tiles/tileStreamer';
import { TileWorkerPool } from '../../../src/engine/tiles/tileWorkerPool';
import { createTileTrees, TreeTemplateCache, applyCanopyAppearance } from '../../../src/engine/tiles/instancedTrees';
import { CANOPY_PALETTE, buildTreeInstances } from '../../../src/city/environment/treeInstances';
import { buildEnvironmentMeshes } from '../../../src/city/environment/environmentMeshes';
import type { TileWirePayload, TileWorkerLoadRequest, TileWorkerResponse } from '../../../src/engine/tiles/serialization';

const tile = (x = 0): TileData => ({ tileX: x, tileY: 0, bounds: [x * 512, 0, (x + 1) * 512, 512],
  buildings: [], surfaces: [], roads: [], trees: Array.from({ length: 20 }, (_, i) =>
    ({ x: x * 512 + 40 + i * 5, y: 100, height: 12, radius: 4, variation: i / 20, mapped: false })) });
const payload = (x = 0) => buildTilePayload(tile(x), { trees: true, facadeDetail: false, treeStyle: 'clustered', groundMode: 'vector' });
afterEach(() => vi.unstubAllGlobals());

describe('tree payload transport', () => {
  it('uses the selected C style through environment and tile-builder defaults', () => {
    const data = tile();
    const env = buildEnvironmentMeshes(data, { tileBounds: data.bounds, trees: true });
    expect(env.trees).toBeNull();
    expect(env.treeInstances!.style).toBe('asymmetric');
    expect(env.counts!.treeTriangles).toBe(env.treeInstances!.triangleCount);
    const result = buildTilePayload(data, { facadeDetail: false, trees: true });
    expect(result.trees!.style).toBe('asymmetric');
    expect(result.legacyTrees).toBeNull();
  });
  it('transfers owned typed arrays, detaches the worker buffers and preserves values', () => {
    const data = payload();
    expect(data.trees!.count).toBe(20);
    expect(data.legacyTrees).toBeNull();
    expect(data.bytes).toBe(payloadBytes(data));
    const transfer = collectTransferables(data);
    expect(new Set(transfer).size).toBe(transfer.length);
    const matrix = data.trees!.trunks.matrices.slice();
    const copy = structuredClone(data, { transfer });
    expect(data.trees!.trunks.matrices.byteLength).toBe(0);
    expect(copy.trees!.trunks.matrices).toEqual(matrix);
    expect(copy.bytes).toBe(payloadBytes(copy));
  });

  it('does not instantiate vegetation on ground upgrades or with trees disabled', () => {
    expect(buildTilePayload(tile(), { facadeDetail: false, trees: true, treeStyle: 'clustered', groundOnly: true }).trees).toBeNull();
    expect(buildTilePayload(tile(), { facadeDetail: false, trees: false, treeStyle: 'clustered' }).trees).toBeNull();
    expect(payload().triangleCount).toBe(20 * 52 + 2);
  });
});

describe('instanced mesh ownership and appearance', () => {
  it('keeps a real wheel in a separate mesh/material while hiding and recolouring leaves', () => {
    const root = new THREE.Group(), material = new THREE.MeshLambertMaterial();
    const attractionMaterial = new THREE.MeshLambertMaterial(), canopyMaterial = new THREE.MeshLambertMaterial();
    const streamer = new TileStreamer({ scene: new THREE.Scene(), root, environmentMaterial: material,
      treeMaterial: material, treeCanopyMaterial: canopyMaterial, attractionMaterial,
      facadeMaterialNear: material, facadeMaterialFar: material });
    const data = tile();
    data.attractions = [{ id: 'test-wheel', type: 'ferris-wheel', x: 150, y: 150,
      radius: 12.8, hubHeight: 14.6, height: 28, cabins: 18, openCabins: 0, rotation: 0 }];
    const p = buildTilePayload(data, { trees: true, facadeDetail: false });
    expect(p.attractions!.triangleCount).toBeGreaterThan(100);
    const access = streamer as unknown as { addTileFromPayload(p: TileWirePayload): void };
    access.addTileFromPayload(p);
    const entry = streamer.getTile('0_0')!;
    const wheel = entry.attractionMesh!, geometry = wheel.geometry;
    const color = geometry.getAttribute('color').array.slice();
    expect(wheel.material).toBe(attractionMaterial);
    expect(entry.trees!.crowns[0].material).toBe(canopyMaterial);
    streamer.setCanopyAppearance({ visible: false, palette: ['#bbaa44', '#bb8833', '#cc6622', '#996622'] });
    expect(wheel.visible).toBe(true);
    expect(wheel.castShadow).toBe(true);
    expect(wheel.geometry).toBe(geometry);
    expect(geometry.getAttribute('color').array).toEqual(color);
    streamer.dispose(); material.dispose(); attractionMaterial.dispose(); canopyMaterial.dispose();
  });

  it('shares templates across tiles, bounds every instance and recolours in place', () => {
    const cache = new TreeTemplateCache(), material = new THREE.MeshLambertMaterial();
    const data = buildTreeInstances(tile().trees, 'clustered')!;
    const first = createTileTrees(data, cache, material, material, '0_0');
    const second = createTileTrees(buildTreeInstances(tile(1).trees, 'clustered')!, cache, material, material, '1_0');
    expect(first.trunks.geometry).toBe(second.trunks.geometry);
    expect(first.crowns[0].geometry).toBe(second.crowns[0].geometry);
    expect(first.trunks.instanceMatrix.array).toBe(data.trunks.matrices);
    expect(first.trunks.boundingBox!.containsPoint(new THREE.Vector3(40, 1, -100))).toBe(true);
    expect(first.trunks.boundingBox!.containsPoint(new THREE.Vector3(135, 1, -100))).toBe(true);
    const geometry = first.crowns[0].geometry, matrix = first.crowns[0].instanceMatrix;
    const trunkColor = first.trunks.instanceColor!.array.slice();
    const color = first.crowns[0].instanceColor!, before = color.array.slice();
    applyCanopyAppearance(first, { visible: false, palette: ['#b18132', '#c19343', '#d2ac54', '#9b6c2e'] });
    expect(first.crowns.every(m => !m.visible)).toBe(true);
    expect(first.trunks.visible).toBe(true);
    expect(first.trunks.instanceColor!.array).toEqual(trunkColor);
    expect(first.crowns[0].instanceColor).toBe(color);
    expect(color.array).not.toEqual(before);
    applyCanopyAppearance(first, { visible: true, palette: CANOPY_PALETTE });
    expect(color.array).toEqual(before);
    expect(first.crowns[0].geometry).toBe(geometry);
    expect(first.crowns[0].instanceMatrix).toBe(matrix);
    const sharedDispose = vi.fn(), meshDispose = vi.fn();
    geometry.addEventListener('dispose', sharedDispose);
    first.crowns[0].addEventListener('dispose', meshDispose);
    first.dispose();
    expect(meshDispose).toHaveBeenCalledTimes(1);
    expect(sharedDispose).not.toHaveBeenCalled();
    second.dispose();
    cache.dispose();
    expect(sharedDispose).toHaveBeenCalledTimes(1);
    expect(cache.bytes).toBe(0);
    material.dispose();
  });

  it('evicts only instance resources, applies current appearance to new tiles and disposes templates once', () => {
    const root = new THREE.Group(), material = new THREE.MeshLambertMaterial();
    const streamer = new TileStreamer({ scene: new THREE.Scene(), root,
      environmentMaterial: material, treeMaterial: material, facadeMaterialNear: material, facadeMaterialFar: material });
    const access = streamer as unknown as { addTileFromPayload(p: TileWirePayload): void; evictTile(key: string): void };
    access.addTileFromPayload(payload());
    access.addTileFromPayload(payload(1));
    const first = streamer.getTile('0_0')!.trees!, second = streamer.getTile('1_0')!.trees!;
    const shared = second.crowns[0].geometry;
    const disposed = vi.fn(); shared.addEventListener('dispose', disposed);
    const twoTilesMB = streamer.geometryMB;
    streamer.setCanopyAppearance({ visible: false, palette: ['#aaaa44', '#bb8833', '#cc6622', '#996622'] });
    expect(first.crowns.every(m => !m.visible)).toBe(true);
    expect(() => streamer.setCanopyAppearance({ palette: [] })).toThrow();
    access.evictTile('0_0');
    expect(disposed).not.toHaveBeenCalled();
    expect(streamer.getTreeDiagnostics().count).toBe(20);
    expect(streamer.geometryMB).toBeLessThan(twoTilesMB);
    for (let i = 0; i < 3; i++) {
      access.addTileFromPayload(payload());
      expect(streamer.getTile('0_0')!.trees!.crowns.every(m => !m.visible)).toBe(true);
      expect(streamer.geometryMB).toBeCloseTo(twoTilesMB, 9);
      access.evictTile('0_0');
    }
    expect(second.crowns[0].geometry).toBe(shared);
    streamer.dispose(); streamer.dispose();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(streamer.geometryMB).toBe(0);
    expect(root.children).toHaveLength(0);
    material.dispose();
  });
});

describe('worker cancellation with compact tree payloads', () => {
  it('passes the chosen style and ignores a result arriving after cancellation', async () => {
    class FakeWorker {
      static instance: FakeWorker;
      sent: Array<TileWorkerLoadRequest | { type: 'cancel'; id: number }> = [];
      onmessage?: (event: { data: TileWorkerResponse }) => void;
      constructor() { FakeWorker.instance = this; }
      postMessage(message: TileWorkerLoadRequest) { this.sent.push(message); }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    const pool = new TileWorkerPool({ size: 1 });
    const a = pool.load({ key: '0_0', url: '/a', facadeDetail: false, trees: true, treeStyle: 'clustered' });
    const b = pool.load({ key: '1_0', url: '/b', facadeDetail: false, trees: true, treeStyle: 'asymmetric' });
    const worker = FakeWorker.instance;
    expect(worker.sent[0]).toMatchObject({ treeStyle: 'clustered' });
    pool.cancel(a.id);
    expect(await a.promise).toBeNull();
    worker.onmessage!({ data: { type: 'result', id: a.id, payload: payload() } });
    expect(worker.sent.at(-1)).toMatchObject({ treeStyle: 'asymmetric' });
    worker.onmessage!({ data: { type: 'result', id: b.id,
      payload: buildTilePayload(tile(1), { facadeDetail: false, trees: true, treeStyle: 'asymmetric' }) } });
    expect((await b.promise)!.trees!.style).toBe('asymmetric');
    pool.dispose();
  });
});
