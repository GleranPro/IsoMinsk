/**
 * Isometric Minsk — процедурные low-poly модели общественного транспорта.
 *
 * Один цельный кузов на модель: автобус (~12 м), троллейбус со штангами
 * (~12 м) и трамвайный вагон (~15 м). Модели сознательно стилизованы под
 * pixel-art: силуэт, тёмная полоса остекления, колёса/обтекатели, юбка и
 * табло — без отдельных материалов, текстур и мешей на деталь.
 *
 * Оси модели: +X — направление движения, +Y — вверх, +Z — правый борт.
 * Геометрия центрирована по длине и ширине; низ колёс на y = 0, поэтому
 * экземпляр ставится на высоту дорожного покрытия без дополнительной подгонки.
 *
 * Цвета запечены в vertex colors (линейное пространство). Кузовные грани
 * оставлены почти белыми: цвет конкретной машины задаётся `instanceColor`
 * (см. `vehicleTintColor`), который умножается на вершины. Тёмные детали
 * (стёкла, колёса, юбка) при умножении остаются тёмными, поэтому ливрея не
 * разрушает силуэт — это осознанное ограничение общей палитры.
 */

import * as THREE from 'three';
import {
  FLAT_FACE_SHADE,
  SurfaceBuilder,
  geometryByteLength,
  geometryTriangleCount,
  linearRgb,
  scaleRgb,
  type LinearRgb,
} from './lowPoly';

/** Модели первого этапа: цельный автобус, троллейбус и трамвайный вагон. */
export type VehicleModel = 'bus' | 'trolleybus' | 'tram';

export const VEHICLE_MODELS: readonly VehicleModel[] = ['bus', 'trolleybus', 'tram'];

/** Габариты моделей, метры (длина по +X, ширина по Z, высота по Y). */
export const VEHICLE_DIMENSIONS: Readonly<
  Record<VehicleModel, { lengthM: number; widthM: number; bodyHeightM: number; totalHeightM: number }>
> = {
  bus: { lengthM: 12, widthM: 2.5, bodyHeightM: 3.04, totalHeightM: 3.04 },
  trolleybus: { lengthM: 12, widthM: 2.5, bodyHeightM: 3.04, totalHeightM: 4.78 },
  tram: { lengthM: 15, widthM: 2.5, bodyHeightM: 3.5, totalHeightM: 4.42 },
};

/**
 * Бюджеты треугольников на шаблон. Значения подобраны с запасом ~15 % над
 * фактической моделью: тест `tests/unit/mobility/geometry.vehicles.test.ts`
 * не даёт силуэту незаметно разрастись.
 */
export const VEHICLE_TRIANGLE_BUDGET: Readonly<Record<VehicleModel, number>> = {
  bus: 200,
  trolleybus: 280,
  tram: 280,
};

/**
 * Ограниченная палитра ливрей: по три оттенка на модель. Это художественное
 * решение, а не сведения о реальном автопарке; источник данных о ливреях в
 * контракте отсутствует.
 */
export const MOBILITY_LIVERY: Readonly<Record<VehicleModel, readonly string[]>> = {
  bus: ['#d8a63c', '#c88f35', '#e0bb5f'],
  trolleybus: ['#d9d5c8', '#c7c3b6', '#e3dfd2'],
  tram: ['#b2493a', '#a34033', '#c05a47'],
};

/** Служебные цвета деталей (не ливрея). */
export const VEHICLE_DETAIL_COLORS = {
  glass: '#21262b',
  glassLight: '#2c343a',
  rubber: '#151514',
  wheelHub: '#57574f',
  skirt: '#35342e',
  underbody: '#232320',
  roofShade: '#c9c4b6',
  headlight: '#efe5c2',
  taillight: '#a7312a',
  board: '#d6d0b6',
  pole: '#5b5b57',
  poleShoe: '#7d7d74',
  bogie: '#2a2a27',
} as const;

