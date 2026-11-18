/**
 * Тесты контроллера светофорного узла: фазы, конфликтная матрица, границы
 * жёлтого, удержание занятой зоны, блокировка выхода, занятость по позиции,
 * сохранение состояния на паузе и детерминизм.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRAKING_MPS2,
  DEFAULT_REACTION_S,
  SignalController,
  decideYellowStop,
  stoppingDistanceM,
} from '../../../src/mobility/signals';
import type {
  MobilityMovement,
  MobilityPhase,
  MobilitySignalGroup,
  MobilitySignalNode,
  MobilityTrafficKind,
} from '../../../src/shared/mobility';

function group(
  id: string,
  kind: MobilityTrafficKind = 'vehicle',
  aspects: ('red' | 'yellow' | 'green')[] = ['green', 'yellow'],
): MobilitySignalGroup {
  return { id, kind, aspects: aspects.filter((aspect) => aspect !== 'red') };
}

function movement(
  id: string,
  groupIndex: number,
  pathLengthM = 20,
  clearanceLengthM = 4,
  kind: MobilityTrafficKind = 'vehicle',
): MobilityMovement {
  return {
    id,
    kind,
    approach: { edgeId: `in:${id}`, laneIndex: 0 },
    exitEdgeId: `out:${id}`,
    path: { p: [0, 0, 0, pathLengthM, 0, 0], s: [0, pathLengthM] },
    group: groupIndex,
    clearanceLengthM,
  };
}

function phase(green: number[], greenS: number, yellowS: number, allRedS: number): MobilityPhase {
  return { green, greenS, yellowS, allRedS };
}

/** Четырёхфазный узел: каждая фаза даёт зелёный одному манёвру, все пары конфликтуют. */
function fourWayNode(overrides: Partial<MobilitySignalNode> = {}): MobilitySignalNode {
  const groups = [group('g0'), group('g1'), group('g2'), group('g3')];
  const movements = groups.map((_, index) => movement(`m${index}`, index));
  const conflicts: [number, number][] = [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2],
    [1, 3],
    [2, 3],
  ];
  return {
    id: 'j:test',
    kind: 'junction',
    x: 0,
    y: 0,
    groups,
    movements,
    stopLines: movements.map((_, index) => ({
      movement: index,
      edgeId: `in:m${index}`,
      laneIndex: 0,
      s: 0,
      line: [0, 0, 0, 4, 0, 0],
      heading: 0,
    })),
    heads: [],
    program: {
      id: 'test-v1',
      phases: [
        phase([0], 10, 3, 2),
        phase([1], 10, 3, 2),
        phase([2], 10, 3, 2),
        phase([3], 10, 3, 2),
      ],
      offsetS: 0,
    },
    conflicts,
    ...overrides,
  };
}

/** Узел с пешеходной группой без жёлтого аспекта. */
function pedestrianNode(): MobilitySignalNode {
  const node = fourWayNode();
  return {
    ...node,
    id: 'j:ped',
    groups: [group('g0'), group('g1', 'pedestrian', ['green'])],
    movements: [movement('m0', 0), movement('m1', 1, 20, 1, 'pedestrian')],
    stopLines: node.stopLines.slice(0, 2),
    conflicts: [[0, 1]],
    program: {
      id: 'test-ped-v1',
      phases: [phase([0], 10, 3, 2), phase([1], 8, 0, 5)],
      offsetS: 0,
    },
  };
}

describe('Signals — тормозной путь и границы жёлтого', () => {
  it('считает тормозной путь с реакцией', () => {
    expect(stoppingDistanceM(0)).toBe(0);
    expect(stoppingDistanceM(10, 3, 0.5)).toBeCloseTo(5 + 100 / 6, 9);
    expect(stoppingDistanceM(10, 0, 0.5)).toBe(Number.POSITIVE_INFINITY);
    expect(stoppingDistanceM(Number.NaN)).toBe(Number.POSITIVE_INFINITY);
    expect(DEFAULT_BRAKING_MPS2).toBeGreaterThan(0);
    expect(DEFAULT_REACTION_S).toBeGreaterThanOrEqual(0);
  });

  it('решает остановиться/продолжить на границе доступного тормозного пути', () => {
    const exact = stoppingDistanceM(10, 3, 0.5);
    expect(decideYellowStop(exact + 1e-9, 10, 3, 0.5)).toBe('stop');
    expect(decideYellowStop(exact, 10, 3, 0.5)).toBe('stop');
    expect(decideYellowStop(exact - 1e-9, 10, 3, 0.5)).toBe('continue');
    expect(decideYellowStop(30, 10, 3, 0.5)).toBe('stop');
    expect(decideYellowStop(20, 10, 3, 0.5)).toBe('continue');
    expect(decideYellowStop(10, 0, 3, 0.5)).toBe('stop');
    expect(decideYellowStop(0, 10, 3, 0.5)).toBe('continue');
    expect(decideYellowStop(-3, 10, 3, 0.5)).toBe('continue');
    expect(decideYellowStop(Number.NaN, 10, 3, 0.5)).toBe('stop');
    expect(decideYellowStop(10, Number.NaN, 3, 0.5)).toBe('stop');
  });

  it('контроллер не пускает на жёлтый без дистанции/скорости и учитывает границу', () => {
    const controller = new SignalController(fourWayNode());
    controller.update(10);
    expect(controller.stage).toBe('yellow');
    expect(controller.aspects().g0).toBe('yellow');
    expect(controller.aspects().g1).toBe('red');
    expect(controller.canEnter('m0', { distanceToStopLineM: 30, speedMps: 10 })).toBe(false);
    expect(controller.canEnter('m0', { distanceToStopLineM: 5, speedMps: 10 })).toBe(true);
    expect(controller.canEnter('m0')).toBe(false);
    expect(controller.canEnter('m1')).toBe(false);
  });
});

