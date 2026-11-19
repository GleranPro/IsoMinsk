/**
 * Isometric Minsk — Three.js слой общественного транспорта и светофоров.
 *
 * Слой не владеет часами и правилами: симуляция (`src/mobility/*`) присылает
 * снимки рейсов и аспекты светофоров, а `MobilityLayer` интерполирует позиции
 * между шагами, выбирает видимые единицы под бюджет и раскладывает их по
 * `InstancedMesh`. Второго render loop здесь нет — `update()` вызывается из
 * существующего кадра `createCityApp`.
 *
 * Форма кадра (`MobilityView`):
 *   rect          — видимая земля в world XZ (как `IsometricCameraRig.getVisibleGroundRect`);
 *   time          — время симуляции, секунды от начала дня обслуживания (QA/отладка);
 *   worldPerPixel — мировые метры на пиксель кадра для экранного LOD;
 *   trips         — снимки рейсов симуляции (позиция в локальных метрах x/y/h, heading);
 *   signals       — аспекты светофоров по узлам: `{ nodeId, aspects: { groupId: aspect } }`;
 *   step          — необязательный номер шага симуляции. Смена step (или позы
 *                   рейсов при отсутствии step) запускает новый шаг интерполяции.
 *
 * Чтобы интерполяция была корректной, симуляция должна отдавать НОВЫЙ массив
 * снимков на каждом шаге (или передавать `step`); один и тот же массив,
 * мутируемый по месту, поддерживается только через сравнение поз.
 *
 * Соглашения рендера:
 *   - world: x = localX, y = высота + слой разметки, z = −localY;
 *   - экземпляр поворачивается на `heading` вокруг +Y (локальный +X модели —
 *     направление движения); для светофора локальный −X (линзы) смотрит
 *     навстречу движению, обслуживаемому головкой;
 *   - транспорт и светофоры НЕ пишут в общую shadow map: под машиной лежит
 *     дешёвая нарисованная тень (плоский тёмный четырёхугольник);
 *   - видимость светофоров (`signalsVisible`) не влияет на правила: слой
 *     только рисует то, что вычислил контроллер симуляции.
 *
 * Границы инстансов пересчитываются после каждого обновления матриц: иначе
 * three.js отсекает батч по устаревшей сфере и объекты внезапно исчезают.
 */

import * as THREE from 'three';
import { GROUND_LAYER_Y } from '../../shared/config';
import type {
  MobilityAspect,
  MobilitySettings,
  MobilitySignalNode,
  MobilityTrafficKind,
  MobilityTripSnapshot,
} from '../../shared/mobility';
import {
  VEHICLE_DIMENSIONS,
  VEHICLE_MODELS,
  VehicleTemplateCache,
  createVehicleInstances,
  disposeVehicleInstances,
  vehicleTintColor,
  type VehicleModel,
} from '../../city/mobility/vehicleGeometry';
import {
  SIGNAL_ASPECT_COLORS,
  collectSignalHeadInstances,
  createSignalGeometryTemplates,
  disposeSignalGeometryTemplates,
  signalGeometryBytes,
  signalHeadCentreY,
  signalLensFrontOffset,
  signalLensSlot,
  signalPoleHeight,
  type SignalGeometryTemplates,
  type SignalHeadInstance,
} from '../../city/mobility/signalGeometry';
import { geometryTriangleCount } from '../../city/mobility/lowPoly';

/** Видимая земля кадра в world XZ (см. `GroundRect` камеры). */
export interface MobilityViewRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Аспекты одного узла: ключ — `MobilitySignalGroup.id`. */
export interface MobilitySignalState {
  nodeId: string;
  aspects: Readonly<Record<string, MobilityAspect>>;
}

/** Кадр симуляции для слоя; см. описание модуля. */
export interface MobilityView {
  rect: MobilityViewRect;
  /** Время симуляции (секунды от начала дня); позиции уже посчитаны симуляцией. */
  time: number;
  /** Мировые метры на пиксель кадра: от него зависит экранный LOD. */
  worldPerPixel: number;
  trips: readonly MobilityTripSnapshot[];
  signals: readonly MobilitySignalState[];
  /** Номер шага симуляции: смена запускает новый шаг интерполяции. */
  step?: number;
}

/** Источник геометрии светофоров (реализуется `MobilityLoader`). */
export interface MobilitySignalSource {
  /** Счётчик изменений набора chunks: по нему слой перечитывает узлы. */
  revision: number;
  getSignalNodes(): readonly MobilitySignalNode[];
}

export interface MobilityLayerOptions {
  /** Мобильный бюджет: 8 видимых единиц вместо 20. */
  mobile?: boolean;
  /** Переопределить бюджет видимых рейсов (1..64). */
  maxVisibleTrips?: number;
  /** Максимум узлов светофоров с моделями (1..64). */
  maxSignalNodes?: number;
  /** Дешёвые нарисованные тени; на mobile можно выключить. */
  shadows?: boolean;
  /** Длительность шага симуляции для интерполяции, секунды (10 Гц = 0.1). */
  stepSeconds?: number;
  /** Источник узлов светофоров из загруженных chunks. */
  signalSource?: MobilitySignalSource;
}

/** Пороговые значения экранного LOD (гистерезис: enter > exit). */
export const MOBILITY_LOD = {
  /** Полная проекция длины транспорта, px: показать. */
  vehicleEnterPx: 3.2,
  /** Проекция, px: скрыть уже нарисованный транспорт. */
  vehicleExitPx: 2.2,
  /** Метров на пиксель: показать модели светофоров (ближний вид). */
  signalEnterWpp: 0.62,
  /** Метров на пиксель: скрыть уже показанные светофоры. */
  signalExitWpp: 0.9,
} as const;

