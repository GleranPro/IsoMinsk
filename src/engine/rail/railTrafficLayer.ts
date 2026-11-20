/**
 * Isometric Minsk — фоновое движение поездов по реальным ж/д путям.
 *
 * Слой независим от `MobilityLayer`: у электричек и грузовых составов нет
 * публичного расписания, поэтому это визуальная модель, а не рейсы. Поезда
 * идут по сегментам `data/mobility/rail/network.json` (участки OSM), состоят
 * из отдельных вагонов-инстансов и используют те же Blender-модели, что и
 * остальной транспорт.
 *
 * Жизненный цикл: `new RailTrafficLayer()` -> `scene.add(layer.root)` ->
 * `void layer.load()` -> `update(dt, view)` каждый кадр -> `dispose()`.
 * Ошибки загрузки не фатальны: карта продолжает работать без поездов.
 */

import * as THREE from 'three';
import {
  createVehicleInstances,
  createVehicleTemplate,
  disposeVehicleInstances,
  type VehicleModel,
} from '../../city/mobility/vehicleGeometry';
import { loadVehicleModelPayloadCached } from '../../city/mobility/vehiclePayload';
import {
  advanceRailTrain,
  buildRailTrains,
  parseRailNetwork,
  railUnitPose,
  sampleRailSegment,
  type RailNetwork,
  type RailNetworkSegment,
  type RailTrain,
} from '../../city/rail/railNetwork';

const RAIL_MODELS: readonly VehicleModel[] = [
  'commuterLead',
  'commuterCar',
  'freightLoco',
  'freightWagon',
];

const RAIL_LIFT_M = 0.12;
const VIEW_MARGIN_M = 120;
const UP = new THREE.Vector3(0, 1, 0);

export type RailTrafficState = 'idle' | 'loading' | 'ready' | 'error';

export interface RailTrafficView {
  rect: { minX: number; maxX: number; minZ: number; maxZ: number };
  worldPerPixel: number;
  /** UI: показывать транспорт (поезда — часть «Vehicles»). */
  visible: boolean;
  /** UI: пауза симуляции. */
  paused: boolean;
}

export interface RailTrafficStats {
  state: RailTrafficState;
  trains: number;
  commuterTrains: number;
  freightTrains: number;
  drawnUnits: number;
  triangles: number;
  drawCalls: number;
  hiddenByView: number;
  error: string | null;
}

export interface RailTrafficLayerOptions {
  /** Каталог с `network.json` (по умолчанию `data/mobility/rail`). */
  baseUrl?: string;
  /** Каталог с Blender-моделями (по умолчанию `data/mobility/vehicles`). */
  vehicleModelsUrl?: string;
  mobile?: boolean;
  maxTrains?: number;
  freightWagons?: number;
  fetchImpl?: typeof fetch;
}

interface TrainRuntime {
  train: RailTrain;
  segment: RailNetworkSegment;
}

function clampCapacity(value: number): number {
  return Math.max(1, Math.ceil(value));
}

export class RailTrafficLayer {
  readonly root = new THREE.Group();

  private readonly options: RailTrafficLayerOptions;
  private readonly material: THREE.MeshLambertMaterial;
  private readonly meshes = new Map<VehicleModel, THREE.InstancedMesh>();
  private readonly triangles = new Map<VehicleModel, number>();
  private readonly runtimes: TrainRuntime[] = [];
  private network: RailNetwork | null = null;
  private stateValue: RailTrafficState = 'idle';
  private errorValue: string | null = null;
  private loadPromise: Promise<void> | null = null;
  private disposed = false;
  private paused = false;
  private visible = true;
  private lastStats: RailTrafficStats = {
    state: 'idle',
    trains: 0,
    commuterTrains: 0,
    freightTrains: 0,
    drawnUnits: 0,
    triangles: 0,
    drawCalls: 0,
    hiddenByView: 0,
    error: null,
  };

  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpPosition = new THREE.Vector3();
  private readonly tmpQuaternion = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly white = new THREE.Color(1, 1, 1);

