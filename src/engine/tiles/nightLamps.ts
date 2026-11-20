/**
 * Night street lamps.
 *
 * One global instanced layer fed by lamp spots baked in the tile worker
 * (see `lampSpots.ts`): a soft warm pool on the road under each lamp and a
 * small crossed-quad glow at the lamp head. The layer exists only at night —
 * daytime opacity is 0 and the batches carry no instances — so it costs two
 * draw calls at most and nothing during the day.
 *
 * Instance buffers are refilled only when the camera quantised cell changes or
 * the tile set changes (never per frame); per frame only the night opacity
 * moves. `update()` is called from the existing createCityApp tick.
 */

import * as THREE from 'three';

/** Hard instance budget per batch (desktop). */
export const LAMP_BUDGET = 900;
/** Mobile budget. */
export const LAMP_BUDGET_MOBILE = 300;
/** Night threshold: below this the layer renders nothing. */
export const LAMPS_NIGHT_MIN = 0.3;
/** Refill the instance buffers at most this often, milliseconds. */
const REFILL_COOLDOWN_MS = 250;
/** Camera movement that marks the buffers dirty, metres. */
const REFILL_MOVE_M = 64;
/** Head glow height above ground, metres. */
const LAMP_HEAD_Y = 7.2;
/** Ground pool radius, metres. */
const LAMP_POOL_RADIUS_M = 5.2;
/** Glow quad size at the lamp head, metres. */
const LAMP_HEAD_SIZE_M = 2.2;

export interface NightLampsOptions {
  mobile?: boolean;
}

interface LampSpot {
  x: number;
  z: number;
  distance: number;
}

export class NightLampsLayer {
  readonly root = new THREE.Group();

  private readonly budget: number;
  private readonly pools: Map<string, Float32Array | null> = new Map();
  private readonly poolMaterial: THREE.MeshBasicMaterial;
  private readonly headMaterial: THREE.MeshBasicMaterial;
  private readonly poolMesh: THREE.InstancedMesh;
  private readonly headMesh: THREE.InstancedMesh;
  private nightFactor = 0;
  private lastRefillAt = -Infinity;
  private lastCellX = Number.NaN;
  private lastCellZ = Number.NaN;
  private dirty = true;
  private viewCenterX = 0;
  private viewCenterZ = 0;
  private viewRadiusM = 1600;
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchQuaternion = new THREE.Quaternion();
  private readonly scratchScale = new THREE.Vector3();
  private readonly scratchColor = new THREE.Color();
  private readonly candidates: LampSpot[] = [];
  private disposed = false;

