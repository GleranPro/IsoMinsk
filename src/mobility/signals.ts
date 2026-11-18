/**
 * Isometric Minsk — контроллер светофорного узла.
 *
 * Контроллер — чистое состояние: он не зависит от Three.js, таймеров и
 * загруженных моделей. Выгрузка/повторная загрузка геометрии сигналов и пауза
 * симуляции не сбрасывают фазу и занятость — меняется только вызывающий код.
 *
 * Правила, которые гарантирует модуль:
 *  - жёсткий цикл «зелёный → жёлтый → полное освобождение (all-red) → следующая
 *    фаза»; одновременно зелёный получают только группы одной фазы;
 *  - конфликтующая матрица проверяется при построении: программа, разрешающая
 *    два конфликтующих манёвра в одной фазе, отвергается;
 *  - переход к следующей фазе удерживается, пока конфликтная зона занята
 *    манёвром, который с ней конфликтует: уже въехавший транспорт сохраняет
 *    право закончить манёвр, а конфликтующий поток ждёт даже после окончания
 *    номинального all-red;
 *  - вход разрешается только при зелёном, свободной конфликтной зоне и
 *    свободном выходе; на жёлтом решение «остановиться/продолжить» принимается
 *    по доступному тормозному пути до стоп-линии;
 *  - занятость ведётся по положению кузова вдоль пути манёвра: манёвр считается
 *    завершённым, когда хвост кузова прошёл конец пути.
 *
 * Длительности фаз и замедления — модельные параметры конкретного узла, а не
 * измерения реального города.
 */

import { mobilityPolylineLength } from '../shared/mobility';
import type {
  MobilityAspect,
  MobilityMovement,
  MobilityPhase,
  MobilitySignalGroup,
  MobilitySignalNode,
  MobilityStopLine,
  MobilityTrafficKind,
} from '../shared/mobility';

/** Сервисное замедление по умолчанию, м/с² (модельный параметр). */
export const DEFAULT_BRAKING_MPS2 = 3;

/** Время реакции водителя/вагона по умолчанию, с (модельный параметр). */
export const DEFAULT_REACTION_S = 0.5;

/** Минимальный зазор между габаритом и свободной длиной выхода, м (модельный параметр). */
export const DEFAULT_EXIT_MARGIN_M = 0.5;

/** Фаза подцикла светофора. */
export type SignalStage = 'green' | 'yellow' | 'all-red' | 'hold';

/** Решение на жёлтый сигнал. */
export type YellowDecision = 'stop' | 'continue';

/** Изменение занятости манёвра по положению. */
export type MovementTransition = 'clear' | 'entered' | 'inside' | 'exited';

/** Допуск границ времени фазы, секунды (float-устойчивость фиксированного шага). */
const PHASE_EPSILON = 1e-9;

/**
 * Тормозной путь с учётом времени реакции, м.
 *
 * `speedMps * reactionS + speedMps² / (2 * brakingMps2)`. Отрицательные
 * значения обрезаются; нечисловые входы дают `Infinity` (остановиться нельзя).
 */
export function stoppingDistanceM(
  speedMps: number,
  brakingMps2 = DEFAULT_BRAKING_MPS2,
  reactionS = DEFAULT_REACTION_S,
): number {
  if (!Number.isFinite(speedMps) || !Number.isFinite(brakingMps2) || !Number.isFinite(reactionS)) {
    return Number.POSITIVE_INFINITY;
  }
  if (brakingMps2 <= 0) return Number.POSITIVE_INFINITY;
  const speed = Math.max(0, speedMps);
  const reaction = Math.max(0, reactionS);
  return speed * reaction + (speed * speed) / (2 * brakingMps2);
}

/**
 * Решение на жёлтый сигнал по границе въезда.
 *
 * `stop` — если транспорт успевает остановиться до стоп-линии; `continue` —
 * если тормозной путь больше доступной дистанции (безопасно закончить въезд)
 * или стоп-линия уже позади. Решение не даёт права въехать само по себе:
 * занятость конфликтной зоны и свободный выход проверяет `canEnter()`.
 */