  constructor(options: RailTrafficLayerOptions = {}) {
    this.options = options;
    this.root.name = 'rail-traffic';
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();

    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
      fog: true,
      emissive: new THREE.Color().setRGB(0.015, 0.016, 0.018),
    });
    this.material.name = 'IsometricMinskRailTraffic';

    // Процедурные fallback-меши создаются сразу: они пустые и заменяются
    // Blender-геометрией после загрузки payload. Это позволяет слою не
    // зависеть от сети и корректно освобождаться в любом состоянии.
    const capacities: Record<string, number> = {
      commuterLead: this.options.mobile ? 8 : 16,
      commuterCar: this.options.mobile ? 4 : 8,
      freightLoco: this.options.mobile ? 4 : 8,
      freightWagon: this.options.mobile ? 24 : 48,
    };
    for (const model of RAIL_MODELS) {
      const geometry = createVehicleTemplate(model);
      const mesh = createVehicleInstances(
        geometry,
        clampCapacity(capacities[model] ?? 8),
        this.material,
        model,
      );
      mesh.name = `rail-unit-${model}`;
      mesh.frustumCulled = false;
      this.meshes.set(model, mesh);
      this.triangles.set(model, geometry.getAttribute('position').count / 3);
      this.root.add(mesh);
    }
  }

  get state(): RailTrafficState {
    return this.stateValue;
  }

  get error(): string | null {
    return this.errorValue;
  }

  /** Загрузить сеть и Blender-модели. Повторный вызов возвращает тот же промис. */
  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadInternal();
    return this.loadPromise;
  }

  private async loadInternal(): Promise<void> {
    this.stateValue = 'loading';
    this.lastStats = { ...this.lastStats, state: 'loading' };
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const base = (this.options.baseUrl ?? 'data/mobility/rail').replace(/\/+$/, '');
    try {
      const [networkResponse, vehiclePayload] = await Promise.all([
        fetchImpl(`${base}/network.json`),
        loadVehicleModelPayloadCached({
          baseUrl: this.options.vehicleModelsUrl,
          fetchImpl,
        }),
      ]);
      if (!networkResponse.ok) {
        throw new Error(`rail network fetch failed: ${networkResponse.status}`);
      }
      const network = parseRailNetwork(await networkResponse.json());
      this.applyVehicleModels(vehiclePayload.geometries);
      this.adoptNetwork(network);
    } catch (error) {
      if (this.disposed) return;
      this.stateValue = 'error';
      this.errorValue = error instanceof Error ? error.message : String(error);
      this.lastStats = { ...this.lastStats, state: 'error', error: this.errorValue };
    }
  }

  /**
   * Принять уже разобранную сеть (production — после fetch, тесты — напрямую).
   * Создаёт составы и переводит слой в `ready`.
   */
  adoptNetwork(network: RailNetwork): void {
    if (this.disposed) return;
    this.network = network;
    const maxTrains = this.options.maxTrains ?? (this.options.mobile ? 5 : 12);
    const trains = buildRailTrains(network.segments, {
      maxTrains,
      freightWagons: this.options.freightWagons ?? (this.options.mobile ? 4 : 6),
    });
    const byId = new Map(network.segments.map((segment) => [segment.id, segment]));
    this.runtimes.length = 0;
    for (const train of trains) {
      const segment = byId.get(train.segmentId);
      if (segment) this.runtimes.push({ train, segment });
    }
    this.stateValue = 'ready';
    this.errorValue = null;
    this.lastStats = { ...this.lastStats, state: 'ready', trains: this.runtimes.length, error: null };
  }

  private applyVehicleModels(geometries: ReadonlyMap<VehicleModel, THREE.BufferGeometry>): void {
    for (const model of RAIL_MODELS) {
      const geometry = geometries.get(model);
      const mesh = this.meshes.get(model);
      if (!geometry || !mesh) continue;
      const previous = mesh.geometry;
      // The cached payload is shared with the mobility layer; own a clone.
      const owned = geometry.clone();
      mesh.geometry = owned;
      this.triangles.set(model, owned.getAttribute('position').count / 3);
      if (previous) previous.dispose();
    }
  }

  /**
   * Один кадр. `dt` — секунды; слой сам ограничивает шаг, чтобы после паузы
   * вкладки поезда не прыгали.
   */
  update(dt: number, view: RailTrafficView): void {
    if (this.disposed) return;
    this.paused = view.paused;
    this.visible = view.visible;
    if (this.stateValue !== 'ready' || !this.visible) {
      this.hideAll();
      return;
    }
    const step = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
    const counts = new Map<VehicleModel, number>();
    for (const model of RAIL_MODELS) counts.set(model, 0);
    let hiddenByView = 0;
    let drawnUnits = 0;
    const rect = view.rect;
    for (const runtime of this.runtimes) {
      if (!this.paused) advanceRailTrain(runtime.train, runtime.segment, step);
      const bounds = runtime.segment.bounds;
      if (
        bounds[2] < rect.minX - VIEW_MARGIN_M ||
        bounds[0] > rect.maxX + VIEW_MARGIN_M ||
        bounds[3] < -rect.maxZ - VIEW_MARGIN_M ||
        bounds[1] > -rect.minZ + VIEW_MARGIN_M
      ) {
        hiddenByView += 1;
        continue;
      }
      for (const unit of runtime.train.units) {
        const pose = railUnitPose(runtime.train, runtime.segment, unit);
        if (!pose) continue;
        const mesh = this.meshes.get(unit.model);
        if (!mesh) continue;
        const index = counts.get(unit.model) ?? 0;
        if (index >= mesh.instanceMatrix.count) continue;
        this.tmpPosition.set(pose.x, RAIL_LIFT_M, -pose.y);
        this.tmpQuaternion.setFromAxisAngle(UP, pose.heading);
        this.tmpMatrix.compose(this.tmpPosition, this.tmpQuaternion, this.one);
        mesh.setMatrixAt(index, this.tmpMatrix);
        mesh.setColorAt(index, this.white);
        counts.set(unit.model, index + 1);
        drawnUnits += 1;
      }
    }
    let triangles = 0;
    let drawCalls = 0;
    for (const model of RAIL_MODELS) {
      const mesh = this.meshes.get(model);
      if (!mesh) continue;
      const count = counts.get(model) ?? 0;
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.computeBoundingBox();
        triangles += (this.triangles.get(model) ?? 0) * count;
        drawCalls += 1;
      }
    }
    this.lastStats = {
      state: this.stateValue,
      trains: this.runtimes.length,
      commuterTrains: this.runtimes.filter((runtime) => runtime.train.kind === 'commuter').length,
      freightTrains: this.runtimes.filter((runtime) => runtime.train.kind === 'freight').length,
      drawnUnits,
      triangles,
      drawCalls,
      hiddenByView,
      error: this.errorValue,
    };
  }

  getStats(): RailTrafficStats {
    return { ...this.lastStats };
  }

  /** Головы составов в локальных метрах (QA: куда навести камеру). */
  getTrainSamples(): { id: string; kind: string; x: number; y: number; segmentId: string }[] {
    return this.runtimes.map((runtime) => {
      const sample = sampleRailSegment(runtime.segment.points, runtime.train.distanceM);
      return {
        id: runtime.train.id,
        kind: runtime.train.kind,
        x: sample.x,
        y: sample.y,
        segmentId: runtime.segment.id,
      };
    });
  }

  /** Составы для QA/тестов (read-only ссылки на runtime-состояние). */
  getTrains(): readonly RailTrain[] {
    return this.runtimes.map((runtime) => runtime.train);
  }

  getNetwork(): RailNetwork | null {
    return this.network;
  }

  private hideAll(): void {
    for (const mesh of this.meshes.values()) {
      mesh.count = 0;
      mesh.visible = false;
    }
    this.lastStats = {
      ...this.lastStats,
      state: this.stateValue,
      drawnUnits: 0,
      triangles: 0,
      drawCalls: 0,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.meshes.values()) {
      disposeVehicleInstances(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.clear();
    this.material.dispose();
    this.root.removeFromParent();
    this.root.clear();
    this.network = null;
    this.runtimes.length = 0;
  }
}