describe('Signals — фазы и конфликтная матрица', () => {
  it('показывает зелёный → жёлтый → all-red → следующая фаза', () => {
    const controller = new SignalController(fourWayNode());
    expect(controller.cycleSeconds).toBe(60);
    expect(controller.phase).toBe(0);
    expect(controller.stage).toBe('green');
    expect(controller.aspects()).toEqual({ g0: 'green', g1: 'red', g2: 'red', g3: 'red' });

    controller.update(10);
    expect(controller.stage).toBe('yellow');
    expect(controller.aspects().g0).toBe('yellow');

    controller.update(3);
    expect(controller.stage).toBe('all-red');
    expect(controller.aspects()).toEqual({ g0: 'red', g1: 'red', g2: 'red', g3: 'red' });

    controller.update(2);
    expect(controller.phase).toBe(1);
    expect(controller.stage).toBe('green');
    expect(controller.aspects()).toEqual({ g0: 'red', g1: 'green', g2: 'red', g3: 'red' });
  });

  it('на полном цикле ни одна конфликтующая пара не получает зелёный одновременно', () => {
    const node = fourWayNode();
    const controller = new SignalController(node);
    const seenGreen = new Set<string>();
    const seenYellow = new Set<string>();
    const steps = 120 * 10; // два полных цикла по 0,1 с
    for (let step = 0; step < steps; step += 1) {
      const aspects = controller.aspects();
      const green: number[] = [];
      node.movements.forEach((item, index) => {
        const groupId = node.groups[item.group]?.id;
        if (!groupId) return;
        const aspect = aspects[groupId];
        if (aspect === 'green') {
          green.push(index);
          seenGreen.add(item.id);
        }
        if (aspect === 'yellow') seenYellow.add(item.id);
      });
      for (const [left, right] of node.conflicts) {
        const bothGreen = green.includes(left) && green.includes(right);
        expect(bothGreen, `конфликт ${left}/${right} на шаге ${step}`).toBe(false);
      }
      controller.update(0.1);
    }
    expect([...seenGreen].sort()).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect([...seenYellow].sort()).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('цикл повторяется через cycleSeconds и offsetS сдвигает старт', () => {
    const start = new SignalController(fourWayNode()).aspects();
    const repeated = new SignalController(fourWayNode());
    repeated.update(60);
    expect(repeated.phase).toBe(0);
    expect(repeated.aspects()).toEqual(start);

    const fastForward = new SignalController(fourWayNode());
    fastForward.update(600);
    expect(fastForward.phase).toBe(0);
    expect(fastForward.stage).toBe('green');
    expect(fastForward.aspects()).toEqual(start);

    const shifted = new SignalController(fourWayNode(), { offsetS: 15 });
    expect(shifted.phase).toBe(1);
    expect(shifted.stage).toBe('green');
    expect(shifted.aspects().g1).toBe('green');

    const programOffset = fourWayNode();
    programOffset.program = { ...programOffset.program, offsetS: 30 };
    const fromProgram = new SignalController(programOffset);
    expect(fromProgram.phase).toBe(2);
    expect(fromProgram.stage).toBe('green');
    expect(fromProgram.aspects().g2).toBe('green');

    const partialShift = new SignalController(fourWayNode(), { offsetS: 12 });
    expect(partialShift.phase).toBe(0);
    expect(partialShift.stage).toBe('yellow');

    const negativeShift = new SignalController(fourWayNode(), { offsetS: -15 });
    expect(negativeShift.phase).toBe(3);
    expect(negativeShift.stage).toBe('green');
  });

  it('отвергает небезопасные и некорректные программы', () => {
    const conflictingPhase = fourWayNode();
    conflictingPhase.program = {
      id: 'bad',
      phases: [phase([0, 1], 10, 3, 2)],
      offsetS: 0,
    };
    expect(() => new SignalController(conflictingPhase)).toThrow(/одновременно зелёные/);

    const zeroPhase = fourWayNode();
    zeroPhase.program = { id: 'zero', phases: [phase([0], 0, 0, 0)], offsetS: 0 };
    expect(() => new SignalController(zeroPhase)).toThrow(RangeError);

    const badGroup = fourWayNode();
    badGroup.program = { id: 'bad-group', phases: [phase([9], 10, 3, 2)], offsetS: 0 };
    expect(() => new SignalController(badGroup)).toThrow(RangeError);

    const duplicateMovement = fourWayNode();
    duplicateMovement.movements = [movement('m0', 0), movement('m0', 1)];
    expect(() => new SignalController(duplicateMovement)).toThrow(RangeError);

    const duplicateStopLine = fourWayNode();
    duplicateStopLine.stopLines = [duplicateStopLine.stopLines[0]!, duplicateStopLine.stopLines[0]!];
    expect(() => new SignalController(duplicateStopLine)).toThrow(RangeError);

    expect(() => new SignalController(fourWayNode(), { offsetS: Number.NaN })).toThrow(RangeError);
    const controller = new SignalController(fourWayNode());
    expect(() => controller.update(Number.NaN)).toThrow(RangeError);
    expect(() => controller.update(-0.1)).toThrow(RangeError);
    expect(() => controller.update(0)).not.toThrow();
  });

  it('пешеходная группа без жёлтого аспекта во время жёлтого показывает красный', () => {
    const controller = new SignalController(pedestrianNode());
    expect(controller.aspects()).toEqual({ g0: 'green', g1: 'red' });
    controller.update(10);
    expect(controller.stage).toBe('yellow');
    expect(controller.aspects().g0).toBe('yellow');
    controller.update(3);
    expect(controller.stage).toBe('all-red');
    expect(controller.aspects().g1).toBe('red');
    controller.update(2);
    expect(controller.stage).toBe('green');
    expect(controller.aspects().g1).toBe('green');
    controller.update(8);
    expect(controller.aspects().g1).toBe('red');
  });
});

describe('Signals — занятость, удержание и уже въехавший транспорт', () => {
  it('уже въехавший манёвр сохраняет право закончить и удерживает следующую фазу', () => {
    const controller = new SignalController(fourWayNode());
    expect(controller.canEnter('m0')).toBe(true);
    controller.enter('m0', 0);
    expect(controller.isOccupied('m0')).toBe(true);
    expect(controller.isOccupied()).toBe(true);

    controller.update(15);
    expect(controller.phase).toBe(0);
    expect(controller.stage).toBe('hold');
    expect(controller.aspects()).toEqual({ g0: 'red', g1: 'red', g2: 'red', g3: 'red' });
    // Находящийся в узле транспорт не останавливается красным.
    expect(controller.canEnter('m0')).toBe(true);
    expect(controller.canEnter('m1')).toBe(false);
    expect(controller.snapshot().occupied).toEqual(['m0']);

    controller.exit('m0');
    controller.update(0.05);
    expect(controller.phase).toBe(1);
    expect(controller.stage).toBe('green');
    expect(controller.aspects().g1).toBe('green');
  });

  it('медленный вагон остаётся в узле, пока хвост не пройдёт конец пути', () => {
    const controller = new SignalController(fourWayNode());
    controller.enter('m0');
    let sawHold = false;
    for (let step = 1; step <= 200; step += 1) {
      controller.update(0.1);
      expect(controller.updatePosition('m0', step * 0.1)).toBe('inside');
      if (controller.stage === 'hold') {
        sawHold = true;
        expect(controller.aspects().g1).toBe('red');
      }
    }
    expect(sawHold).toBe(true);
    expect(controller.isOccupied('m0')).toBe(true);
    expect(controller.stage).toBe('hold');

    // Путь 20 м, габарит 4 м: освобождение только после положения 24 м.
    expect(controller.updatePosition('m0', 23.9)).toBe('inside');
    expect(controller.updatePosition('m0', 24.1)).toBe('exited');
    expect(controller.isOccupied('m0')).toBe(false);
    controller.update(0.1);
    expect(controller.phase).toBe(1);
    expect(controller.aspects().g1).toBe('green');
  });

  it('конфликтующая занятость гасит зелёный даже без смены фазы', () => {
    const controller = new SignalController(fourWayNode());
    expect(controller.aspects().g0).toBe('green');
    // Физическое присутствие конфликтующего манёвра (например, нарушителя).
    controller.enter('m1');
    expect(controller.aspects().g0).toBe('red');
    expect(controller.canEnter('m0')).toBe(false);
    controller.exit('m1');
    expect(controller.aspects().g0).toBe('green');
  });

  it('занятый выход запрещает вход даже на зелёном', () => {
    const controller = new SignalController(fourWayNode());
    expect(controller.canEnter('m0', { exitClear: false })).toBe(false);
    controller.setExitBlocked('m0', true);
    expect(controller.isExitBlocked('m0')).toBe(true);
    expect(controller.canEnter('m0')).toBe(false);
    expect(controller.canEnter('m0', { exitClear: true })).toBe(true);
    controller.setExitBlocked('m0', false);
    expect(controller.canEnter('m0')).toBe(true);
    expect(controller.canEnter('m0', { exitDistanceM: 1 })).toBe(false);
    expect(controller.canEnter('m0', { exitDistanceM: 4.6 })).toBe(true);
    expect(controller.canEnter('m0', { exitDistanceM: Number.NaN })).toBe(false);
    expect(controller.canEnter('unknown')).toBe(false);
  });

  it('ведёт занятость по положению и не откатывает позицию назад', () => {
    const controller = new SignalController(fourWayNode());
    expect(controller.updatePosition('m0', -1)).toBe('clear');
    expect(controller.isOccupied('m0')).toBe(false);
    expect(controller.updatePosition('m0', 0)).toBe('entered');
    expect(controller.positionOf('m0')).toBe(0);
    expect(controller.updatePosition('m0', 10)).toBe('inside');
    expect(controller.updatePosition('m0', 9)).toBe('inside');
    expect(controller.positionOf('m0')).toBe(10);
    expect(controller.updatePosition('m0', 12)).toBe('inside');
    expect(controller.updatePosition('m0', 24)).toBe('exited');
    expect(controller.positionOf('m0')).toBeNull();
    expect(controller.isOccupied('m0')).toBe(false);

    expect(controller.enter('m0', 5)).toBe(true);
    expect(controller.enter('unknown')).toBe(false);
    expect(controller.exit('m0')).toBe(true);
    expect(controller.exit('m0')).toBe(false);
    expect(() => controller.updatePosition('unknown', 0)).toThrow(RangeError);
    expect(() => controller.enter('m0', Number.NaN)).toThrow(RangeError);
    expect(() => controller.setExitBlocked('unknown', true)).toThrow(RangeError);
  });

  it('пауза не сбрасывает фазу и разрешения: состояние — чистое', () => {
    const controller = new SignalController(fourWayNode());
    controller.enter('m0', 2);
    const before = controller.snapshot();
    for (let step = 0; step < 100; step += 1) controller.update(0);
    expect(controller.snapshot()).toEqual(before);
    expect(controller.isOccupied('m0')).toBe(true);
    expect(controller.aspects().g0).toBe('green');

    controller.update(0.5);
    expect(controller.snapshot().phase).toBe(0);
    expect(controller.snapshot().occupied).toEqual(['m0']);
    expect(controller.stopLine('m0')?.edgeId).toBe('in:m0');
    expect(controller.stopLine('unknown')).toBeNull();
  });

  it('снимок QA самодостаточен', () => {
    const controller = new SignalController(fourWayNode());
    controller.enter('m2', 3);
    const snapshot = controller.snapshot();
    expect(snapshot.nodeId).toBe('j:test');
    expect(snapshot.phase).toBe(0);
    expect(snapshot.stage).toBe('green');
    expect(snapshot.cyclePositionS).toBe(0);
    expect(snapshot.occupied).toEqual(['m2']);
    expect(Object.keys(snapshot.aspects)).toEqual(['g0', 'g1', 'g2', 'g3']);
    expect(snapshot.movements).toHaveLength(4);
    expect(snapshot.movements[2]).toMatchObject({
      id: 'm2',
      groupId: 'g2',
      occupied: true,
      positionM: 3,
      pathLengthM: 20,
    });
    expect(snapshot.movements[0]).toMatchObject({ id: 'm0', occupied: false, positionM: null });
  });

  it('детерминизм одинаковой последовательности операций', () => {
    const scenario = (): string => {
      const controller = new SignalController(fourWayNode());
      const snapshots = [];
      controller.enter('m0', 1);
      for (let step = 0; step < 80; step += 1) {
        controller.update(0.25);
        controller.updatePosition('m0', step * 0.1);
        snapshots.push(controller.snapshot());
      }
      return JSON.stringify(snapshots);
    };
    expect(scenario()).toBe(scenario());
  });
});