const WHITE: LinearRgb = [1, 1, 1];
const GLASS = linearRgb(VEHICLE_DETAIL_COLORS.glass);
const GLASS_LIGHT = linearRgb(VEHICLE_DETAIL_COLORS.glassLight);
const RUBBER = linearRgb(VEHICLE_DETAIL_COLORS.rubber);
const WHEEL_HUB = linearRgb(VEHICLE_DETAIL_COLORS.wheelHub);
const SKIRT = linearRgb(VEHICLE_DETAIL_COLORS.skirt);
const UNDERBODY = linearRgb(VEHICLE_DETAIL_COLORS.underbody);
const ROOF = linearRgb(VEHICLE_DETAIL_COLORS.roofShade);
const HEADLIGHT = linearRgb(VEHICLE_DETAIL_COLORS.headlight);
const TAILLIGHT = linearRgb(VEHICLE_DETAIL_COLORS.taillight);
const BOARD = linearRgb(VEHICLE_DETAIL_COLORS.board);
const POLE = linearRgb(VEHICLE_DETAIL_COLORS.pole);
const POLE_SHOE = linearRgb(VEHICLE_DETAIL_COLORS.poleShoe);
const BOGIE = linearRgb(VEHICLE_DETAIL_COLORS.bogie);

const BUS_HALF_LENGTH = 6;
const BUS_HALF_WIDTH = 1.25;
const BUS_BOTTOM = 0.62;
const BUS_ROOF = 3.04;
const TRAM_HALF_LENGTH = 7.5;
const TRAM_HALF_WIDTH = 1.25;
const TRAM_BOTTOM = 0.55;
const TRAM_ROOF = 3.5;

/** Детерминированный хеш строки в диапазон [0, 1). */
function hashUnit(text: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash / 4294967296;
}

/** Индекс оттенка ливреи для конкретного рейса (детерминированный). */
export function vehicleLiveryIndex(model: VehicleModel, seed: string): number {
  const palette = MOBILITY_LIVERY[model];
  return Math.min(palette.length - 1, Math.floor(hashUnit(`${model}:${seed}`) * palette.length));
}

/** sRGB-hex ливреи конкретной машины (для QA и тестов). */
export function vehicleLiveryHex(model: VehicleModel, seed: string): string {
  return MOBILITY_LIVERY[model][vehicleLiveryIndex(model, seed)];
}

/**
 * Линейный цвет ливреи для `instanceColor`. Возвращает новый `THREE.Color`,
 * если цель не передана; `THREE.Color` сам переводит sRGB в рабочее пространство.
 */
export function vehicleTintColor(model: VehicleModel, seed: string, target = new THREE.Color()): THREE.Color {
  return target.setStyle(vehicleLiveryHex(model, seed));
}

/** Общий профиль кузова автобуса/троллейбуса в плоскости (z, y), против часовой. */
function busProfile(): readonly (readonly [number, number])[] {
  return [
    [-BUS_HALF_WIDTH, BUS_BOTTOM],
    [BUS_HALF_WIDTH, BUS_BOTTOM],
    [BUS_HALF_WIDTH, 2.7],
    [0.99, BUS_ROOF],
    [-0.99, BUS_ROOF],
    [-BUS_HALF_WIDTH, 2.7],
  ];
}

/** Окраска сторон профиля автобуса: низ тёмный, крыша светлее корпуса. */
function busSegmentColor(index: number): LinearRgb {
  if (index === 0) return UNDERBODY;
  if (index === 3) return ROOF;
  if (index === 2 || index === 4) return scaleRgb(WHITE, 0.9);
  return WHITE;
}