export function decideYellowStop(
  distanceToStopLineM: number,
  speedMps: number,
  brakingMps2 = DEFAULT_BRAKING_MPS2,
  reactionS = DEFAULT_REACTION_S,
): YellowDecision {
  if (
    !Number.isFinite(distanceToStopLineM) ||
    !Number.isFinite(speedMps) ||
    !Number.isFinite(brakingMps2) ||
    !Number.isFinite(reactionS)
  ) {
    return 'stop';
  }
  if (distanceToStopLineM <= 0) return 'continue';
  if (speedMps <= 0) return 'stop';
  return stoppingDistanceM(speedMps, brakingMps2, reactionS) <= distanceToStopLineM
    ? 'stop'
    : 'continue';
}

/** Контекст запроса на въезд в узел от автомобиля/трамвая/пешехода. */
export interface SignalEntryRequest {
  /** Расстояние от передней точки кузова до стоп-линии, м (может быть отрицательным). */
  distanceToStopLineM?: number;
  /** Текущая скорость, м/с. */
  speedMps?: number;
  /** Сервисное замедление, м/с². */
  brakingMps2?: number;
  /** Время реакции, с. */
  reactionS?: number;
  /** Свободен ли выход; `false` запрещает вход даже на зелёном. */
  exitClear?: boolean;
  /** Свободная длина на выходе, м; сравнивается с габаритом + зазором. */
  exitDistanceM?: number;
}

/** Параметры контроллера. */
export interface SignalControllerOptions {
  /** Сдвиг цикла, секунды; по умолчанию `program.offsetS`. */
  offsetS?: number;
}

/** Снимок одного манёвра для QA. */
export interface SignalMovementSnapshot {
  id: string;
  /** Вид движения (автомобиль/трамвай/пешеход). */
  kind: MobilityTrafficKind;
  /** Id группы сигналов, которой подчиняется манёвр. */
  groupId: string;
  /** Текущий аспект группы. */
  aspect: MobilityAspect;
  /** Находится ли манёвр в конфликтной зоне. */
  occupied: boolean;
  /** Положение передней точки вдоль пути, м; `null` вне узла. */
  positionM: number | null;
  /** Полная длина пути манёвра, м. */
  pathLengthM: number;
}

/** Снимок состояния узла для QA/тестов. */
export interface SignalControllerSnapshot {
  nodeId: string;
  /** Индекс активной фазы программы. */
  phase: number;
  /** Текущий подцикл; `hold` — удержание из-за занятой конфликтной зоны. */
  stage: SignalStage;
  /** Секунды внутри активной фазы (в `hold` равно номинальной длительности). */
  phaseElapsedS: number;
  /** Положение в цикле, секунды `[0, cycleSeconds)`. */
  cyclePositionS: number;
  /** Аспект каждой группы по её id. */
  aspects: Record<string, MobilityAspect>;
  /** Id манёвров, находящихся в конфликтной зоне, в порядке программы. */
  occupied: string[];
  /** Подробности по каждому манёвру. */
  movements: SignalMovementSnapshot[];
}

interface SignalNodeIndex {
  groups: MobilitySignalGroup[];
  phases: MobilityPhase[];
  movementIndexById: Map<string, number>;
  groupMovements: number[][];
  pathLengths: number[];
  clearanceLengths: number[];
  conflictsWith: ReadonlySet<number>[];
  stopLinesByMovement: Map<number, MobilityStopLine>;
  cycleDurationS: number;
  offsetS: number;
}

function phaseDuration(phase: MobilityPhase): number {
  return phase.greenS + phase.yellowS + phase.allRedS;
}