/** Высота установки транспорта над локальной высотой h (слой разметки). */
export const MOBILITY_VEHICLE_LIFT_M = GROUND_LAYER_Y.markings + 0.012;
/** Высота основания стоек светофора (стилизованно, данных о тротуаре нет). */
export const MOBILITY_SIGNAL_BASE_Y = GROUND_LAYER_Y.markings + 0.02;
/** Тень на 3 мм ниже транспорта и на 5 мм выше разметки. */
const SHADOW_LIFT_M = GROUND_LAYER_Y.markings + 0.006;
/** Мировой запас вокруг кадра для теней/габаритов. */
const VIEW_MARGIN_M = 60;
/** Запас вокруг кадра для узлов светофоров, метры. */
const SIGNAL_VIEW_MARGIN_M = 90;
/** Предел светофорных экземпляров на один узел (защита от мусорных данных). */
const MAX_HEADS_PER_NODE = 12;
/**
 * Прыжок позиции между шагами больше этого предела (метры) не интерполируется:
 * так выглядит переинициализация/смена даты, а не движение. Без снимка
 * "сверхдлинного шага" машина иначе проехала бы сквозь город за кадр.
 */
const MAX_INTERPOLATION_STEP_M = 250;

/** Публичная статистика слоя (панель/QA; без внутренних ссылок). */
export interface MobilityLayerStats {
  budget: number;
  trips: number;
  drawnTrips: number;
  hiddenByLod: number;
  hiddenByBudget: number;
  finishedTrips: number;
  offscreenTrips: number;
  drawnTripIds: string[];
  dots: number;
  vehicleBatches: number;
  vehicleTriangles: number;
  shadowInstances: number;
  shadowsEnabled: boolean;
  signalNodes: number;
  signalNodesDrawn: number;
  signalHeadsDrawn: number;
  unknownAspects: number;
  signalTruncated: number;
  signalBatches: number;
  signalTriangles: number;
  templateBytes: number;
  instanceBytes: number;
  drawCalls: number;
}

interface Pose {
  x: number;
  y: number;
  h: number;
  heading: number;
}

interface TripRenderState extends Pose {
  prevX: number;
  prevY: number;
  prevH: number;
  prevHeading: number;
  alpha: number;
  lodVisible: boolean;
  drawn: boolean;
  lastSeen: number;
}

interface VehicleFrameSummary {
  trips: number;
  drawn: number;
  hiddenByLod: number;
  hiddenByBudget: number;
  finished: number;
  offscreen: number;
  drawnTripIds: string[];
  /** Сколько рейсов нарисовано точками вне экранного LOD моделей. */
  dots: number;
}

interface SignalFrameSummary {
  nodes: number;
  nodesDrawn: number;
  headsDrawn: number;
  unknownAspects: number;
  truncated: number;
}