/** Полоса остекления, табло и светотехника общего кузова. */
function addBusDetails(builder: SurfaceBuilder): void {
  const halfW = BUS_HALF_WIDTH;
  const front = BUS_HALF_LENGTH;
  const back = -BUS_HALF_LENGTH;
  // Боковые окна — тонкие коробки чуть шире кузова, чтобы не мерцать на грани.
  builder.box([0, 2.16, halfW + 0.008], [10.8, 0.84, 0.02], GLASS, FLAT_FACE_SHADE);
  builder.box([0, 2.16, -halfW - 0.008], [10.8, 0.84, 0.02], GLASS, FLAT_FACE_SHADE);
  // Лобовое и заднее стекло в плоскостях торцов.
  builder.quad(
    [front + 0.006, 1.72, -1.06],
    [front + 0.006, 1.72, 1.06],
    [front + 0.006, 2.6, 1.06],
    [front + 0.006, 2.6, -1.06],
    [1, 0, 0],
    GLASS,
  );
  builder.quad(
    [back - 0.006, 1.78, -0.98],
    [back - 0.006, 1.78, 0.98],
    [back - 0.006, 2.56, 0.98],
    [back - 0.006, 2.56, -0.98],
    [-1, 0, 0],
    GLASS,
  );
  // Табло спереди и сзади — та же геометрия/материал, отдельного материала нет.
  builder.quad(
    [front + 0.012, 2.7, -0.86],
    [front + 0.012, 2.7, 0.86],
    [front + 0.012, 2.97, 0.86],
    [front + 0.012, 2.97, -0.86],
    [1, 0, 0],
    BOARD,
  );
  builder.quad(
    [back - 0.012, 2.72, -0.8],
    [back - 0.012, 2.72, 0.8],
    [back - 0.012, 2.96, 0.8],
    [back - 0.012, 2.96, -0.8],
    [-1, 0, 0],
    BOARD,
  );
  // Фары и задние фонари.
  for (const side of [-1, 1]) {
    const z = side * 0.82;
    builder.quad(
      [front + 0.008, 1.02, z - 0.16],
      [front + 0.008, 1.02, z + 0.16],
      [front + 0.008, 1.26, z + 0.16],
      [front + 0.008, 1.26, z - 0.16],
      [1, 0, 0],
      HEADLIGHT,
    );
    const rearZ = side * 0.92;
    builder.quad(
      [back - 0.008, 1.04, rearZ - 0.15],
      [back - 0.008, 1.04, rearZ + 0.15],
      [back - 0.008, 1.28, rearZ + 0.15],
      [back - 0.008, 1.28, rearZ - 0.15],
      [-1, 0, 0],
      TAILLIGHT,
    );
  }
}

/** Колёса автобуса/троллейбуса: четыре колеса, низ на y = 0. */
function addRoadWheels(builder: SurfaceBuilder): void {
  for (const axleX of [3.15, -3.15]) {
    for (const side of [-1, 1]) {
      builder.cylinderZ([axleX, 0.52, side * 1.09], 0.52, 0.16, 8, RUBBER, WHEEL_HUB);
    }
  }
}

function buildBus(builder: SurfaceBuilder): void {
  builder.loft(busProfile(), -BUS_HALF_LENGTH, BUS_HALF_LENGTH, busSegmentColor, {
    back: scaleRgb(WHITE, 0.86),
    front: WHITE,
  });
  addBusDetails(builder);
  addRoadWheels(builder);
}

function buildTrolleybus(builder: SurfaceBuilder): void {
  buildBus(builder);
  // Штанги: от крыши назад-вверх к контактной сети (точная сеть не моделируется).
  builder.box([-1.1, 3.12, 0], [1.5, 0.16, 1.45], scaleRgb(WHITE, 0.72), FLAT_FACE_SHADE);
  for (const side of [-1, 1]) {
    const z = side * 0.56;
    builder.rod([1.0, BUS_ROOF, z], [-2.0, 4.66, z], 0.055, POLE);
    builder.box([-2.02, 4.7, z], [0.24, 0.08, 0.16], POLE_SHOE, FLAT_FACE_SHADE);
  }
}