function buildSignalIndex(node: MobilitySignalNode): SignalNodeIndex {
  if (!node.id) throw new RangeError('Светофорный узел без id');
  if (!Array.isArray(node.groups) || node.groups.length === 0) {
    throw new RangeError(`Узел ${node.id}: нет групп сигналов`);
  }
  if (!Array.isArray(node.movements) || node.movements.length === 0) {
    throw new RangeError(`Узел ${node.id}: нет манёвров`);
  }
  const program = node.program;
  if (!program || !Array.isArray(program.phases) || program.phases.length === 0) {
    throw new RangeError(`Узел ${node.id}: нет программы фаз`);
  }
  if (!Number.isFinite(program.offsetS)) {
    throw new RangeError(`Узел ${node.id}: некорректный offsetS программы`);
  }

  const groupIds = new Set<string>();
  for (const group of node.groups) {
    if (!group.id || groupIds.has(group.id)) {
      throw new RangeError(`Узел ${node.id}: повторный или пустой id группы "${group.id}"`);
    }
    groupIds.add(group.id);
    if (!Array.isArray(group.aspects)) {
      throw new RangeError(`Узел ${node.id}: у группы ${group.id} нет списка аспектов`);
    }
  }

  const movementIndexById = new Map<string, number>();
  const pathLengths: number[] = [];
  const clearanceLengths: number[] = [];
  const groupMovements: number[][] = node.groups.map(() => []);
  node.movements.forEach((movement, index) => {
    if (!movement.id || movementIndexById.has(movement.id)) {
      throw new RangeError(`Узел ${node.id}: повторный или пустой id манёвра "${movement.id}"`);
    }
    movementIndexById.set(movement.id, index);
    if (!Number.isInteger(movement.group) || movement.group < 0 || movement.group >= node.groups.length) {
      throw new RangeError(`Узел ${node.id}: манёвр ${movement.id} ссылается на несуществующую группу`);
    }
    if (!Number.isFinite(movement.clearanceLengthM) || movement.clearanceLengthM < 0) {
      throw new RangeError(`Узел ${node.id}: манёвр ${movement.id} имеет некорректный габарит`);
    }
    if (!movement.path || !Array.isArray(movement.path.p) || movement.path.p.length % 3 !== 0) {
      throw new RangeError(`Узел ${node.id}: манёвр ${movement.id} имеет некорректный путь`);
    }
    pathLengths.push(Math.max(0, mobilityPolylineLength(movement.path.p)));
    clearanceLengths.push(movement.clearanceLengthM);
    groupMovements[movement.group]?.push(index);
  });

  const stopLinesByMovement = new Map<number, MobilityStopLine>();
  for (const stopLine of node.stopLines ?? []) {
    if (
      !Number.isInteger(stopLine.movement) ||
      stopLine.movement < 0 ||
      stopLine.movement >= node.movements.length
    ) {
      throw new RangeError(`Узел ${node.id}: стоп-линия ссылается на несуществующий манёвр`);
    }
    if (stopLinesByMovement.has(stopLine.movement)) {
      throw new RangeError(`Узел ${node.id}: у манёвра ${stopLine.movement} больше одной стоп-линии`);
    }
    stopLinesByMovement.set(stopLine.movement, stopLine);
  }

  const conflictsWith: Set<number>[] = node.movements.map(() => new Set<number>());
  for (const pair of node.conflicts ?? []) {
    const [left, right] = pair;
    if (
      !Number.isInteger(left) ||
      !Number.isInteger(right) ||
      left < 0 ||
      right < 0 ||
      left >= node.movements.length ||
      right >= node.movements.length
    ) {
      throw new RangeError(`Узел ${node.id}: конфликт ссылается на несуществующий манёвр`);
    }
    if (left === right) continue;
    conflictsWith[left]?.add(right);
    conflictsWith[right]?.add(left);
  }

  let cycleDurationS = 0;
  for (const phase of program.phases) {
    if (!Number.isFinite(phase.greenS) || phase.greenS < 0) {
      throw new RangeError(`Узел ${node.id}: некорректная длительность зелёного`);
    }
    if (!Number.isFinite(phase.yellowS) || phase.yellowS < 0) {
      throw new RangeError(`Узел ${node.id}: некорректная длительность жёлтого`);
    }
    if (!Number.isFinite(phase.allRedS) || phase.allRedS < 0) {
      throw new RangeError(`Узел ${node.id}: некорректная длительность all-red`);
    }
    const total = phaseDuration(phase);
    if (total <= 0) {
      throw new RangeError(`Узел ${node.id}: фаза с нулевой длительностью`);
    }
    cycleDurationS += total;
    const greenMovements: number[] = [];
    for (const groupIndex of phase.green) {
      if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex >= node.groups.length) {
        throw new RangeError(`Узел ${node.id}: фаза ссылается на несуществующую группу`);
      }
      greenMovements.push(...(groupMovements[groupIndex] ?? []));
    }
    for (let leftIndex = 0; leftIndex < greenMovements.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < greenMovements.length; rightIndex += 1) {
        const left = greenMovements[leftIndex];
        const right = greenMovements[rightIndex];
        if (left === undefined || right === undefined) continue;
        if (conflictsWith[left]?.has(right)) {
          const leftId = node.movements[left]?.id ?? String(left);
          const rightId = node.movements[right]?.id ?? String(right);
          throw new RangeError(
            `Узел ${node.id}: конфликтующие манёвры ${leftId} и ${rightId} одновременно зелёные в одной фазе`,
          );
        }
      }
    }
  }
  if (cycleDurationS <= 0) {
    throw new RangeError(`Узел ${node.id}: нулевая длительность цикла`);
  }

  return {
    groups: node.groups,
    phases: program.phases,
    movementIndexById,
    groupMovements,
    pathLengths,
    clearanceLengths,
    conflictsWith,
    stopLinesByMovement,
    cycleDurationS,
    offsetS: program.offsetS,
  };
}

