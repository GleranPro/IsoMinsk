/**
 * Isometric Minsk — low-poly светофоры (автомобильный, пешеходный, трамвайный).
 *
 * Модель одного сигнала: стойка, корпус с тёмной фронтальной панелью и козырёк.
 * Линзы — отдельный единичный четырёхугольник, который слой ставит в слот нужного
 * аспекта и красит `instanceColor`. Свечение линзы имитируется
 * `MeshBasicMaterial` (не зависит от освещения) — отдельного источника света на
 * каждый сигнал нет, как и отдельного материала на головку.
 *
 * Ориентация: локальный +X — направление обслуживаемого движения (как у
 * транспорта). Фронт головки с нормалью −X развёрнут навстречу едущим, поэтому
 * экземпляр поворачивается на `head.facing` без дополнительной поправки.
 *
 * Аспект берётся из runtime-состояния (`aspects[nodeId][groupId]`), а не хранится
 * в контракте узла: правила движения принадлежат симуляции, слой только рисует.
 * Если состояние для узла/группы отсутствует, безопасно показывается красный и
 * инкрементируется счётчик `unknownAspect` в статистике слоя.
 */

import * as THREE from 'three';
import type {
  MobilityAspect,
  MobilitySignalNode,
  MobilityTrafficKind,
} from '../../shared/mobility';
import { FLAT_FACE_SHADE, SurfaceBuilder, geometryByteLength, linearRgb, type LinearRgb } from './lowPoly';

/** Ограниченная палитра светофоров. */
export const SIGNAL_PALETTE = {
  pole: '#4b4e50',
  housing: '#3a3d3f',
  housingFront: '#202325',
  hood: '#2c2f31',
  lens: '#0f1112',
  red: '#ff4a3d',
  yellow: '#ffc63f',
  green: '#3fe06a',
} as const;

/** Цвет линзы по аспекту, sRGB-hex. */
export const SIGNAL_ASPECT_COLORS: Readonly<Record<MobilityAspect, string>> = {
  red: SIGNAL_PALETTE.red,
  yellow: SIGNAL_PALETTE.yellow,
  green: SIGNAL_PALETTE.green,
};

/** Геометрия головки: вертикальный размер, ширина (Z) и глубина (X). */
export interface SignalHeadGeometrySpec {
  heightM: number;
  widthM: number;
  depthM: number;
  /** Слоты линз относительно центра головки: смещение по Y и размер линзы. */
  lenses: Readonly<Record<MobilityAspect, { y: number; size: number }>>;
}

/**
 * Размеры по типу движения. Пешеходная головка ниже и уже; её «жёлтый» слот
 * находится в центре — аспект для пешеходов контрактом не предполагается, но
 * рендер не должен падать, если контроллер его выставит.
 */
export const SIGNAL_HEAD_GEOMETRY: Readonly<Record<MobilityTrafficKind, SignalHeadGeometrySpec>> = {
  vehicle: {
    heightM: 0.95,
    widthM: 0.34,
    depthM: 0.26,
    lenses: {
      red: { y: 0.31, size: 0.2 },
      yellow: { y: 0, size: 0.2 },
      green: { y: -0.31, size: 0.2 },
    },
  },
  pedestrian: {
    heightM: 0.62,
    widthM: 0.32,
    depthM: 0.24,
    lenses: {
      red: { y: 0.145, size: 0.19 },
      yellow: { y: 0, size: 0.17 },
      green: { y: -0.145, size: 0.19 },
    },
  },
  tram: {
    heightM: 0.88,
    widthM: 0.44,
    depthM: 0.26,
    lenses: {
      red: { y: 0.28, size: 0.19 },
      yellow: { y: 0, size: 0.19 },
      green: { y: -0.28, size: 0.19 },
    },
  },
};

/** Один нарисованный сигнал: геометрия головки + слот линзы по аспекту. */
export interface SignalHeadInstance {
  nodeId: string;
  headId: string;
  kind: MobilityTrafficKind;
  /** Id группы состояния (`node.groups[head.group].id`), пустая при ошибке индекса. */
  groupId: string;
  /** Позиция головки в локальных метрах (x восток, y север). */
  x: number;
  y: number;
  /** Направление обслуживаемого движения, радианы CCW от +X. */
  facing: number;
  /** Высота стойки, метры (контракт `MobilitySignalHead.heightM`). */
  heightM: number;
  /** Высота земли под головкой (дека/рампа), метры; 0 — обычный уровень. */
  groundHeightM: number;
  aspect: MobilityAspect;
  /** false — аспект не найден в состоянии и подставлен красный. */
  aspectKnown: boolean;
}