function buildTram(builder: SurfaceBuilder): void {
  const halfW = TRAM_HALF_WIDTH;
  const profile: readonly (readonly [number, number])[] = [
    [-halfW, TRAM_BOTTOM],
    [halfW, TRAM_BOTTOM],
    [halfW, 2.9],
    [1.02, 3.34],
    [0.4, TRAM_ROOF],
    [-0.4, TRAM_ROOF],
    [-1.02, 3.34],
    [-halfW, 2.9],
  ];
  builder.loft(
    profile,
    -TRAM_HALF_LENGTH,
    TRAM_HALF_LENGTH,
    (index) => {
      if (index === 0) return UNDERBODY;
      if (index === 3 || index === 4) return ROOF;
      if (index === 2 || index === 5) return scaleRgb(WHITE, 0.9);
      return WHITE;
    },
    { back: scaleRgb(WHITE, 0.86), front: WHITE },
  );
  // Боковые окна.
  builder.box([0, 2.2, halfW + 0.008], [13.2, 1.05, 0.02], GLASS, FLAT_FACE_SHADE);
  builder.box([0, 2.2, -halfW - 0.008], [13.2, 1.05, 0.02], GLASS, FLAT_FACE_SHADE);
  // Двери (тёмные вертикальные полосы поверх остекления) — по две на борт.
  for (const side of [-1, 1]) {
    for (const x of [-4.3, 1.9]) {
      const z = side * (halfW + 0.012);
      builder.quad(
        [x - 0.62, 0.95, z],
        [x + 0.62, 0.95, z],
        [x + 0.62, 3.0, z],
        [x - 0.62, 3.0, z],
        [0, 0, side],
        GLASS_LIGHT,
      );
    }
  }
  // Лобовое/заднее стекло и табло.
  builder.quad(
    [TRAM_HALF_LENGTH + 0.006, 1.45, -1.04],
    [TRAM_HALF_LENGTH + 0.006, 1.45, 1.04],
    [TRAM_HALF_LENGTH + 0.006, 2.95, 1.04],
    [TRAM_HALF_LENGTH + 0.006, 2.95, -1.04],
    [1, 0, 0],
    GLASS,
  );
  builder.quad(
    [-TRAM_HALF_LENGTH - 0.006, 1.5, -0.98],
    [-TRAM_HALF_LENGTH - 0.006, 1.5, 0.98],
    [-TRAM_HALF_LENGTH - 0.006, 2.9, 0.98],
    [-TRAM_HALF_LENGTH - 0.006, 2.9, -0.98],
    [-1, 0, 0],
    GLASS,
  );
  builder.quad(
    [TRAM_HALF_LENGTH + 0.014, 3.02, -0.82],
    [TRAM_HALF_LENGTH + 0.014, 3.02, 0.82],
    [TRAM_HALF_LENGTH + 0.014, 3.24, 0.82],
    [TRAM_HALF_LENGTH + 0.014, 3.24, -0.82],
    [1, 0, 0],
    BOARD,
  );
  // Тележки и колёсные пары скрыты под кузовом, но низ колёс виден по бокам.
  for (const x of [-4.1, 4.1]) {
    builder.box([x, 0.42, 0], [2.7, 0.45, 1.9], BOGIE, FLAT_FACE_SHADE);
    for (const side of [-1, 1]) {
      builder.cylinderZ([x, 0.34, side * 1.02], 0.34, 0.12, 8, RUBBER, WHEEL_HUB);
    }
  }
  // Фары и задние фонари.
  for (const side of [-1, 1]) {
    const z = side * 0.8;
    builder.quad(
      [TRAM_HALF_LENGTH + 0.008, 0.9, z - 0.14],
      [TRAM_HALF_LENGTH + 0.008, 0.9, z + 0.14],
      [TRAM_HALF_LENGTH + 0.008, 1.14, z + 0.14],
      [TRAM_HALF_LENGTH + 0.008, 1.14, z - 0.14],
      [1, 0, 0],
      HEADLIGHT,
    );
    builder.quad(
      [-TRAM_HALF_LENGTH - 0.008, 0.94, z - 0.13],
      [-TRAM_HALF_LENGTH - 0.008, 0.94, z + 0.13],
      [-TRAM_HALF_LENGTH - 0.008, 1.18, z + 0.13],
      [-TRAM_HALF_LENGTH - 0.008, 1.18, z - 0.13],
      [-1, 0, 0],
      TAILLIGHT,
    );
  }
  // Пантограф: два рычага-«ножницы» и контактная планка (условно, без проводов).
  builder.rod([-1.25, TRAM_ROOF, 0], [0, 4.28, 0], 0.06, POLE);
  builder.rod([1.25, TRAM_ROOF, 0], [0, 4.28, 0], 0.06, POLE);
  builder.box([0, 4.33, 0], [0.12, 0.1, 1.7], POLE, FLAT_FACE_SHADE);
}