/**
 * Контроллер одного светофорного узла.
 *
 * Экземпляр создаётся из payload-узла `MobilitySignalNode` и далее живёт
 * независимо от моделей/сцены. Время продвигается только явным `update(dt)`
 * (обычно фиксированным шагом часов), занятость — методами `enter`/`exit`/
 * `updatePosition`.
 */
export class SignalController {
  /** Узел, из которого построен контроллер (payload не мутируется). */
  readonly node: MobilitySignalNode;

  private readonly groups: MobilitySignalGroup[];
  private readonly phases: MobilityPhase[];
  private readonly movementIndexById: Map<string, number>;
  private readonly groupMovements: number[][];
  private readonly pathLengths: number[];
  private readonly clearanceLengths: number[];
  private readonly conflictsWith: ReadonlySet<number>[];
  private readonly stopLinesByMovement: Map<number, MobilityStopLine>;
  private readonly occupied = new Map<number, number>();
  private readonly blockedExits = new Set<number>();
  private readonly cycleDurationS: number;

  private phaseIndexValue = 0;
  private phaseElapsedValue = 0;

  constructor(node: MobilitySignalNode, options: SignalControllerOptions = {}) {
    const index = buildSignalIndex(node);
    this.node = node;
    this.groups = index.groups;
    this.phases = index.phases;
    this.movementIndexById = index.movementIndexById;
    this.groupMovements = index.groupMovements;
    this.pathLengths = index.pathLengths;
    this.clearanceLengths = index.clearanceLengths;
    this.conflictsWith = index.conflictsWith;
    this.stopLinesByMovement = index.stopLinesByMovement;
    this.cycleDurationS = index.cycleDurationS;
    const offsetS = options.offsetS ?? index.offsetS;
    if (!Number.isFinite(offsetS)) {
      throw new RangeError(`Узел ${node.id}: некорректный сдвиг цикла ${offsetS}`);
    }
    this.seekCyclePosition(offsetS);
  }

  /** Длительность полного цикла программы, секунды. */
  get cycleSeconds(): number {
    return this.cycleDurationS;
  }

  /** Индекс активной фазы. */
  get phase(): number {
    return this.phaseIndexValue;
  }

  /** Текущий подцикл фазы. */
  get stage(): SignalStage {
    return this.currentStage();
  }

  /** Секунды внутри активной фазы. */
  get phaseElapsedS(): number {
    return this.phaseElapsedValue;
  }

  /**
   * Положение в цикле, секунды.
   *
   * В обычной работе `[0, cycleSeconds)`, в удержании (`hold`) равно
   * `cycleSeconds`: фаза уже отработана, но конфликтная зона ещё занята.
   */
  get cyclePositionS(): number {
    let position = this.phaseElapsedValue;
    for (let index = 0; index < this.phaseIndexValue; index += 1) {
      const phase = this.phases[index];
      if (phase) position += phaseDuration(phase);
    }
    return position;
  }