  constructor(options: NightLampsOptions = {}) {
    this.budget = options.mobile ? LAMP_BUDGET_MOBILE : LAMP_BUDGET;

    this.root.name = 'night-lamps';
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();

    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    plane.name = 'night-lamp-pool';
    this.poolMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.poolMaterial.name = 'IsometricMinskNightLampPools';

    const cross = NightLampsLayer.createCrossGeometry();
    this.headMaterial = new THREE.MeshBasicMaterial({
      color: 0xffe9c2,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.headMaterial.name = 'IsometricMinskNightLampHeads';

    this.poolMesh = new THREE.InstancedMesh(plane, this.poolMaterial, this.budget);
    this.poolMesh.name = 'night-lamp-pools';
    this.poolMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.poolMesh.frustumCulled = false;
    this.poolMesh.count = 0;
    this.headMesh = new THREE.InstancedMesh(cross, this.headMaterial, this.budget);
    this.headMesh.name = 'night-lamp-heads';
    this.headMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.headMesh.frustumCulled = false;
    this.headMesh.count = 0;
    this.root.add(this.poolMesh, this.headMesh);
    this.root.visible = false;
  }

  /** Two crossed vertical quads: the head glow reads from any camera azimuth. */
  private static createCrossGeometry(): THREE.BufferGeometry {
    const cross = new THREE.BufferGeometry();
    const half = LAMP_HEAD_SIZE_M * 0.5;
    const positions = new Float32Array([
      -half, -half, 0, half, -half, 0, half, half, 0,
      -half, -half, 0, half, half, 0, -half, half, 0,
      0, -half, -half, 0, -half, half, 0, half, half,
      0, -half, -half, 0, half, half, 0, half, -half,
    ]);
    cross.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    cross.name = 'night-lamp-head';
    cross.computeBoundingSphere();
    return cross;
  }

  /** Tile adoption: store (or replace) the tile's lamp spots. */
  setTileSpots(key: string, spots: Float32Array | null): void {
    if (this.disposed) return;
    const previous = this.pools.get(key);
    if (previous === spots) return;
    this.pools.set(key, spots);
    this.dirty = true;
  }

  /** Drop a tile's spots (eviction / payload replacement). */
  removeTile(key: string): void {
    if (this.disposed) return;
    if (this.pools.delete(key)) this.dirty = true;
  }

  /** Camera frame: marks the buffers dirty when the view moves a cell. */
  setView(centerX: number, centerZ: number, radiusM: number): void {
    if (this.disposed) return;
    this.viewCenterX = centerX;
    this.viewCenterZ = centerZ;
    if (Number.isFinite(radiusM) && radiusM > 0) this.viewRadiusM = radiusM;
    const cellX = Math.floor(centerX / REFILL_MOVE_M);
    const cellZ = Math.floor(centerZ / REFILL_MOVE_M);
    if (cellX !== this.lastCellX || cellZ !== this.lastCellZ) {
      this.lastCellX = cellX;
      this.lastCellZ = cellZ;
      this.dirty = true;
    }
  }

  /** Night 0..1 from the time-of-day look. */
  setNightFactor(value: number): void {
    if (this.disposed) return;
    const night = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    if (night === this.nightFactor) return;
    this.nightFactor = night;
    const glow = Math.max(0, night - LAMPS_NIGHT_MIN) / (1 - LAMPS_NIGHT_MIN);
    this.poolMaterial.opacity = 0.34 * glow;
    this.headMaterial.opacity = 0.85 * glow;
    this.root.visible = glow > 0;
  }

  /** Per-frame: refill the instance buffers at most every cooldown. */
  update(nowMs: number): void {
    if (this.disposed) return;
    if (this.nightFactor < LAMPS_NIGHT_MIN || !this.dirty) return;
    if (nowMs - this.lastRefillAt < REFILL_COOLDOWN_MS) return;
    this.lastRefillAt = nowMs;
    this.dirty = false;
    this.refill();
  }

  private refill(): void {
    const radiusLimit = this.viewRadiusM * 1.35;
    const radiusLimitSq = radiusLimit * radiusLimit;
    this.candidates.length = 0;
    for (const spots of this.pools.values()) {
      if (!spots) continue;
      for (let i = 0; i + 1 < spots.length; i += 2) {
        const x = spots[i];
        const z = spots[i + 1];
        const dx = x - this.viewCenterX;
        const dz = z - this.viewCenterZ;
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq > radiusLimitSq) continue;
        this.candidates.push({ x, z, distance: distanceSq });
      }
    }
    this.candidates.sort((a, b) => a.distance - b.distance);

    let count = 0;
    for (const spot of this.candidates) {
      if (count >= this.budget) break;
      // Ground pool under the lamp.
      this.scratchPosition.set(spot.x, 0.06, spot.z);
      this.scratchQuaternion.identity();
      this.scratchScale.set(LAMP_POOL_RADIUS_M * 2, 1, LAMP_POOL_RADIUS_M * 2);
      this.scratchMatrix.compose(this.scratchPosition, this.scratchQuaternion, this.scratchScale);
      this.poolMesh.setMatrixAt(count, this.scratchMatrix);
      // Crossed glow quads at the lamp head.
      this.scratchPosition.set(spot.x, LAMP_HEAD_Y, spot.z);
      this.scratchScale.set(1, 1, 1);
      this.scratchMatrix.compose(this.scratchPosition, this.scratchQuaternion, this.scratchScale);
      this.headMesh.setMatrixAt(count, this.scratchMatrix);
      count += 1;
    }
    this.poolMesh.count = count;
    this.headMesh.count = count;
    if (count > 0) {
      this.poolMesh.instanceMatrix.needsUpdate = true;
      this.headMesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** QA: how many lamp instances are currently drawn. */
  getDrawnCount(): number {
    return this.poolMesh.count;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pools.clear();
    this.candidates.length = 0;
    this.root.removeFromParent();
    this.poolMesh.dispose();
    this.headMesh.dispose();
    (this.poolMesh.geometry as THREE.BufferGeometry).dispose();
    (this.headMesh.geometry as THREE.BufferGeometry).dispose();
    this.poolMaterial.dispose();
    this.headMaterial.dispose();
  }
}