interface SignalBatchSet {
  pole: THREE.InstancedMesh;
  housing: Map<MobilityTrafficKind, THREE.InstancedMesh>;
  lens: Map<MobilityTrafficKind, THREE.InstancedMesh>;
  capacity: number;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Акцентный цвет выделенного транспорта и метки под ним. */
const SELECTION_COLOR = 0xffd24a;
const SELECTION_TINT = new THREE.Color(1.0, 0.82, 0.29);

/**
 * Точки транспорта на обзорных видах. Модель автобуса на городском обзоре
 * занимает меньше пикселя и по экранному LOD скрывается — но тогда город
 * выглядит мёртвым. Вместо этого рисуем яркую точку фиксированного экранного
 * размера: движение видно, а стоимость — один инстанс.
 */
const DOT_BUDGET = 400;
const DOT_SIZE_PX = 2.4;
const DOT_COLORS: Record<string, number> = {
  bus: 0xffd24a,
  trolleybus: 0x6cc2ff,
  tram: 0xff6a4a,
};

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Кратчайшая интерполяция угла (радианы). */
function lerpAngle(from: number, to: number, t: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * t;
}

function poseFromSnapshot(trip: MobilityTripSnapshot): Pose {
  return { x: trip.x, y: trip.y, h: trip.h, heading: trip.heading };
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validRect(rect: MobilityViewRect): boolean {
  return (
    !!rect &&
    [rect.minX, rect.maxX, rect.minZ, rect.maxZ].every((value) => typeof value === 'number' && Number.isFinite(value)) &&
    rect.minX <= rect.maxX &&
    rect.minZ <= rect.maxZ
  );
}

function createShadowGeometry(): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.name = 'mobility-shadow';
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Слой транспорта и светофоров.
 *
 * Жизненный цикл: `new MobilityLayer(options)` -> `scene.add(layer.root)` ->
 * `update(dt, view)` каждый кадр -> `setSettings()` из UI -> `dispose()`.
 * Слой сам не подписывается на события и не запускает таймеры.
 *
 * `layer.root` живёт в мировых координатах и должен оставаться в начале
 * координат сцены: позы рейсов уже переведены из локальных метров в world.
 * Скрытые бюджетом/LOD рейсы не удаляются из состояния интерполяции — при
 * возвращении в кадр они продолжают движение с текущей фазы, а не начинают
 * заново (логическая фаза принадлежит симуляции, слой её не пересоздаёт).
 */
export class MobilityLayer {
  readonly root = new THREE.Group();

  private readonly vehicleRoot = new THREE.Group();
  private readonly signalRoot = new THREE.Group();
  private readonly shadowRoot = new THREE.Group();
  private readonly budget: number;
  private readonly maxSignalNodes: number;
  private readonly shadowsEnabled: boolean;
  private readonly stepSeconds: number;
  private readonly signalSource: MobilitySignalSource | undefined;

  private readonly templates = new VehicleTemplateCache();
  private readonly signalTemplates: SignalGeometryTemplates;
  private readonly vehicleMaterial: THREE.MeshLambertMaterial;
  private readonly signalMaterial: THREE.MeshLambertMaterial;
  private readonly lensMaterial: THREE.MeshBasicMaterial;
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private readonly shadowGeometry: THREE.PlaneGeometry;
  private readonly vehicleMeshes = new Map<VehicleModel, THREE.InstancedMesh>();
  private readonly vehicleTriangles = new Map<VehicleModel, number>();
  private readonly signalBatchTriangles = new Map<string, number>();
  private shadowMesh: THREE.InstancedMesh;
  private signalBatches: SignalBatchSet;

  private settings: MobilitySettings = {
    vehiclesVisible: true,
    signalsVisible: true,
    debug: false,
    paused: false,
  };

  private readonly tripStates = new Map<string, TripRenderState>();
  private lastStep: number | null = null;
  private lastWorldPerPixel = Number.NaN;
  private vehiclesWereHidden = false;
  /** Выбранный пользователем рейс: подсвечивается цветом и меткой под кузовом. */
  private selectedTripId: string | null = null;
  private selectionMesh: THREE.Mesh | null = null;
  /** Точки транспорта для обзорных видов (см. DOT_BUDGET). */
  private dotMesh: THREE.InstancedMesh | null = null;
  private readonly dotMaterial: THREE.MeshBasicMaterial;
  private frameSerial = 0;
  private disposed = false;

  private readonly signalLod = new Map<string, boolean>();
  private signalNodes: readonly MobilitySignalNode[] = [];
  private lastSignalRevision = -1;
  private readonly aspectLookup = new Map<string, Readonly<Record<string, MobilityAspect>>>();
  private readonly signalInstances: SignalHeadInstance[] = [];
  private signalNodeCandidates: { node: MobilitySignalNode; distance: number }[] = [];

  private vehicleSummary: VehicleFrameSummary = {
    trips: 0,
    drawn: 0,
    hiddenByLod: 0,
    hiddenByBudget: 0,
    finished: 0,
    offscreen: 0,
    dots: 0,
    drawnTripIds: [],
  };
  private signalSummary: SignalFrameSummary = {
    nodes: 0,
    nodesDrawn: 0,
    headsDrawn: 0,
    unknownAspects: 0,
    truncated: 0,
  };

  // Переиспользуемые объекты: слой не должен аллоцировать матрицы каждый кадр.
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpLensMatrix = new THREE.Matrix4();
  private readonly tmpOffsetMatrix = new THREE.Matrix4();
  private readonly tmpScaleMatrix = new THREE.Matrix4();
  private readonly tmpPosition = new THREE.Vector3();
  private readonly tmpQuaternion = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3(1, 1, 1);
  private readonly tmpColor = new THREE.Color();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(options: MobilityLayerOptions = {}) {
    this.signalSource = options.signalSource;
    this.budget = clamp(Math.floor(options.maxVisibleTrips ?? (options.mobile ? 8 : 20)), 1, 64);
    this.maxSignalNodes = clamp(Math.floor(options.maxSignalNodes ?? (options.mobile ? 10 : 24)), 1, 64);
    this.shadowsEnabled = options.shadows ?? !options.mobile;
    this.stepSeconds = finitePositive(options.stepSeconds) ? options.stepSeconds : 0.1;

    this.root.name = 'mobility';
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();
    this.vehicleRoot.name = 'mobility-vehicles';
    this.signalRoot.name = 'mobility-signals';
    this.shadowRoot.name = 'mobility-shadows';
    this.root.add(this.vehicleRoot, this.signalRoot, this.shadowRoot);

    this.vehicleMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
      fog: true,
      emissive: new THREE.Color().setRGB(0.015, 0.016, 0.018),
    });
    this.vehicleMaterial.name = 'IsometricMinskMobilityVehicles';

    this.signalMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
      fog: true,
      emissive: new THREE.Color().setRGB(0.02, 0.021, 0.022),
    });
    this.signalMaterial.name = 'IsometricMinskMobilitySignals';

    // Линзы не зависят от освещения: читаются как светящийся огонь в pixel-art.
    this.lensMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      fog: false,
      toneMapped: false,
    });
    this.lensMaterial.name = 'IsometricMinskMobilityLenses';

    // Дешёвая тень: полупрозрачный тёмный четырёхугольник, без shadow map.
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.27,
      depthWrite: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    this.shadowMaterial.name = 'IsometricMinskMobilityShadow';

    this.signalTemplates = createSignalGeometryTemplates();

    for (const model of VEHICLE_MODELS) {
      const geometry = this.templates.get(model);
      const mesh = createVehicleInstances(geometry, this.budget, this.vehicleMaterial, model);
      this.vehicleMeshes.set(model, mesh);
      this.vehicleTriangles.set(model, geometryTriangleCount(geometry));
      this.vehicleRoot.add(mesh);
    }

    this.shadowGeometry = createShadowGeometry();
    this.shadowMesh = this.createShadowMesh(this.budget);
    this.shadowRoot.add(this.shadowMesh);

    // Точки транспорта для обзорных видов: модель на городском обзоре меньше
    // пикселя и скрывается LOD, но город не должен выглядеть пустым.
    this.dotMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
      fog: false,
      depthWrite: false,
    });
    this.dotMaterial.name = 'IsometricMinskMobilityDots';
    const dotMesh = new THREE.InstancedMesh(this.shadowGeometry, this.dotMaterial, DOT_BUDGET);
    dotMesh.name = 'mobility-dots';
    dotMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    dotMesh.instanceMatrix.needsUpdate = true;
    dotMesh.frustumCulled = false;
    dotMesh.count = 0;
    dotMesh.visible = false;
    this.dotMesh = dotMesh;
    this.vehicleRoot.add(dotMesh);

    this.signalBatches = this.createSignalBatches(this.signalCapacityFor(this.maxSignalNodes * 6));

    if (this.signalSource) {
      this.lastSignalRevision = this.signalSource.revision;
      this.signalNodes = this.signalSource.getSignalNodes();
    }
    this.applyVisibility();
  }

  // -------------------------------------------------------------------------
  // публичный API
  // -------------------------------------------------------------------------

  /**
   * Обновляет слой одним кадром. `dt` — секунды с прошлого вызова; большие
   * пропуски ограничиваются, чтобы после паузы вкладки не было скачка.
   */
  update(dt: number, view: MobilityView): void {
    if (this.disposed) return;
    if (!view || !Array.isArray(view.trips)) return;
    if (!validRect(view.rect)) return;
    const stepDt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.25);
    if (Number.isFinite(view.worldPerPixel) && view.worldPerPixel > 0) {
      this.lastWorldPerPixel = view.worldPerPixel;
    }
    this.updateVehicles(view, stepDt);
    this.updateSignals(view);
  }

  /**
   * Заменить процедурные шаблоны запечёнными из Blender (`vehiclePayload.ts`).
   *
   * Вызывается один раз после загрузки payload, до того как симуляция начнёт
   * рисовать рейсы: старые instanced-меши пустые, поэтому замена не рвёт
   * кадр. Геометрия переходит во владение слоя (кеш освобождает её в
   * `dispose()`); модели без запечённой версии остаются процедурными.
   */
  replaceVehicleTemplates(geometries: ReadonlyMap<VehicleModel, THREE.BufferGeometry>): void {
    if (this.disposed) return;
    let replaced = 0;
    for (const model of VEHICLE_MODELS) {
      const geometry = geometries.get(model);
      if (!geometry) continue;
      const previous = this.vehicleMeshes.get(model);
      if (previous) {
        this.vehicleRoot.remove(previous);
        disposeVehicleInstances(previous);
      }
      // Payload geometry is shared with the rail layer through a cached fetch;
      // each layer owns a clone and disposes only its own copy.
      const owned = geometry.clone();
      this.templates.set(model, owned);
      const mesh = createVehicleInstances(this.templates.get(model), this.budget, this.vehicleMaterial, model);
      this.vehicleMeshes.set(model, mesh);
      this.vehicleTriangles.set(model, geometryTriangleCount(owned));
      this.vehicleRoot.add(mesh);
      replaced += 1;
    }
    if (replaced > 0) this.applyVisibility();
  }

  /** Настройки UI (видимость слоёв, пауза, QA). Правила симуляции не меняются. */
  setSettings(settings: MobilitySettings): void {
    if (this.disposed || !settings) return;
    this.settings = {
      vehiclesVisible: settings.vehiclesVisible !== false,
      signalsVisible: settings.signalsVisible !== false,
      debug: settings.debug === true,
      paused: settings.paused === true,
    };
    this.applyVisibility();
  }

  getSettings(): MobilitySettings {
    return { ...this.settings };
  }

  /**
   * Подсветить выбранный пользователем рейс (`null` — снять выделение).
   *
   * Кузов получает акцентный цвет через instanceColor (без отдельного материала
   * и без второго draw call), а под ним рисуется яркая метка — так выделение
   * видно и в обзорном виде, где сам кузов занимает пару пикселей.
   */
  setSelectedTrip(tripId: string | null): void {
    if (this.disposed) return;
    this.selectedTripId = tripId && tripId.length > 0 ? tripId : null;
    if (!this.selectionMesh && this.selectedTripId) {
      const material = new THREE.MeshBasicMaterial({
        color: SELECTION_COLOR,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      material.name = 'IsometricMinskMobilitySelection';
      const mesh = new THREE.Mesh(this.shadowGeometry, material);
      mesh.name = 'mobility-selection';
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      this.selectionMesh = mesh;
      // Кладём в vehicleRoot: метка видна ровно тогда, когда виден транспорт,
      // и не зависит от выключенных теней на mobile.
      this.vehicleRoot.add(mesh);
    }
  }

  /** id выбранного рейса (`null`, если ничего не выбрано). */
  getSelectedTrip(): string | null {
    return this.selectedTripId;
  }

  /** Сводка последнего кадра: для UI, QA и тестов. */
  getStats(): MobilityLayerStats {
    let vehicleTriangles = 0;
    let vehicleBatches = 0;
    let instanceBytes = 0;
    let drawCalls = 0;
    for (const [model, mesh] of this.vehicleMeshes) {
      if (mesh.count > 0 && mesh.visible) {
        vehicleBatches += 1;
        vehicleTriangles += (this.vehicleTriangles.get(model) ?? 0) * mesh.count;
        drawCalls += 1;
      }
      instanceBytes += mesh.instanceMatrix.array.byteLength;
      instanceBytes += mesh.instanceColor?.array.byteLength ?? 0;
    }
    let signalTriangles = 0;
    let signalBatches = 0;
    for (const mesh of this.signalMeshList()) {
      instanceBytes += mesh.instanceMatrix.array.byteLength;
      instanceBytes += mesh.instanceColor?.array.byteLength ?? 0;
      const triangles = this.signalBatchTriangles.get(mesh.name) ?? 0;
      if (mesh.count > 0 && mesh.visible) {
        signalBatches += 1;
        signalTriangles += triangles * mesh.count;
        drawCalls += 1;
      }
    }
    if (this.shadowMesh.count > 0 && this.shadowMesh.visible) drawCalls += 1;
    instanceBytes += this.shadowMesh.instanceMatrix.array.byteLength;
    return {
      budget: this.budget,
      trips: this.vehicleSummary.trips,
      drawnTrips: this.vehicleSummary.drawn,
      hiddenByLod: this.vehicleSummary.hiddenByLod,
      hiddenByBudget: this.vehicleSummary.hiddenByBudget,
      finishedTrips: this.vehicleSummary.finished,
      offscreenTrips: this.vehicleSummary.offscreen,
      dots: this.vehicleSummary.dots,
    drawnTripIds: [...this.vehicleSummary.drawnTripIds],
      vehicleBatches,
      vehicleTriangles,
      shadowInstances: this.shadowMesh.visible ? this.shadowMesh.count : 0,
      shadowsEnabled: this.shadowsEnabled,
      signalNodes: this.signalSummary.nodes,
      signalNodesDrawn: this.signalSummary.nodesDrawn,
      signalHeadsDrawn: this.signalSummary.headsDrawn,
      unknownAspects: this.signalSummary.unknownAspects,
      signalTruncated: this.signalSummary.truncated,
      signalBatches,
      signalTriangles,
      templateBytes: this.templates.bytes + signalGeometryBytes(this.signalTemplates),
      instanceBytes,
      drawCalls,
    };
  }

  /** Освобождает все геометрии, материалы и инстанс-буферы; повторный вызов безопасен. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.vehicleMeshes.values()) disposeVehicleInstances(mesh);
    this.vehicleMeshes.clear();
    this.vehicleTriangles.clear();
    this.disposeSignalBatches();
    this.shadowRoot.remove(this.shadowMesh);
    this.shadowMesh.dispose();
    if (this.dotMesh) {
      this.vehicleRoot.remove(this.dotMesh);
      this.dotMesh = null;
    }
    this.dotMaterial.dispose();
    this.shadowGeometry.dispose();
    this.shadowMaterial.dispose();
    this.vehicleMaterial.dispose();
    this.signalMaterial.dispose();
    this.lensMaterial.dispose();
    this.templates.dispose();
    disposeSignalGeometryTemplates(this.signalTemplates);
    this.root.clear();
    this.root.removeFromParent();
    this.tripStates.clear();
    this.signalLod.clear();
    this.signalNodes = [];
    this.signalInstances.length = 0;
    this.aspectLookup.clear();
    this.vehicleSummary = {
      trips: 0,
      drawn: 0,
      hiddenByLod: 0,
      hiddenByBudget: 0,
      finished: 0,
      offscreen: 0,
      drawnTripIds: [],
      dots: 0,
    };
    this.signalSummary = {
      nodes: 0,
      nodesDrawn: 0,
      headsDrawn: 0,
      unknownAspects: 0,
      truncated: 0,
    };
  }

  // -------------------------------------------------------------------------
  // транспорт: интерполяция, LOD, бюджет
  // -------------------------------------------------------------------------

  private updateVehicles(view: MobilityView, stepDt: number): void {
    const summary: VehicleFrameSummary = {
      trips: view.trips.length,
      drawn: 0,
      hiddenByLod: 0,
      hiddenByBudget: 0,
      finished: 0,
      offscreen: 0,
      drawnTripIds: [],
      dots: 0,
    };
    this.vehicleSummary = summary;
    this.frameSerial += 1;
    const serial = this.frameSerial;

    if (!this.settings.vehiclesVisible) {
      this.hideVehicles();
      this.vehiclesWereHidden = true;
      if (this.selectionMesh) this.selectionMesh.visible = false;
      return;
    }
    const forceSnap = this.vehiclesWereHidden;
    this.vehiclesWereHidden = false;

    const wpp = finitePositive(view.worldPerPixel) ? view.worldPerPixel : 1;
    const centreX = (view.rect.minX + view.rect.maxX) * 0.5;
    const centreZ = (view.rect.minZ + view.rect.maxZ) * 0.5;
    const debug = this.settings.debug;
    const enterPx = debug ? 0 : MOBILITY_LOD.vehicleEnterPx;
    const exitPx = debug ? 0 : MOBILITY_LOD.vehicleExitPx;

    // Шаг симуляции: явный номер шага, иначе — заметное изменение позы рейса.
    let stepChanged = false;
    if (view.step !== undefined) {
      stepChanged = this.lastStep !== null && view.step !== this.lastStep;
      this.lastStep = view.step;
    } else if (!forceSnap) {
      for (const trip of view.trips) {
        const state = this.tripStates.get(trip.tripId);
        if (!state) continue;
        if (
          Math.abs(trip.x - state.x) > 1e-4 ||
          Math.abs(trip.y - state.y) > 1e-4 ||
          Math.abs(trip.h - state.h) > 1e-4 ||
          Math.abs(trip.heading - state.heading) > 1e-4
        ) {
          stepChanged = true;
          break;
        }
      }
    }

    for (const trip of view.trips) {
      if (!trip || typeof trip.tripId !== 'string') continue;
      let state = this.tripStates.get(trip.tripId);
      if (!state) {
        state = {
          x: trip.x,
          y: trip.y,
          h: trip.h,
          heading: trip.heading,
          prevX: trip.x,
          prevY: trip.y,
          prevH: trip.h,
          prevHeading: trip.heading,
          alpha: 1,
          lodVisible: false,
          drawn: false,
          lastSeen: serial,
        };
        this.tripStates.set(trip.tripId, state);
      } else if (forceSnap) {
        state.x = state.prevX = trip.x;
        state.y = state.prevY = trip.y;
        state.h = state.prevH = trip.h;
        state.heading = state.prevHeading = trip.heading;
        state.alpha = 1;
      } else if (stepChanged) {
        const jump = Math.hypot(trip.x - state.x, trip.y - state.y);
        if (jump > MAX_INTERPOLATION_STEP_M) {
          // Переинициализация/смена даты: интерполировать через весь город нельзя.
          state.x = state.prevX = trip.x;
          state.y = state.prevY = trip.y;
          state.h = state.prevH = trip.h;
          state.heading = state.prevHeading = trip.heading;
          state.alpha = 1;
        } else {
          state.prevX = state.x;
          state.prevY = state.y;
          state.prevH = state.h;
          state.prevHeading = state.heading;
          state.x = trip.x;
          state.y = trip.y;
          state.h = trip.h;
          state.heading = trip.heading;
          state.alpha = 0;
        }
      }
      state.lastSeen = serial;
      if (!this.settings.paused) {
        state.alpha = Math.min(1, state.alpha + stepDt / this.stepSeconds);
      }
    }
    this.pruneTripStates(serial);

    const candidates: { trip: MobilityTripSnapshot; model: VehicleModel; distance: number }[] = [];
    const dotCandidates: { trip: MobilityTripSnapshot; model: VehicleModel; distance: number }[] = [];
    for (const trip of view.trips) {
      if (!trip || typeof trip.tripId !== 'string') continue;
      if (!Number.isFinite(trip.x) || !Number.isFinite(trip.y) || !Number.isFinite(trip.h)) continue;
      if (trip.phase === 'finished') {
        summary.finished += 1;
        continue;
      }
      const model = trip.mode as VehicleModel;
      if (!VEHICLE_DIMENSIONS[model]) continue;
      const worldX = trip.x;
      const worldZ = -trip.y;
      if (
        worldX < view.rect.minX - VIEW_MARGIN_M ||
        worldX > view.rect.maxX + VIEW_MARGIN_M ||
        worldZ < view.rect.minZ - VIEW_MARGIN_M ||
        worldZ > view.rect.maxZ + VIEW_MARGIN_M
      ) {
        summary.offscreen += 1;
        const state = this.tripStates.get(trip.tripId);
        if (state) state.drawn = false;
        continue;
      }
      const state = this.tripStates.get(trip.tripId);
      if (!state) continue;
      const projectedPx = VEHICLE_DIMENSIONS[model].lengthM / wpp;
      state.lodVisible = state.lodVisible ? projectedPx >= exitPx : projectedPx >= enterPx;
      if (!state.lodVisible) {
        summary.hiddenByLod += 1;
        // Слишком мелко для модели — рисуем точку, а не прячем транспорт.
        dotCandidates.push({
          trip,
          model,
          distance: Math.hypot(worldX - centreX, worldZ - centreZ),
        });
        state.drawn = false;
        continue;
      }
      candidates.push({
        trip,
        model,
        distance: Math.hypot(worldX - centreX, worldZ - centreZ),
      });
    }

    candidates.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.trip.tripId < b.trip.tripId ? -1 : a.trip.tripId > b.trip.tripId ? 1 : 0;
    });
    const allowed = candidates.slice(0, this.budget);
    summary.hiddenByBudget = Math.max(0, candidates.length - allowed.length);
    for (const candidate of candidates.slice(this.budget)) {
      const state = this.tripStates.get(candidate.trip.tripId);
      if (state) state.drawn = false;
    }

    const counts = new Map<VehicleModel, number>();
    for (const model of VEHICLE_MODELS) counts.set(model, 0);
    let selectionPlaced = false;
    let shadowCount = 0;
    for (const candidate of allowed) {
      const state = this.tripStates.get(candidate.trip.tripId);
      if (!state) continue;
      const alpha = state.alpha;
      const localX = lerp(state.prevX, state.x, alpha);
      const localY = lerp(state.prevY, state.y, alpha);
      const height = lerp(state.prevH, state.h, alpha);
      const heading = lerpAngle(state.prevHeading, state.heading, alpha);
      this.tmpPosition.set(localX, height + MOBILITY_VEHICLE_LIFT_M, -localY);
      this.tmpQuaternion.setFromAxisAngle(UP, heading);
      this.tmpMatrix.compose(this.tmpPosition, this.tmpQuaternion, this.one);
      const mesh = this.vehicleMeshes.get(candidate.model);
      if (!mesh) continue;
      const index = counts.get(candidate.model) ?? 0;
      mesh.setMatrixAt(index, this.tmpMatrix);
      vehicleTintColor(candidate.model, candidate.trip.tripId, this.tmpColor);
      const isSelected =
        this.selectedTripId !== null && candidate.trip.tripId === this.selectedTripId;
      if (isSelected) this.tmpColor.lerp(SELECTION_TINT, 0.62);
      mesh.setColorAt(index, this.tmpColor);
      counts.set(candidate.model, index + 1);

      if (isSelected && this.selectionMesh) {
        // Яркая метка под выбранным кузовом: выделение читается и в обзоре,
        // где сам автобус занимает пару пикселей.
        const markerScale = this.tmpScale.set(
          VEHICLE_DIMENSIONS[candidate.model].lengthM * 1.3,
          1,
          VEHICLE_DIMENSIONS[candidate.model].widthM * 1.7,
        );
        this.tmpPosition.set(localX, height + MOBILITY_VEHICLE_LIFT_M + 0.05, -localY);
        this.tmpMatrix.compose(this.tmpPosition, this.tmpQuaternion, markerScale);
        this.selectionMesh.matrix.copy(this.tmpMatrix);
        this.selectionMesh.matrixWorldNeedsUpdate = true;
        this.selectionMesh.visible = true;
        selectionPlaced = true;
      }

      if (this.shadowsEnabled && shadowCount < this.budget) {
        const shadowScale = this.tmpScale.set(
          VEHICLE_DIMENSIONS[candidate.model].lengthM * 0.92,
          1,
          VEHICLE_DIMENSIONS[candidate.model].widthM * 0.88,
        );
        this.tmpPosition.set(localX, height + SHADOW_LIFT_M, -localY);
        this.tmpMatrix.compose(this.tmpPosition, this.tmpQuaternion, shadowScale);
        this.shadowMesh.setMatrixAt(shadowCount, this.tmpMatrix);
        shadowCount += 1;
      }

      state.drawn = true;
      summary.drawnTripIds.push(candidate.trip.tripId);
    }

    // Точки для всего, что не влезло в экранный LOD: на обзоре город остаётся
    // живым (движущиеся точки), при этом бюджет и логическая фаза сохраняются.
    const dotMesh = this.dotMesh;
    if (dotMesh) {
      dotCandidates.sort((left, right) => left.distance - right.distance);
      const dotSize = Math.max(wpp * DOT_SIZE_PX, 2.0);
      let dotCount = 0;
      for (const candidate of dotCandidates) {
        if (dotCount >= DOT_BUDGET) break;
        const state = this.tripStates.get(candidate.trip.tripId);
        if (!state) continue;
        const alpha = state.alpha;
        const localX = lerp(state.prevX, state.x, alpha);
        const localY = lerp(state.prevY, state.y, alpha);
        const height = lerp(state.prevH, state.h, alpha);
        this.tmpPosition.set(localX, height + MOBILITY_VEHICLE_LIFT_M, -localY);
        this.tmpQuaternion.identity();
        this.tmpScale.set(dotSize, 1, dotSize);
        this.tmpMatrix.compose(this.tmpPosition, this.tmpQuaternion, this.tmpScale);
        dotMesh.setMatrixAt(dotCount, this.tmpMatrix);
        this.tmpColor.setHex(DOT_COLORS[candidate.trip.mode] ?? 0xffffff);
        dotMesh.setColorAt(dotCount, this.tmpColor);
        dotCount += 1;
        state.drawn = true;
        summary.drawnTripIds.push(candidate.trip.tripId);
      }
      dotMesh.count = dotCount;
      dotMesh.visible = dotCount > 0;
      summary.dots = dotCount;
      if (dotCount > 0) {
        dotMesh.instanceMatrix.needsUpdate = true;
        if (dotMesh.instanceColor) dotMesh.instanceColor.needsUpdate = true;
      }
    }

    summary.drawn = summary.drawnTripIds.length;
    if (this.selectionMesh && !selectionPlaced) this.selectionMesh.visible = false;

    for (const [model, mesh] of this.vehicleMeshes) {
      const count = counts.get(model) ?? 0;
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.computeBoundingBox();
      }
    }
    if (this.shadowsEnabled) {
      this.shadowMesh.count = shadowCount;
      this.shadowMesh.visible = shadowCount > 0;
      if (shadowCount > 0) {
        this.shadowMesh.instanceMatrix.needsUpdate = true;
        this.shadowMesh.computeBoundingSphere();
        this.shadowMesh.computeBoundingBox();
      }
    } else {
      this.shadowMesh.count = 0;
      this.shadowMesh.visible = false;
    }
  }

  private hideVehicles(): void {
    for (const mesh of this.vehicleMeshes.values()) {
      mesh.count = 0;
      mesh.visible = false;
    }
    this.shadowMesh.count = 0;
    this.shadowMesh.visible = false;
    if (this.dotMesh) {
      this.dotMesh.count = 0;
      this.dotMesh.visible = false;
    }
    for (const state of this.tripStates.values()) state.drawn = false;
  }

  private pruneTripStates(serial: number): void {
    if (this.tripStates.size <= 1024) return;
    for (const [tripId, state] of this.tripStates) {
      if (state.lastSeen < serial - 600) this.tripStates.delete(tripId);
    }
  }

  // -------------------------------------------------------------------------
  // светофоры: выбор узлов, аспекты, инстансы
  // -------------------------------------------------------------------------

  private updateSignals(view: MobilityView): void {
    const summary: SignalFrameSummary = {
      nodes: this.signalNodes.length,
      nodesDrawn: 0,
      headsDrawn: 0,
      unknownAspects: 0,
      truncated: 0,
    };
    this.signalSummary = summary;

    if (!this.settings.signalsVisible) {
      this.hideSignals();
      return;
    }
    if (!this.signalSource) {
      this.hideSignals();
      return;
    }
    const revision = this.signalSource.revision;
    if (revision !== this.lastSignalRevision) {
      this.lastSignalRevision = revision;
      this.signalNodes = this.signalSource.getSignalNodes();
      summary.nodes = this.signalNodes.length;
      this.pruneSignalLod();
    }

    const wpp = this.lastWorldPerPixel;
    const debug = this.settings.debug;
    if (Number.isFinite(wpp)) {
      const enter = debug ? Number.POSITIVE_INFINITY : MOBILITY_LOD.signalEnterWpp;
      const exit = debug ? Number.POSITIVE_INFINITY : MOBILITY_LOD.signalExitWpp;
      for (const node of this.signalNodes) {
        const wasVisible = this.signalLod.get(node.id) ?? false;
        const next = wasVisible ? wpp <= exit : wpp <= enter;
        this.signalLod.set(node.id, next);
      }
    }

    const centreX = (view.rect.minX + view.rect.maxX) * 0.5;
    const centreY = -(view.rect.minZ + view.rect.maxZ) * 0.5;
    const minLocalX = view.rect.minX - SIGNAL_VIEW_MARGIN_M;
    const maxLocalX = view.rect.maxX + SIGNAL_VIEW_MARGIN_M;
    const minLocalY = -view.rect.maxZ - SIGNAL_VIEW_MARGIN_M;
    const maxLocalY = -view.rect.minZ + SIGNAL_VIEW_MARGIN_M;

    const candidates = this.signalNodeCandidates;
    candidates.length = 0;
    for (const node of this.signalNodes) {
      if (!node.heads || node.heads.length === 0) continue;
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
      if (node.x < minLocalX || node.x > maxLocalX || node.y < minLocalY || node.y > maxLocalY) continue;
      if (!(this.signalLod.get(node.id) ?? false)) continue;
      candidates.push({ node, distance: Math.hypot(node.x - centreX, node.y - centreY) });
    }
    candidates.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
    });
    const selected = candidates.slice(0, this.maxSignalNodes);
    summary.nodesDrawn = selected.length;

    this.aspectLookup.clear();
    for (const signal of view.signals ?? []) {
      if (signal && typeof signal.nodeId === 'string' && signal.aspects) {
        this.aspectLookup.set(signal.nodeId, signal.aspects);
      }
    }
    const selectedNodes = selected.map((candidate) => candidate.node);
    const instances = collectSignalHeadInstances(selectedNodes, this.aspectLookup, this.signalInstances);
    const maxInstances = this.maxSignalNodes * MAX_HEADS_PER_NODE;
    if (instances.length > maxInstances) {
      summary.truncated = instances.length - maxInstances;
      instances.length = maxInstances;
    }
    this.ensureSignalCapacity(instances.length);
    summary.headsDrawn = instances.length;

    const poleCounts = { value: 0 };
    const housingCounts = new Map<MobilityTrafficKind, number>([
      ['vehicle', 0],
      ['pedestrian', 0],
      ['tram', 0],
    ]);
    const lensCounts = new Map<MobilityTrafficKind, number>([
      ['vehicle', 0],
      ['pedestrian', 0],
      ['tram', 0],
    ]);
    const batches = this.signalBatches;

    for (const instance of instances) {
      // Стойка стоит на той поверхности, которую обслуживает: на мостовой деке
      // (groundHeightM > 0) она не должна проваливаться под проезжую часть.
      const baseY = MOBILITY_SIGNAL_BASE_Y + (instance.groundHeightM ?? 0);
      const poleHeight = signalPoleHeight(instance.kind, instance.heightM);
      const centreY = signalHeadCentreY(instance.kind, instance.heightM);
      this.tmpQuaternion.setFromAxisAngle(UP, instance.facing);
      this.tmpPosition.set(instance.x, baseY, -instance.y);
      this.tmpScale.set(1, poleHeight, 1);
      this.tmpMatrix.compose(this.tmpPosition, this.tmpQuaternion, this.tmpScale);
      batches.pole.setMatrixAt(poleCounts.value, this.tmpMatrix);
      poleCounts.value += 1;

      this.tmpPosition.set(instance.x, baseY + centreY, -instance.y);
      this.tmpScale.set(1, 1, 1);
      const headMatrix = this.tmpLensMatrix.compose(this.tmpPosition, this.tmpQuaternion, this.tmpScale);
      const housing = batches.housing.get(instance.kind);
      if (housing) {
        const index = housingCounts.get(instance.kind) ?? 0;
        housing.setMatrixAt(index, headMatrix);
        housingCounts.set(instance.kind, index + 1);
      }
      const lens = batches.lens.get(instance.kind);
      if (lens) {
        const slot = signalLensSlot(instance.kind, instance.aspect);
        const offset = this.tmpOffsetMatrix.makeTranslation(
          -signalLensFrontOffset(instance.kind),
          slot.y,
          0,
        );
        const scale = this.tmpScaleMatrix.makeScale(1, slot.size, slot.size);
        this.tmpMatrix.copy(headMatrix).multiply(offset).multiply(scale);
        const index = lensCounts.get(instance.kind) ?? 0;
        lens.setMatrixAt(index, this.tmpMatrix);
        this.tmpColor.setStyle(SIGNAL_ASPECT_COLORS[instance.aspect]);
        lens.setColorAt(index, this.tmpColor);
        lensCounts.set(instance.kind, index + 1);
      }
      if (!instance.aspectKnown) summary.unknownAspects += 1;
    }

    this.commitSignalBatch(batches.pole, poleCounts.value);
    for (const kind of ['vehicle', 'pedestrian', 'tram'] as const) {
      const housing = batches.housing.get(kind);
      if (housing) this.commitSignalBatch(housing, housingCounts.get(kind) ?? 0);
      const lens = batches.lens.get(kind);
      if (lens) this.commitSignalBatch(lens, lensCounts.get(kind) ?? 0, true);
    }
    this.signalRoot.visible = true;
  }

  private commitSignalBatch(mesh: THREE.InstancedMesh, count: number, colours = false): void {
    mesh.count = count;
    mesh.visible = count > 0;
    if (count > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (colours && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.computeBoundingBox();
    }
  }

  private hideSignals(): void {
    for (const mesh of this.signalMeshList()) {
      mesh.count = 0;
      mesh.visible = false;
    }
    this.signalSummary.nodesDrawn = 0;
    this.signalSummary.headsDrawn = 0;
  }

  private signalMeshList(): THREE.InstancedMesh[] {
    const meshes: THREE.InstancedMesh[] = [this.signalBatches.pole];
    for (const mesh of this.signalBatches.housing.values()) meshes.push(mesh);
    for (const mesh of this.signalBatches.lens.values()) meshes.push(mesh);
    return meshes;
  }

  private pruneSignalLod(): void {
    if (this.signalLod.size <= this.signalNodes.length * 2) return;
    const alive = new Set(this.signalNodes.map((node) => node.id));
    for (const id of this.signalLod.keys()) {
      if (!alive.has(id)) this.signalLod.delete(id);
    }
  }

  private signalCapacityFor(size: number): number {
    return Math.max(8, Math.ceil(size));
  }

  private ensureSignalCapacity(needed: number): void {
    if (needed <= this.signalBatches.capacity) return;
    const next = this.signalCapacityFor(Math.ceil(this.signalBatches.capacity * 1.5) + needed);
    this.disposeSignalBatches();
    this.signalBatches = this.createSignalBatches(next);
  }

  // -------------------------------------------------------------------------
  // создание/освобождение батчей
  // -------------------------------------------------------------------------

  private createShadowMesh(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.shadowGeometry, this.shadowMaterial, Math.max(1, capacity));
    mesh.name = 'mobility-shadow-batch';
    mesh.count = 0;
    mesh.visible = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.boundingSphere = null;
    mesh.boundingBox = null;
    return mesh;
  }

  private createSignalBatches(capacity: number): SignalBatchSet {
    const safeCapacity = Math.max(1, Math.floor(capacity));
    const make = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      name: string,
      withColor: boolean,
    ): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(geometry, material, safeCapacity);
      mesh.name = name;
      mesh.count = 0;
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (withColor) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(safeCapacity * 3).fill(1),
          3,
        );
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      mesh.boundingSphere = null;
      mesh.boundingBox = null;
      this.signalRoot.add(mesh);
      return mesh;
    };
    const pole = make(this.signalTemplates.pole, this.signalMaterial, 'mobility-signal-poles', false);
    this.signalBatchTriangles.set(pole.name, geometryTriangleCount(this.signalTemplates.pole));
    const housing = new Map<MobilityTrafficKind, THREE.InstancedMesh>();
    const lens = new Map<MobilityTrafficKind, THREE.InstancedMesh>();
    for (const kind of ['vehicle', 'pedestrian', 'tram'] as const) {
      const housingGeometry = this.signalTemplates.housing[kind];
      const housingMesh = make(housingGeometry, this.signalMaterial, `mobility-signal-housing-${kind}`, false);
      this.signalBatchTriangles.set(
        housingMesh.name,
        geometryTriangleCount(housingGeometry),
      );
      housing.set(kind, housingMesh);
      const lensMesh = make(this.signalTemplates.lens, this.lensMaterial, `mobility-signal-lens-${kind}`, true);
      this.signalBatchTriangles.set(
        lensMesh.name,
        geometryTriangleCount(this.signalTemplates.lens),
      );
      lens.set(kind, lensMesh);
    }
    return { pole, housing, lens, capacity: safeCapacity };
  }

  private disposeSignalBatches(): void {
    for (const mesh of this.signalMeshList()) {
      mesh.removeFromParent();
      mesh.dispose();
      mesh.instanceColor = null;
      mesh.boundingSphere = null;
      mesh.boundingBox = null;
      mesh.count = 0;
    }
    this.signalBatchTriangles.clear();
  }

  private applyVisibility(): void {
    this.vehicleRoot.visible = this.settings.vehiclesVisible;
    this.shadowRoot.visible = this.settings.vehiclesVisible && this.shadowsEnabled;
    this.signalRoot.visible = this.settings.signalsVisible;
  }
}