  /**
   * Продвигает фазу на `dt` секунд.
   *
   * Время во время удержания (`hold`) не переносится: после освобождения
   * конфликтной зоны следующая фаза начнётся с нуля. Нечисловой или
   * отрицательный `dt` — ошибка вызывающего кода.
   */
  update(dt: number): void {
    if (!Number.isFinite(dt)) {
      throw new RangeError(`Некорректный шаг светофора: ${dt}`);
    }
    if (dt < 0) throw new RangeError(`Отрицательный шаг светофора: ${dt}`);
    if (dt === 0) return;
    let remaining = dt;
    // При пустой конфликтной зоне цикл не может «застрять»: целые циклы можно
    // пропустить аналитически (нужно для QA-перемотки, а не для игрового шага).
    if (this.occupied.size === 0 && remaining >= this.cycleDurationS) {
      remaining -= Math.floor(remaining / this.cycleDurationS) * this.cycleDurationS;
    }
    let transitions = 0;
    const maxTransitions = this.phases.length * 64 + 64;
    while (remaining > PHASE_EPSILON && transitions < maxTransitions) {
      const phase = this.phases[this.phaseIndexValue];
      if (!phase) break;
      const total = phaseDuration(phase);
      const room = total - this.phaseElapsedValue;
      if (room > remaining) {
        this.phaseElapsedValue += remaining;
        remaining = 0;
        break;
      }
      this.phaseElapsedValue = total;
      remaining = Math.max(0, remaining - Math.max(0, room));
      if (this.isTransitionBlocked()) {
        // Удержание: уже въехавший транспорт заканчивает манёвр, конфликтующий
        // поток остаётся красным. Остаток шага не копится.
        remaining = 0;
        break;
      }
      this.phaseIndexValue = (this.phaseIndexValue + 1) % this.phases.length;
      this.phaseElapsedValue = 0;
      transitions += 1;
    }
  }

  /** Аспект каждой группы сигналов по id группы. */
  aspects(): Record<string, MobilityAspect> {
    const result: Record<string, MobilityAspect> = {};
    for (let groupIndex = 0; groupIndex < this.groups.length; groupIndex += 1) {
      const group = this.groups[groupIndex];
      if (!group) continue;
      result[group.id] = this.aspectForGroup(groupIndex);
    }
    return result;
  }

  /** Занят ли манёвр (или хоть один манёвр, если id не задан) конфликтной зоной. */
  isOccupied(movementId?: string): boolean {
    if (movementId === undefined) return this.occupied.size > 0;
    const index = this.movementIndexById.get(movementId);
    return index !== undefined && this.occupied.has(index);
  }

  /** Положение передней точки занятого манёвра, м; `null` вне узла. */
  positionOf(movementId: string): number | null {
    const index = this.movementIndexById.get(movementId);
    if (index === undefined) return null;
    return this.occupied.get(index) ?? null;
  }

  /** Стоп-линия манёвра из payload (граница въезда) или `null`. */
  stopLine(movementId: string): MobilityStopLine | null {
    const index = this.movementIndexById.get(movementId);
    if (index === undefined) return null;
    return this.stopLinesByMovement.get(index) ?? null;
  }

  /**
   * Можно ли войти в узел (пересечь стоп-линию).
   *
   * Отказ, если: манёвр неизвестен; горит красный; конфликтная зона занята
   * конфликтующим манёвром; выход занят (`exitClear === false`, сохранённый
   * `setExitBlocked()` или слишком малая `exitDistanceM`). На жёлтом вход
   * разрешается только если тормозной путь больше дистанции до стоп-линии
   * (остановиться безопасно нельзя). Уже находящийся в узле манёвр всегда
   * сохраняет право закончить манёвр — для него возвращается `true`.
   */
  canEnter(movementId: string, request: SignalEntryRequest = {}): boolean {
    const movementIndex = this.movementIndexById.get(movementId);
    if (movementIndex === undefined) return false;
    if (this.occupied.has(movementIndex)) return true;
    const movement = this.movements[movementIndex];
    if (!movement) return false;
    const aspect = this.aspectForGroup(movement.group);
    if (aspect === 'red') return false;
    if (this.hasOccupiedConflict(movementIndex)) return false;
    const exitClear = request.exitClear ?? !this.blockedExits.has(movementIndex);
    if (!exitClear) return false;
    if (request.exitDistanceM !== undefined) {
      if (!Number.isFinite(request.exitDistanceM)) return false;
      if (request.exitDistanceM < (this.clearanceLengths[movementIndex] ?? 0) + DEFAULT_EXIT_MARGIN_M) {
        return false;
      }
    }
    if (aspect === 'yellow') {
      if (
        request.distanceToStopLineM === undefined ||
        request.speedMps === undefined ||
        !Number.isFinite(request.distanceToStopLineM) ||
        !Number.isFinite(request.speedMps)
      ) {
        // Без дистанции/скорости нельзя доказать безопасное решение.
        return false;
      }
      return (
        decideYellowStop(
          request.distanceToStopLineM,
          request.speedMps,
          request.brakingMps2,
          request.reactionS,
        ) === 'continue'
      );
    }
    return true;
  }