/** Аспекты по узлу: Map или обычный объект (форма `MobilityDebugDump.signals`). */
export type SignalAspectSource =
  | ReadonlyMap<string, Readonly<Record<string, MobilityAspect>>>
  | Readonly<Record<string, Readonly<Record<string, MobilityAspect>> | undefined>>;

/** Слот линзы для типа головки и аспекта. */
export function signalLensSlot(
  kind: MobilityTrafficKind,
  aspect: MobilityAspect,
): { y: number; size: number } {
  return SIGNAL_HEAD_GEOMETRY[kind].lenses[aspect];
}

/** Смещение линзы вперёд от центра головки (по локальной оси −X), метры. */
export function signalLensFrontOffset(kind: MobilityTrafficKind): number {
  return SIGNAL_HEAD_GEOMETRY[kind].depthM * 0.5 + 0.006;
}

/**
 * Высота центра головки: верх головки на высоте стойки. Слишком малую стойку
 * контракта поднимаем до высоты головки плюс зазор, чтобы корпус не уходил в
 * землю (это защита рендера, а не изменение данных).
 */
export function signalHeadCentreY(kind: MobilityTrafficKind, heightM: number): number {
  const spec = SIGNAL_HEAD_GEOMETRY[kind];
  const pole = Math.max(spec.heightM + 0.35, Number.isFinite(heightM) ? heightM : spec.heightM + 0.35);
  return pole - spec.heightM * 0.5;
}

/**
 * Высота стойки после той же защиты: масштаб единичной стойки по Y.
 * Совпадает с `signalHeadCentreY(kind, heightM) + heightM / 2`.
 */
export function signalPoleHeight(kind: MobilityTrafficKind, heightM: number): number {
  const spec = SIGNAL_HEAD_GEOMETRY[kind];
  const pole = Math.max(spec.heightM + 0.35, Number.isFinite(heightM) ? heightM : spec.heightM + 0.35);
  return pole;
}

function aspectsForNode(
  source: SignalAspectSource | undefined,
  nodeId: string,
): Readonly<Record<string, MobilityAspect>> | undefined {
  if (!source) return undefined;
  if (source instanceof Map) return source.get(nodeId);
  return (source as Readonly<Record<string, Readonly<Record<string, MobilityAspect>> | undefined>>)[nodeId];
}

/**
 * Разворачивает узлы и их головки в плоский список экземпляров для рендера.
 *
 * `out` можно передать для переиспользования массива между кадрами; функция
 * очищает его. Обход узлов и головок сохраняет порядок контракта, поэтому
 * результат детерминирован. Нечисловые координаты/углы пропускаются.
 */
export function collectSignalHeadInstances(
  nodes: readonly MobilitySignalNode[],
  aspects: SignalAspectSource | undefined,
  out: SignalHeadInstance[] = [],
): SignalHeadInstance[] {
  out.length = 0;
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !Array.isArray(node.heads)) continue;
    const nodeAspects = aspectsForNode(aspects, node.id);
    const groups = Array.isArray(node.groups) ? node.groups : [];
    for (const head of node.heads) {
      if (!head || !Number.isFinite(head.x) || !Number.isFinite(head.y) || !Number.isFinite(head.facing)) continue;
      const group = groups[head.group];
      const groupId = group?.id ?? '';
      const rawAspect = groupId !== '' ? nodeAspects?.[groupId] : undefined;
      // Runtime-состояние приходит из симуляции; неизвестное значение не должно
      // ломать рендер — безопасно показываем красный и считаем его fallback.
      const aspect: MobilityAspect =
        rawAspect === 'red' || rawAspect === 'yellow' || rawAspect === 'green' ? rawAspect : 'red';
      const kind: MobilityTrafficKind =
        head.kind === 'pedestrian' || head.kind === 'tram' || head.kind === 'vehicle'
          ? head.kind
          : 'vehicle';
      out.push({
        nodeId: node.id,
        headId: head.id,
        kind,
        groupId,
        x: head.x,
        y: head.y,
        facing: head.facing,
        heightM: head.heightM,
        groundHeightM:
          Number.isFinite(head.groundHeightM) && (head.groundHeightM ?? 0) > 0
            ? (head.groundHeightM as number)
            : 0,
        aspect,
        aspectKnown: rawAspect === aspect,
      });
    }
  }
  return out;
}

