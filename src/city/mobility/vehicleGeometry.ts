/**
 * Isometric Minsk — low-poly модели транспорта.
 *
 * Основной источник геометрии — Blender-модели из
 * `scripts/models/build_transport_models.py` (см. `vehiclePayload.ts`): ливреи
 * запечены в vertex colors по референсам Минсктранса (жёлтый МАЗ-203,
 * мятный МАЗ-203Т, бирюзовый АКСМ-60102, сине-оранжевый ЭР9М, зелёный ВЛ80).
 * Функции ниже строят упрощённый процедурный fallback тех же габаритов: он
 * работает до загрузки payload и при его отсутствии.
 *
 * Оси модели: +X — направление движения, +Y — вверх, +Z — правый борт.
 * Геометрия центрирована по длине и ширине; низ колёс на y = 0, поэтому
 * экземпляр ставится на высоту дорожного покрытия без дополнительной подгонки.
 *
 * Цвета запечены в vertex colors (линейное пространство). Кузовные грани
 * fallback-моделей остаются почти белыми, поэтому `instanceColor` с белым
 * ливрейным оттенком (`MOBILITY_LIVERY`) не меняет их вид, а тёмные детали
 * (стёкла, колёса, юбка) при умножении остаются тёмными.
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

/**
 * Шаблоны транспорта. `bus`/`trolleybus`/`tram` совпадают с `MobilityMode` и
 * приходят из расписания; четыре ж/д шаблона используются фоновым слоем
 * поездов (`src/engine/rail`).
 */
export type VehicleModel = 'bus' | 'trolleybus' | 'tram' | 'commuterLead' | 'commuterCar' | 'freightLoco' | 'freightWagon';

/** Шаблоны, управляемые расписанием (`MobilityMode`). */
export type TransitVehicleModel = 'bus' | 'trolleybus' | 'tram';

export const TRANSIT_VEHICLE_MODELS: readonly TransitVehicleModel[] = ['bus', 'trolleybus', 'tram'];

export const RAIL_VEHICLE_MODELS: readonly Exclude<VehicleModel, TransitVehicleModel>[] = [
  'commuterLead',
  'commuterCar',
  'freightLoco',
  'freightWagon',
];

export const VEHICLE_MODELS: readonly VehicleModel[] = [
  ...TRANSIT_VEHICLE_MODELS,
  ...RAIL_VEHICLE_MODELS,
];

/** Габариты моделей, метры (длина по +X, ширина по Z, высота по Y). */
export const VEHICLE_DIMENSIONS: Readonly<
  Record<VehicleModel, { lengthM: number; widthM: number; bodyHeightM: number; totalHeightM: number }>
> = {
  bus: { lengthM: 12.2, widthM: 2.5, bodyHeightM: 3.18, totalHeightM: 3.53 },
  trolleybus: { lengthM: 12.2, widthM: 2.5, bodyHeightM: 3.18, totalHeightM: 4.76 },
  tram: { lengthM: 15.6, widthM: 2.5, bodyHeightM: 3.62, totalHeightM: 4.99 },
  commuterLead: { lengthM: 24.5, widthM: 3.45, bodyHeightM: 4.22, totalHeightM: 4.4 },
  commuterCar: { lengthM: 24.5, widthM: 3.45, bodyHeightM: 4.22, totalHeightM: 5.41 },
  freightLoco: { lengthM: 19.1, widthM: 2.95, bodyHeightM: 4.05, totalHeightM: 5.22 },
  freightWagon: { lengthM: 14.4, widthM: 3.0, bodyHeightM: 3.21, totalHeightM: 3.35 },
};

/**
 * Бюджеты треугольников на шаблон: совпадают с бюджетами Blender-моделей.
 * Тест `tests/unit/mobility/geometry.vehicles.test.ts` не даёт силуэту
 * незаметно разрастись.
 */
export const VEHICLE_TRIANGLE_BUDGET: Readonly<Record<VehicleModel, number>> = {
  bus: 1100,
  trolleybus: 1250,
  tram: 900,
  commuterLead: 900,
  commuterCar: 780,
  freightLoco: 1200,
  freightWagon: 900,
};

/**
 * Ливрея: цвет `instanceColor`. Основные ливреи (жёлтый автобус, мятный
 * троллейбус, бирюзовый трамвай, синий ЭР9, зелёный ВЛ80) запечены в vertex
 * colors Blender-моделей, поэтому tint остаётся белым. Палитра из одного
 * оттенка сохраняет контракт `vehicleTintColor` для выделения рейса.
 */