  /**
   * Регистрирует въезд манёвра в конфликтную зону (физический факт).
   *
   * Проверка разрешения — `canEnter()`; контроллер не отменяет физическое
   * присутствие. Возвращает `false` только для неизвестного манёвра.
   */
  enter(movementId: string, positionM = 0): boolean {
    const index = this.movementIndexById.get(movementId);
    if (index === undefined) return false;
    if (!Number.isFinite(positionM)) {
      throw new RangeError(`Некорректное положение манёвра ${movementId}: ${positionM}`);
    }
    const position = Math.max(0, positionM);
    const previous = this.occupied.get(index);
    this.occupied.set(index, previous === undefined ? position : Math.max(previous, position));
    return true;
  }

  /** Снимает занятость манёвра; `false`, если манёвр не был занят/неизвестен. */
  exit(movementId: string): boolean {
    const index = this.movementIndexById.get(movementId);
    if (index === undefined) return false;
    return this.occupied.delete(index);
  }

  /**
   * Обновляет занятость по положению передней точки вдоль пути манёвра.
   *
   * `0` — стоп-линия, длина пути — свободный выход. Въезд регистрируется при
   * `position >= 0`, завершение — когда хвост кузова (`position −
   * clearanceLengthM`) прошёл конец пути. Позиция не откатывается назад
   * (защита от устаревших сэмплов).
   */
  updatePosition(movementId: string, positionM: number): MovementTransition {
    const index = this.movementIndexById.get(movementId);
    if (index === undefined) {
      throw new RangeError(`Неизвестный манёвр: "${movementId}"`);
    }
    if (!Number.isFinite(positionM)) {
      throw new RangeError(`Некорректное положение манёвра ${movementId}: ${positionM}`);
    }
    const previous = this.occupied.get(index);
    if (previous === undefined) {
      if (positionM < 0) return 'clear';
      this.occupied.set(index, positionM);
      return 'entered';
    }
    const position = Math.max(previous, positionM);
    this.occupied.set(index, position);
    const pathLength = this.pathLengths[index] ?? 0;
    const clearance = this.clearanceLengths[index] ?? 0;
    if (position - clearance >= pathLength) {
      this.occupied.delete(index);
      return 'exited';
    }
    return 'inside';
  }

  /**
   * Внешняя блокировка выхода (очередь за узлом, занятая полоса).
   * Пока выход заблокирован, `canEnter()` запрещает вход даже на зелёном.
   */
  setExitBlocked(movementId: string, blocked: boolean): void {
    const index = this.movementIndexById.get(movementId);
    if (index === undefined) {
      throw new RangeError(`Неизвестный манёвр: "${movementId}"`);
    }
    if (blocked) this.blockedExits.add(index);
    else this.blockedExits.delete(index);
  }

  /** Заблокирован ли выход манёвра внешней стороной. */
  isExitBlocked(movementId: string): boolean {
    const index = this.movementIndexById.get(movementId);
    return index !== undefined && this.blockedExits.has(index);
  }