/** Набор общих шаблонов светофора. */
export interface SignalGeometryTemplates {
  /** Единичная стойка: основание в y = 0, высота 1 (масштабируется по Y). */
  pole: THREE.BufferGeometry;
  /** Корпус головки по типу движения, центр в начале координат. */
  housing: Record<MobilityTrafficKind, THREE.BufferGeometry>;
  /** Единичная линза: квадрат 1×1 в плоскости (Z, Y), нормаль −X. */
  lens: THREE.BufferGeometry;
}

function buildHousing(kind: MobilityTrafficKind): THREE.BufferGeometry {
  const spec = SIGNAL_HEAD_GEOMETRY[kind];
  const builder = new SurfaceBuilder();
  const housing = linearRgb(SIGNAL_PALETTE.housing);
  const front = linearRgb(SIGNAL_PALETTE.housingFront);
  const hood = linearRgb(SIGNAL_PALETTE.hood);
  builder.box([0, 0, 0], [spec.depthM, spec.heightM, spec.widthM], housing, {
    ...FLAT_FACE_SHADE,
    top: 1.12,
    front: 0.7,
    bottom: 0.55,
  });
  // Тёмная фронтальная панель: промежутки между линзами читаются как корпус.
  const px = -spec.depthM * 0.5 - 0.002;
  builder.quad(
    [px, -spec.heightM * 0.5, -spec.widthM * 0.5],
    [px, -spec.heightM * 0.5, spec.widthM * 0.5],
    [px, spec.heightM * 0.5, spec.widthM * 0.5],
    [px, spec.heightM * 0.5, -spec.widthM * 0.5],
    [-1, 0, 0],
    front,
  );
  // Козырёк над верхней линзой.
  builder.box(
    [-spec.depthM * 0.24, spec.heightM * 0.5 + 0.035, 0],
    [spec.depthM * 1.5, 0.06, spec.widthM * 1.06],
    hood,
    FLAT_FACE_SHADE,
  );
  const geometry = builder.build();
  geometry.name = `mobility-signal-housing-${kind}`;
  return geometry;
}

function buildPole(): THREE.BufferGeometry {
  const builder = new SurfaceBuilder();
  const pole = linearRgb(SIGNAL_PALETTE.pole);
  builder.cylinderY([0, 0, 0], 0.055, 1, 5, pole, pole);
  builder.box([0, 0.025, 0], [0.5, 0.05, 0.5], pole, FLAT_FACE_SHADE);
  const geometry = builder.build();
  geometry.name = 'mobility-signal-pole';
  return geometry;
}

function buildLens(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateY(-Math.PI / 2);
  geometry.name = 'mobility-signal-lens';
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Создаёт все шаблоны светофора; владелец — слой/вызывающий. */
export function createSignalGeometryTemplates(): SignalGeometryTemplates {
  return {
    pole: buildPole(),
    housing: {
      vehicle: buildHousing('vehicle'),
      pedestrian: buildHousing('pedestrian'),
      tram: buildHousing('tram'),
    },
    lens: buildLens(),
  };
}

/** Байты всех шаблонов (учёт памяти сцены). */
export function signalGeometryBytes(templates: SignalGeometryTemplates): number {
  let bytes = geometryByteLength(templates.pole) + geometryByteLength(templates.lens);
  for (const geometry of Object.values(templates.housing)) bytes += geometryByteLength(geometry);
  return bytes;
}

/** Освобождает геометрию шаблонов; материалы освобождает владелец слоя. */
export function disposeSignalGeometryTemplates(templates: SignalGeometryTemplates): void {
  templates.pole.dispose();
  templates.lens.dispose();
  for (const geometry of Object.values(templates.housing)) geometry.dispose();
}