export const MOBILITY_LIVERY: Readonly<Record<VehicleModel, readonly string[]>> = {
  bus: ['#ffffff'],
  trolleybus: ['#ffffff'],
  tram: ['#ffffff'],
  commuterLead: ['#ffffff'],
  commuterCar: ['#ffffff'],
  freightLoco: ['#ffffff'],
  freightWagon: ['#ffffff'],
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

/** Ливреи Минсктранса для процедурного fallback (ср. Blender-модели). */
const BUS_YELLOW = linearRgb('#e9b900');
const TROLLEY_MINT = linearRgb('#c9d9c7');
const TRAM_TEAL = linearRgb('#35b4ad');
const ER9_BLUE = linearRgb('#2f5f9e');
const ER9_LIGHT = linearRgb('#c7d4dc');
const ER9_ORANGE = linearRgb('#e87722');
const LOCO_GREEN = linearRgb('#2f5a3a');
const WAGON_BROWN = linearRgb('#5a4a3c');

const BUS_HALF_LENGTH = 6.1;
const BUS_HALF_WIDTH = 1.25;
const BUS_BOTTOM = 0.62;
const BUS_ROOF = 3.04;
const TRAM_HALF_LENGTH = 7.8;
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

/**
 * Окраска сторон профиля кузова: низ тёмный, крыша чуть темнее корпуса,
 * борта — цвет ливреи.
 */
function bodySegmentColor(body: LinearRgb): (index: number) => LinearRgb {
  return (index: number) => {
    if (index === 0) return UNDERBODY;
    if (index === 3) return scaleRgb(body, 0.86);
    if (index === 2 || index === 4) return scaleRgb(body, 0.92);
    return body;
  };
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
  builder.loft(busProfile(), -BUS_HALF_LENGTH, BUS_HALF_LENGTH, bodySegmentColor(BUS_YELLOW), {
    back: scaleRgb(BUS_YELLOW, 0.86),
    front: BUS_YELLOW,
  });
  addBusDetails(builder);
  addRoadWheels(builder);
}

function buildTrolleybus(builder: SurfaceBuilder): void {
  builder.loft(busProfile(), -BUS_HALF_LENGTH, BUS_HALF_LENGTH, bodySegmentColor(TROLLEY_MINT), {
    back: scaleRgb(TROLLEY_MINT, 0.86),
    front: TROLLEY_MINT,
  });
  addBusDetails(builder);
  addRoadWheels(builder);
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
    bodySegmentColor(TRAM_TEAL),
    { back: scaleRgb(TRAM_TEAL, 0.86), front: TRAM_TEAL },
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

// ---------------------------------------------------------------------------
// ж/д fallback: упрощённые вагоны ЭР9 и грузового состава
// ---------------------------------------------------------------------------
const CAR_HALF_LENGTH = 12.25;
const CAR_HALF_WIDTH = 1.725;
const CAR_BOTTOM = 1.02;
const CAR_ROOF = 4.22;
const CAR_PROFILE: readonly (readonly [number, number])[] = [
  [-CAR_HALF_WIDTH, CAR_BOTTOM],
  [CAR_HALF_WIDTH, CAR_BOTTOM],
  [CAR_HALF_WIDTH, 3.3],
  [CAR_HALF_WIDTH * 0.9, 3.8],
  [CAR_HALF_WIDTH * 0.45, CAR_ROOF],
  [-CAR_HALF_WIDTH * 0.45, CAR_ROOF],
  [-CAR_HALF_WIDTH * 0.9, 3.8],
  [-CAR_HALF_WIDTH, 3.3],
];

function carSegmentColor(index: number): LinearRgb {
  if (index === 0) return UNDERBODY;
  if (index === 1 || index === 7) return ER9_BLUE;
  if (index === 3 || index === 4 || index === 5) return scaleRgb(ROOF, 0.86);
  return ER9_LIGHT;
}

function addRailWheels(builder: SurfaceBuilder, axles: readonly number[], radius = 0.46): void {
  for (const axleX of axles) {
    for (const side of [-1, 1]) {
      // 8 сегментов: вершина ровно в точке контакта с рельсом (y = 0).
      builder.cylinderZ([axleX, radius, side * 1.18], radius, 0.12, 8, RUBBER, WHEEL_HUB);
    }
  }
}

function addCommuterDetails(builder: SurfaceBuilder): void {
  const halfW = CAR_HALF_WIDTH;
  // Сплошная тёмная полоса остекления с светлыми простенками.
  builder.box([0, 2.7, halfW + 0.01], [21.6, 0.95, 0.03], GLASS, FLAT_FACE_SHADE);
  builder.box([0, 2.7, -halfW - 0.01], [21.6, 0.95, 0.03], GLASS, FLAT_FACE_SHADE);
  // Оранжевая полоса ЭР9 под окнами.
  builder.box([0, 2.14, halfW + 0.014], [23.6, 0.14, 0.02], ER9_ORANGE, FLAT_FACE_SHADE);
  for (const x of [-6.9, 6.9]) {
    for (const side of [-1, 1]) {
      const z = side * (halfW + 0.016);
      builder.quad(
        [x - 0.75, 0.98, z],
        [x + 0.75, 0.98, z],
        [x + 0.75, 3.2, z],
        [x - 0.75, 3.2, z],
        [0, 0, side],
        GLASS,
      );
    }
  }
  // Тележки.
  for (const x of [-8.7, 8.7]) {
    builder.box([x, 0.55, 0], [3.0, 0.5, 2.3], BOGIE, FLAT_FACE_SHADE);
  }
  addRailWheels(builder, [-9.75, -7.65, 7.65, 9.75]);
}

function buildCommuterLead(builder: SurfaceBuilder): void {
  builder.loft(CAR_PROFILE, -CAR_HALF_LENGTH, CAR_HALF_LENGTH, carSegmentColor, {
    back: scaleRgb(ER9_LIGHT, 0.86),
    front: ER9_LIGHT,
  });
  addCommuterDetails(builder);
  // Синяя маска кабины и лобовое стекло.
  builder.quad(
    [CAR_HALF_LENGTH + 0.006, 1.05, -1.4],
    [CAR_HALF_LENGTH + 0.006, 1.05, 1.4],
    [CAR_HALF_LENGTH + 0.006, 2.95, 1.4],
    [CAR_HALF_LENGTH + 0.006, 2.95, -1.4],
    [1, 0, 0],
    ER9_BLUE,
  );
  builder.quad(
    [CAR_HALF_LENGTH + 0.012, 2.3, -1.3],
    [CAR_HALF_LENGTH + 0.012, 2.3, 1.3],
    [CAR_HALF_LENGTH + 0.012, 3.5, 1.3],
    [CAR_HALF_LENGTH + 0.012, 3.5, -1.3],
    [1, 0, 0],
    GLASS,
  );
  for (const side of [-1, 1]) {
    const z = side * 1.1;
    builder.quad(
      [CAR_HALF_LENGTH + 0.02, 1.36, z - 0.09],
      [CAR_HALF_LENGTH + 0.02, 1.36, z + 0.09],
      [CAR_HALF_LENGTH + 0.02, 1.54, z + 0.09],
      [CAR_HALF_LENGTH + 0.02, 1.54, z - 0.09],
      [1, 0, 0],
      HEADLIGHT,
    );
  }
}

function buildCommuterCar(builder: SurfaceBuilder): void {
  buildCommuterLead(builder);
  // Пантограф на промежуточном вагоне.
  builder.box([-1.8, CAR_ROOF + 0.09, 0], [1.4, 0.18, 1.3], POLE_SHOE, FLAT_FACE_SHADE);
  builder.rod([-2.5, CAR_ROOF + 0.16, 0], [0, 5.15, 0], 0.055, POLE);
  builder.rod([-1.1, CAR_ROOF + 0.16, 0], [0, 5.15, 0], 0.055, POLE);
  builder.box([0, 5.2, 0], [0.1, 0.07, 1.55], POLE, FLAT_FACE_SHADE);
}

function buildFreightLoco(builder: SurfaceBuilder): void {
  const half = 9.5;
  const halfW = 1.55;
  // Рама, капот и две кабины ВЛ80.
  builder.box([0, 1.02, 0], [18.0, 0.44, 2.7], UNDERBODY, FLAT_FACE_SHADE);
  builder.box([0, 2.52, 0], [11.6, 2.2, 2.86], LOCO_GREEN);
  builder.box([0, 3.72, 0], [11.9, 0.22, 2.94], ROOF, FLAT_FACE_SHADE);
  for (const direction of [-1, 1]) {
    builder.box([direction * 7.9, 2.62, 0], [2.5, 2.85, 2.95], LOCO_GREEN);
    builder.quad(
      [direction * (half + 0.006), 2.3, -1.12],
      [direction * (half + 0.006), 2.3, 1.12],
      [direction * (half + 0.006), 3.3, 1.12],
      [direction * (half + 0.006), 3.3, -1.12],
      [direction, 0, 0],
      GLASS,
    );
    // Красная полоса на лобовой части.
    builder.quad(
      [direction * (half + 0.012), 1.08, -1.4],
      [direction * (half + 0.012), 1.08, 1.4],
      [direction * (half + 0.012), 1.38, 1.4],
      [direction * (half + 0.012), 1.38, -1.4],
      [direction, 0, 0],
      TAILLIGHT,
    );
    for (const side of [-1, 1]) {
      const z = side * 1.02;
      builder.quad(
        [direction * (half + 0.02), 1.34, z - 0.09],
        [direction * (half + 0.02), 1.34, z + 0.09],
        [direction * (half + 0.02), 1.52, z + 0.09],
        [direction * (half + 0.02), 1.52, z - 0.09],
        [direction, 0, 0],
        HEADLIGHT,
      );
    }
  }
  for (const x of [-5.6, 5.6]) {
    builder.box([x, 0.55, 0], [3.3, 0.5, 2.5], BOGIE, FLAT_FACE_SHADE);
  }
  addRailWheels(builder, [-6.75, -4.45, 4.45, 6.75], 0.52);
}

function buildFreightWagon(builder: SurfaceBuilder): void {
  const half = 7.25;
  const halfW = 1.5;
  builder.box([0, 1.02, 0], [14.0, 0.34, 2.7], UNDERBODY, FLAT_FACE_SHADE);
  builder.box([0, 2.26, 0], [13.5, 1.9, 2.98], WAGON_BROWN);
  // Чёрный верх читается как уголь в полувагоне.
  builder.box([0, 3.16, 0], [12.9, 0.06, 2.5], scaleRgb(UNDERBODY, 0.4), FLAT_FACE_SHADE);
  for (const direction of [-1, 1]) {
    builder.box([direction * (half - 0.2), 0.74, 0], [0.3, 0.28, 1.2], BOGIE, FLAT_FACE_SHADE);
    for (const side of [-1, 1]) {
      builder.box([direction * (half - 0.34), 0.98, side * 1.1], [0.3, 0.3, 0.3], BOGIE, FLAT_FACE_SHADE);
    }
  }
  for (const x of [-5.1, 5.1]) {
    builder.box([x, 0.52, 0], [2.85, 0.44, 2.5], BOGIE, FLAT_FACE_SHADE);
  }
  addRailWheels(builder, [-6.06, -4.14, 4.14, 6.06], 0.46);
}

/** Создаёт новый шаблон геометрии модели (владелец — вызывающий). */
export function createVehicleTemplate(model: VehicleModel): THREE.BufferGeometry {
  const builder = new SurfaceBuilder();
  if (model === 'bus') buildBus(builder);
  else if (model === 'trolleybus') buildTrolleybus(builder);
  else if (model === 'tram') buildTram(builder);
  else if (model === 'commuterLead') buildCommuterLead(builder);
  else if (model === 'commuterCar') buildCommuterCar(builder);
  else if (model === 'freightLoco') buildFreightLoco(builder);
  else if (model === 'freightWagon') buildFreightWagon(builder);
  else throw new Error(`неизвестная модель транспорта: ${String(model)}`);
  const geometry = builder.build();
  // Детали (фары, буферы) немного выступают за кузов: центрируем по X,
  // чтобы шаблон всегда был симметричен относительно локального нуля.
  geometry.computeBoundingBox();
  const box = geometry.boundingBox as THREE.Box3;
  geometry.translate(-(box.max.x + box.min.x) * 0.5, 0, 0);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.name = `mobility-vehicle-${model}`;
  return geometry;
}

/** Кеш общих шаблонов: инстансы разных тайлов/групп используют одну геометрию. */
export class VehicleTemplateCache {
  private readonly templates = new Map<VehicleModel, THREE.BufferGeometry>();

  /**
   * Заменить шаблон готовой геометрией (например, запечённой из Blender).
   * Предыдущая геометрия освобождается: владельцем шаблона остаётся кеш.
   */
  set(model: VehicleModel, geometry: THREE.BufferGeometry): void {
    const previous = this.templates.get(model);
    if (previous === geometry) return;
    this.templates.set(model, geometry);
    if (previous) previous.dispose();
  }

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