  /** Полный снимок состояния узла для QA и тестов. */
  snapshot(): SignalControllerSnapshot {
    const aspects = this.aspects();
    const occupied: string[] = [];
    const movements: SignalMovementSnapshot[] = [];
    const occupiedIndices: number[] = [];
    for (const index of this.occupied.keys()) occupiedIndices.push(index);
    occupiedIndices.sort((left, right) => left - right);
    for (const index of occupiedIndices) {
      const movement = this.movements[index];
      if (movement) occupied.push(movement.id);
    }
    for (let index = 0; index < this.movements.length; index += 1) {
      const movement = this.movements[index];
      if (!movement) continue;
      const group = this.groups[movement.group];
      const groupId = group ? group.id : '';
      movements.push({
        id: movement.id,
        kind: movement.kind,
        groupId,
        aspect: aspects[groupId] ?? 'red',
        occupied: this.occupied.has(index),
        positionM: this.occupied.get(index) ?? null,
        pathLengthM: this.pathLengths[index] ?? 0,
      });
    }
    return {
      nodeId: this.node.id,
      phase: this.phaseIndexValue,
      stage: this.currentStage(),
      phaseElapsedS: this.phaseElapsedValue,
      cyclePositionS: this.cyclePositionS,
      aspects,
      occupied,
      movements,
    };
  }

  private get movements(): MobilityMovement[] {
    return this.node.movements;
  }

  private currentStage(): SignalStage {
    const phase = this.phases[this.phaseIndexValue];
    if (!phase) return 'hold';
    if (this.phaseElapsedValue < phase.greenS) return 'green';
    if (this.phaseElapsedValue < phase.greenS + phase.yellowS) return 'yellow';
    if (this.phaseElapsedValue < phaseDuration(phase)) return 'all-red';
    return 'hold';
  }

  private aspectForGroup(groupIndex: number): MobilityAspect {
    const stage = this.currentStage();
    const phase = this.phases[this.phaseIndexValue];
    if (!phase || !phase.green.includes(groupIndex)) return 'red';
    if (stage === 'green') {
      return this.groupBlockedByOccupancy(groupIndex) ? 'red' : 'green';
    }
    if (stage === 'yellow') {
      const group = this.groups[groupIndex];
      return group && group.aspects.includes('yellow') ? 'yellow' : 'red';
    }
    return 'red';
  }

  private groupBlockedByOccupancy(groupIndex: number): boolean {
    if (this.occupied.size === 0) return false;
    for (const movementIndex of this.groupMovements[groupIndex] ?? []) {
      const conflicts = this.conflictsWith[movementIndex];
      if (!conflicts) continue;
      for (const occupiedIndex of this.occupied.keys()) {
        if (occupiedIndex !== movementIndex && conflicts.has(occupiedIndex)) return true;
      }
    }
    return false;
  }

  private hasOccupiedConflict(movementIndex: number): boolean {
    const conflicts = this.conflictsWith[movementIndex];
    if (!conflicts || conflicts.size === 0) return false;
    for (const occupiedIndex of this.occupied.keys()) {
      if (conflicts.has(occupiedIndex)) return true;
    }
    return false;
  }

  /** Мешает ли занятая конфликтная зона перейти к следующей фазе. */
  private isTransitionBlocked(): boolean {
    if (this.occupied.size === 0) return false;
    const nextPhase = this.phases[(this.phaseIndexValue + 1) % this.phases.length];
    if (!nextPhase) return false;
    for (const groupIndex of nextPhase.green) {
      for (const greenMovement of this.groupMovements[groupIndex] ?? []) {
        const conflicts = this.conflictsWith[greenMovement];
        if (!conflicts) continue;
        for (const occupiedIndex of this.occupied.keys()) {
          if (occupiedIndex !== greenMovement && conflicts.has(occupiedIndex)) return true;
        }
      }
    }
    return false;
  }

  private seekCyclePosition(offsetS: number): void {
    let position = ((offsetS % this.cycleDurationS) + this.cycleDurationS) % this.cycleDurationS;
    let phaseIndex = 0;
    for (let guard = 0; guard < this.phases.length; guard += 1) {
      const phase = this.phases[phaseIndex];
      if (!phase) break;
      const total = phaseDuration(phase);
      if (position < total - PHASE_EPSILON) {
        this.phaseIndexValue = phaseIndex;
        this.phaseElapsedValue = Math.max(0, position);
        return;
      }
      position -= total;
      phaseIndex = (phaseIndex + 1) % this.phases.length;
    }
    this.phaseIndexValue = 0;
    this.phaseElapsedValue = 0;
  }
}