/** Создаёт новый шаблон геометрии модели (владелец — вызывающий). */
export function createVehicleTemplate(model: VehicleModel): THREE.BufferGeometry {
  const builder = new SurfaceBuilder();
  if (model === 'bus') buildBus(builder);
  else if (model === 'trolleybus') buildTrolleybus(builder);
  else if (model === 'tram') buildTram(builder);
  else throw new Error(`неизвестная модель транспорта: ${String(model)}`);
  const geometry = builder.build();
  geometry.name = `mobility-vehicle-${model}`;
  return geometry;
}

/** Кеш общих шаблонов: инстансы разных тайлов/групп используют одну геометрию. */
export class VehicleTemplateCache {
  private readonly templates = new Map<VehicleModel, THREE.BufferGeometry>();

  get(model: VehicleModel): THREE.BufferGeometry {
    let geometry = this.templates.get(model);
    if (!geometry) {
      geometry = createVehicleTemplate(model);
      this.templates.set(model, geometry);
    }
    return geometry;
  }

  /** Число треугольников шаблона. */
  triangleCount(model: VehicleModel): number {
    return geometryTriangleCount(this.get(model));
  }

  /** Байты всех шаблонов (vertex positions + colors + normals). */
  get bytes(): number {
    let bytes = 0;
    for (const geometry of this.templates.values()) bytes += geometryByteLength(geometry);
    return bytes;
  }

  get size(): number {
    return this.templates.size;
  }

  dispose(): void {
    for (const geometry of this.templates.values()) geometry.dispose();
    this.templates.clear();
  }
}

/**
 * Инстанс-батч одной модели: одна `InstancedMesh` на модель и материал.
 *
 * `instanceColor` выделяется сразу, чтобы шейдер был собран с поддержкой
 * цветов экземпляров с первого кадра. Начальный `count = 0`; вызывающий
 * заполняет матрицы и выставляет `count`, после чего обязан пересчитать
 * `boundingSphere` (см. `mobilityLayer.ts`), иначе three.js будет отсекать
 * движущиеся экземпляры по устаревшим границам.
 */
export function createVehicleInstances(
  geometry: THREE.BufferGeometry,
  capacity: number,
  material: THREE.Material,
  label: string,
): THREE.InstancedMesh {
  const safeCapacity = Math.max(1, Math.floor(capacity));
  const mesh = new THREE.InstancedMesh(geometry, material, safeCapacity);
  mesh.name = `mobility-vehicle-${label}`;
  mesh.count = 0;
  mesh.visible = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(safeCapacity * 3).fill(1),
    3,
  );
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.boundingSphere = null;
  mesh.boundingBox = null;
  return mesh;
}

/** Освобождает GPU-буферы экземпляров (шаблон и материал принадлежат кешу/слою). */
export function disposeVehicleInstances(mesh: THREE.InstancedMesh): void {
  mesh.removeFromParent();
  mesh.dispose();
  mesh.instanceColor = null;
  mesh.boundingSphere = null;
  mesh.boundingBox = null;
  mesh.count = 0;
}

/** Удобная проверка габаритов модели в тестах и QA. */
export function vehicleBounds(model: VehicleModel): {
  lengthM: number;
  widthM: number;
  heightM: number;
  minY: number;
} {
  const geometry = createVehicleTemplate(model);
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox as THREE.Box3;
  const result = {
    lengthM: box.max.x - box.min.x,
    widthM: box.max.z - box.min.z,
    heightM: box.max.y - box.min.y,
    minY: box.min.y,
  };
  geometry.dispose();
  return result;
}
