/**
 * Тесты оркестрации рейсов: плановая фаза при открытии карты, раннее/позднее
 * прибытие, красный/жёлтый у стоп-линии, очередь в одной полосе, занятый выход,
 * рейс после полуночи, смена календаря/даты, восстановление из невидимой
 * области без скачка, независимость от render FPS, лимит maxTrips, детерминизм.
 *
 * Мир теста — чистые данные: рёбра с полосами, остановки, рейсы, светофорные
 * узлы. Никаких моков Three.js/React.
 */

import { describe, expect, it } from 'vitest';
import { SimulationClock } from '../../../src/mobility/clock';
import { TripSimulation, type TripWorld } from '../../../src/mobility/simulation';
import { SignalController } from '../../../src/mobility/signals';
import type {
  MobilityEdge,
  MobilityManifest,
  MobilityPhase,
  MobilityRouteFile,
  MobilityRouteIndexEntry,
  MobilityRouteVariant,
  MobilityServiceCalendar,
  MobilitySignalNode,
  MobilityStopCall,
  MobilityStopTime,
  MobilityTrip,
  MobilityTripSnapshot,
} from '../../../src/shared/mobility';

/* ------------------------------------------------------------------------- */
/* Фикстуры мира.                                                            */
/* ------------------------------------------------------------------------- */

const ALL_DAYS: MobilityServiceCalendar = {
  id: 'cal:all',
  startDate: '2026-01-01',
  endDate: '2027-12-31',
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  timeZone: 'Europe/Minsk',
};

const WEEKDAY: MobilityServiceCalendar = { ...ALL_DAYS, id: 'cal:weekday', weekdays: [1, 2, 3, 4, 5] };
const WEEKEND: MobilityServiceCalendar = { ...ALL_DAYS, id: 'cal:weekend', weekdays: [0, 6] };

function edge(id: string, fromX: number, toX: number): MobilityEdge {
  return {
    id,
    wayId: 1,
    from: `n:${id}:a`,
    to: `n:${id}:b`,
    modes: ['bus', 'tram'],
    oneway: true,
    layer: 0,
    widthM: 6,
    centerline: { p: [fromX, 0, 0, toX, 0, 0], s: [0, toX - fromX] },
    lanes: [{ index: 0, offset: 0, widthM: 3, centerline: { p: [], s: [] } }],
  };
}

function stopCall(seq: number, edgeId: string, s: number, x: number): MobilityStopCall {
  return {
    seq,
    stopId: `s:${seq}`,
    edgeId,
    laneIndex: 0,
    s,
    heading: 0,
    x,
    y: 0,
    h: 0,
    dwellS: 20,
    timed: true,
    binding: 'source-id',
  };
}

function stopTime(seq: number, arrivalS: number, departureS: number): MobilityStopTime {
  return { seq, arrivalS, departureS };
}

function trip(
  id: string,
  variantId: string,
  stopTimes: MobilityStopTime[],
  calendarId = 'cal:all',
): MobilityTrip {
  return { id, variantId, calendarId, stopTimes, complete: false, sourceTripId: id };
}

/** Вариант 0 → 400 → 800 → 1200 м на трёх рёбрах. */
const FOUR_STOP_EDGES = [edge('e0', 0, 400), edge('e1', 400, 800), edge('e2', 800, 1200)];

function fourStopVariant(overrides: Partial<MobilityRouteVariant> = {}): MobilityRouteVariant {
  return {
    id: 'r:test:0:1',
    mode: 'bus',
    ref: '1',
    headSign: 'Тест',
    direction: 0,
    edges: ['e0', 'e1', 'e2'],
    stops: [
      stopCall(0, 'e0', 0, 0),
      stopCall(1, 'e1', 0, 400),
      stopCall(2, 'e2', 0, 800),
      stopCall(3, 'e2', 400, 1200),
    ],
    lengthM: 1200,
    sourceRelationId: 1,
    verified: true,
    bounds: [0, 0, 1200, 0],
    ...overrides,
  };
}

/** Вариант 0 → 1000 м (ребро e0 0..500 + e1 500..1000). */
const TWO_STOP_EDGES = [edge('e0', 0, 500), edge('e1', 500, 1000)];

function twoStopVariant(): MobilityRouteVariant {
  return {
    ...fourStopVariant(),
    edges: ['e0', 'e1'],
    stops: [stopCall(0, 'e0', 0, 0), stopCall(1, 'e1', 500, 1000)],
    lengthM: 1000,
    bounds: [0, 0, 1000, 0],
  };
}

function standardTrip(id: string, base = 1000): MobilityTrip {
  return trip(id, 'r:test:0:1', [
    stopTime(0, base, base + 10),
    stopTime(1, base + 90, base + 110),
    stopTime(2, base + 190, base + 210),
    stopTime(3, base + 290, base + 290),
  ]);
}

function routeEntry(variant: MobilityRouteVariant, trips: readonly MobilityTrip[]): MobilityRouteIndexEntry {
  return {
    id: variant.id,
    mode: variant.mode,
    ref: variant.ref,
    headSign: variant.headSign,
    direction: variant.direction,
    file: `routes/${variant.id}.json`,
    bounds: variant.bounds,
    lengthM: variant.lengthM,
    verified: true,
    stops: variant.stops.length,
    trips: trips.length,
    calendars: [...new Set(trips.map((item) => item.calendarId))],
  };
}

function manifestWith(
  calendars: readonly MobilityServiceCalendar[],
  routes: readonly MobilityRouteIndexEntry[],
): MobilityManifest {
  return {
    version: 1,
    generatedAt: '2026-11-16T00:00:00Z',
    epsg: 32635,
    originUtm: [0, 0],
    chunkSize: 512,
    bounds: [-10_000, -10_000, 10_000, 10_000],
    chunks: [],
    routes: [...routes],
    signalNodes: [],
    calendars: [...calendars],
    release: { network: 'net', schedule: 'sched', bindings: 'bind' },
    provenance: [],
    scheduleStatus: 'synthetic',
    counts: {
      edges: 3,
      stops: 4,
      signalNodes: 0,
      variants: routes.length,
      trips: routes.reduce((sum, entry) => sum + entry.trips, 0),
      verifiedVariants: routes.length,
    },
  };
}

class FakeWorld implements TripWorld {
  readonly edges = new Map<string, MobilityEdge>();
  readonly routeFiles = new Map<string, MobilityRouteFile>();
  variants: MobilityRouteIndexEntry[] = [];
  signalEntries: { nodeId: string; x: number; y: number; controller: SignalController }[] = [];
  manifestValue: MobilityManifest | null = null;
  loaded = true;
  routeReads = 0;

  getRouteFile(variantId: string): MobilityRouteFile | null {
    this.routeReads += 1;
    if (!this.loaded) return null;
    return this.routeFiles.get(variantId) ?? null;
  }

  getVariants(): readonly MobilityRouteIndexEntry[] {
    return this.variants;
  }

  getEdge(edgeId: string): MobilityEdge | null {
    return this.edges.get(edgeId) ?? null;
  }

  getSignalsNear(
    x: number,
    y: number,
    radiusM: number,
  ): ReadonlyArray<{ nodeId: string; x: number; y: number; controller: SignalController }> {
    const radius = Math.max(0, radiusM);
    return this.signalEntries.filter(
      (entry) => Math.hypot(entry.x - x, entry.y - y) <= radius,
    );
  }

  getManifest(): MobilityManifest | null {
    return this.manifestValue;
  }
}

interface SignalFixture {
  node: MobilitySignalNode;
  offsetS: number;
}

/** Светофор с одним автомобильным манёвром; программы: зелёный / красный / жёлтый. */
function signalFixture(options: {
  lineX: number;
  approachEdgeId: string;
  kind: 'green' | 'red' | 'yellow';
  movementPathM?: number;
}): SignalFixture {
  const pathLength = options.movementPathM ?? 20;
  const greenPhase: MobilityPhase = { green: [0], greenS: 600, yellowS: 0, allRedS: 0 };
  const redPhase: MobilityPhase = { green: [1], greenS: 600, yellowS: 0, allRedS: 0 };
  const yellowPhase: MobilityPhase = { green: [0], greenS: 100, yellowS: 50, allRedS: 0 };
  const yellowOther: MobilityPhase = { green: [1], greenS: 100, yellowS: 50, allRedS: 0 };
  const phases =
    options.kind === 'green'
      ? [greenPhase, redPhase]
      : options.kind === 'red'
        ? [redPhase, greenPhase]
        : [yellowPhase, yellowOther];
  const offsetS = options.kind === 'yellow' ? 130 : 0;
  const node: MobilitySignalNode = {
    id: 'j:test',
    kind: 'junction',
    x: options.lineX,
    y: 0,
    groups: [
      { id: 'g0', kind: 'vehicle', aspects: ['green', 'yellow'] },
      { id: 'g1', kind: 'pedestrian', aspects: ['green'] },
    ],
    movements: [
      {
        id: 'm0',
        kind: 'vehicle',
        approach: { edgeId: options.approachEdgeId, laneIndex: 0 },
        exitEdgeId: '',
        path: {
          p: [options.lineX, 0, 0, options.lineX + pathLength, 0, 0],
          s: [0, pathLength],
        },
        group: 0,
        clearanceLengthM: 12,
      },
    ],
    stopLines: [
      {
        movement: 0,
        edgeId: options.approachEdgeId,
        laneIndex: 0,
        s: 10,
        line: [options.lineX, -2, 0, options.lineX, 2, 0],
        heading: 0,
      },
    ],
    heads: [],
    program: { id: 'test-program', phases, offsetS },
    conflicts: [],
  };
  return { node, offsetS };
}

interface FleetOptions {
  variant: MobilityRouteVariant;
  trips: MobilityTrip[];
  edges?: MobilityEdge[];
  /** false — геометрия рёбер ещё не загружена (явный fallback по остановкам). */
  geometryLoaded?: boolean;
  signals?: SignalFixture[];
  maxTrips?: number;
  calendars?: readonly MobilityServiceCalendar[];
  fixedDate?: string;
  fixedTimeSeconds?: number;
}

interface Fleet {
  world: FakeWorld;
  clock: SimulationClock;
  sim: TripSimulation;
}

function createFleet(options: FleetOptions): Fleet {
  const world = new FakeWorld();
  const edges = options.edges ?? FOUR_STOP_EDGES;
  if (options.geometryLoaded !== false) {
    for (const item of edges) world.edges.set(item.id, item);
  }
  const file: MobilityRouteFile = { version: 1, variant: options.variant, trips: options.trips };
  world.routeFiles.set(options.variant.id, file);
  world.variants = [routeEntry(options.variant, options.trips)];
  const calendars = options.calendars ?? [ALL_DAYS];
  world.manifestValue = manifestWith(calendars, world.variants);
  for (const fixture of options.signals ?? []) {
    const controller = new SignalController(fixture.node, { offsetS: fixture.offsetS });
    world.signalEntries.push({
      nodeId: fixture.node.id,
      x: fixture.node.x,
      y: fixture.node.y,
      controller,
    });
  }
  const clock = new SimulationClock({
    stepHz: 10,
    fixedDate: options.fixedDate ?? '2026-11-16',
    fixedTimeSeconds: options.fixedTimeSeconds ?? 1000,
  });
  const sim = new TripSimulation({
    clock,
    world,
    maxTrips: options.maxTrips ?? 32,
  });
  sim.reinitialize();
  return { world, clock, sim };
}

function advance(fleet: Fleet, steps: number, onStep?: (index: number) => void): void {
  for (let index = 0; index < steps; index += 1) {
    fleet.clock.step(1);
    for (const entry of fleet.world.signalEntries) {
      entry.controller.update(fleet.clock.stepSeconds);
    }
    fleet.sim.step(fleet.clock.stepSeconds);
    onStep?.(index);
  }
}

function snapshotOf(fleet: Fleet, tripId: string): MobilityTripSnapshot | null {
  return fleet.sim.snapshots().find((item) => item.tripId === tripId) ?? null;
}

/* ------------------------------------------------------------------------- */
/* Сценарии.                                                                 */
/* ------------------------------------------------------------------------- */

describe('TripSimulation — плановая фаза и остановки', () => {
  it('при открытии карты ставит рейс в плановую фазу, а не на конечную', () => {
    const fleet = createFleet({ variant: fourStopVariant(), trips: [standardTrip('t:a')] });
    fleet.clock.setFixedDateTime('2026-11-16', 1050);
    fleet.sim.reinitialize();

    const opened = snapshotOf(fleet, 't:a');
    expect(opened).not.toBeNull();
    expect(opened?.nextStop).toBe(1);
    // Середина первого перегона (1010 → 1090 с, 400 м), а не x=0 и не x=1200.
    expect(opened?.x ?? 0).toBeGreaterThan(150);
    expect(opened?.x ?? 0).toBeLessThan(250);

    advance(fleet, 1);
    const stepped = snapshotOf(fleet, 't:a');
    expect(stepped?.x ?? 0).toBeGreaterThanOrEqual(opened?.x ?? 0);
    expect(stepped?.x ?? 0).toBeLessThan(400);
    expect(stepped?.drawn).toBe(false);
    expect(stepped?.routeVariant).toBe('r:test:0:1');
    expect(stepped?.ref).toBe('1');
    expect(stepped?.mode).toBe('bus');
  });

  it('раннее прибытие — стоянка и ожидание планового отправления', () => {
    const fleet = createFleet({
      variant: fourStopVariant(),
      trips: [
        trip('t:early', 'r:test:0:1', [
          stopTime(0, 1000, 1010),
          stopTime(1, 1400, 1420),
          stopTime(2, 1800, 1820),
          stopTime(3, 2200, 2200),
        ]),
      ],
    });
    advance(fleet, 2000); // t = 1200 с: машина давно у остановки 1, но отправление в 1420
    const waiting = snapshotOf(fleet, 't:early');
    expect(waiting).not.toBeNull();
    expect(waiting?.x ?? 0).toBeCloseTo(400, 1);
    expect(waiting?.speed ?? 1).toBe(0);
    expect(['dwelling', 'waiting']).toContain(waiting?.phase);
    expect(waiting?.delayS ?? 1).toBe(0);

    advance(fleet, 2400); // t = 1440 с: отправление уже прошло
    const departed = snapshotOf(fleet, 't:early');
    expect(departed?.x ?? 0).toBeGreaterThan(401);
    expect(departed?.delayS ?? 1).toBe(0);
  });

  it('позднее прибытие фиксирует задержку, не разгоняя сверх лимита', () => {
    const fleet = createFleet({
      variant: fourStopVariant(),
      trips: [
        trip('t:late', 'r:test:0:1', [
          stopTime(0, 1000, 1010),
          stopTime(1, 1025, 1045),
          stopTime(2, 1100, 1120),
          stopTime(3, 1180, 1180),
        ]),
      ],
    });
    let previousX = 0;
    const maxStep = 14 * fleet.clock.stepSeconds + 0.01;
    advance(fleet, 700, () => {
      const snap = snapshotOf(fleet, 't:late');
      if (!snap) return;
      expect(snap.x).toBeGreaterThanOrEqual(previousX - 1e-6);
      expect(snap.x - previousX).toBeLessThanOrEqual(maxStep);
      expect(snap.speed).toBeLessThanOrEqual(14 + 1e-9);
      previousX = snap.x;
    });
    // На 1070 с рейс уже отправился со первой остановки позже плана.
    expect(fleet.sim.getDelays()['t:late'] ?? 0).toBeGreaterThan(5);
    const snap = snapshotOf(fleet, 't:late');
    expect(snap).not.toBeNull();
    expect(snap?.delayS ?? 0).toBeGreaterThan(5);
  });

  it('завершает рейс на конечной и различает finished/nextStop', () => {
    const fleet = createFleet({
      variant: fourStopVariant(),
      trips: [standardTrip('t:end')],
    });
    // Последняя остановка: прибытие ~1290, стоянка по dwellS (20 с), затем финиш.
    let finished: MobilityTripSnapshot | null = null;
    for (let attempt = 0; attempt < 400 && !finished; attempt += 1) {
      advance(fleet, 10);
      const candidate = snapshotOf(fleet, 't:end');
      if (candidate?.phase === 'finished') finished = candidate;
    }
    expect(finished).not.toBeNull();
    expect(finished?.nextStop).toBe(-1);
    advance(fleet, 40); // ещё 4 с — завершённый рейс убран из снимков
    expect(snapshotOf(fleet, 't:end')).toBeNull();
    expect(fleet.sim.getStats().activeTrips).toBe(0);
  });
});

describe('TripSimulation — светофоры', () => {
  it('красный запрещает въезд даже по расписанию: остановка до стоп-линии', () => {
    const signal = signalFixture({ lineX: 200, approachEdgeId: 'e0', kind: 'red' });
    const fleet = createFleet({
      variant: fourStopVariant(),
      trips: [standardTrip('t:red')],
      signals: [signal],
    });
    advance(fleet, 600); // t = 1060 с
    const snap = snapshotOf(fleet, 't:red');
    expect(snap).not.toBeNull();
    expect(snap?.speed ?? 1).toBe(0);
    expect(snap?.phase).toBe('signal');
    // Передний габарит не пересёк стоп-линию.
    expect((snap?.x ?? 0) + 6).toBeLessThanOrEqual(200 + 0.06);
    expect(signal.node.id).toBe('j:test');
    const controller = fleet.world.signalEntries[0]?.controller;
    expect(controller?.isOccupied('m0')).toBe(false);
  });

  it('зелёный пропускает узел и ведёт занятость манёвра, а не только аспект', () => {
    const signal = signalFixture({ lineX: 200, approachEdgeId: 'e0', kind: 'green' });
    const fleet = createFleet({
      variant: fourStopVariant(),
      trips: [standardTrip('t:green')],
      signals: [signal],
    });
    const controller = fleet.world.signalEntries[0]?.controller;
    let sawOccupied = false;
    let sawCleared = false;
    advance(fleet, 900, () => {
      if (!controller) return;
      if (controller.isOccupied('m0')) sawOccupied = true;
      else if (sawOccupied) sawCleared = true;
    });
    expect(sawOccupied).toBe(true);
    expect(sawCleared).toBe(true);
    const snap = snapshotOf(fleet, 't:green');
    expect(snap?.x ?? 0).toBeGreaterThan(200);
  });

  it('жёлтый: успевает остановиться — тормозит до стоп-линии', () => {
    // Высокая скорость у жёлтого: до линии 94 м, тормозной путь на 14 м/с ≈ 40 м.
    const signal = signalFixture({ lineX: 600, approachEdgeId: 'e1', kind: 'yellow' });
    const fleet = createFleet({
      variant: twoStopVariant(),
      trips: [
        trip('t:yellow-stop', 'r:test:0:1', [stopTime(0, 0, 0), stopTime(1, 60, 60)]),
      ],
      edges: TWO_STOP_EDGES,
      signals: [signal],
      fixedTimeSeconds: 30,
    });
    advance(fleet, 140); // 14 с: решение «стоять» зафиксировано, машина затормозила
    const snap = snapshotOf(fleet, 't:yellow-stop');
    expect(snap).not.toBeNull();
    expect(snap?.phase).toBe('signal');
    expect(snap?.speed ?? 1).toBeLessThan(0.02);
    expect((snap?.x ?? 0) + 6).toBeLessThanOrEqual(600 + 0.06);
    expect((snap?.x ?? 0) + 6).toBeGreaterThan(590);
  });

  it('жёлтый: остановиться нельзя — продолжает движение', () => {
    // До линии 24 м при 14 м/с: тормозной путь ≈ 40 м, безопасно остановиться нельзя.
    const signal = signalFixture({ lineX: 530, approachEdgeId: 'e1', kind: 'yellow' });
    const fleet = createFleet({
      variant: twoStopVariant(),
      trips: [
        trip('t:yellow-go', 'r:test:0:1', [stopTime(0, 0, 0), stopTime(1, 60, 60)]),
      ],
      edges: TWO_STOP_EDGES,
      signals: [signal],
      fixedTimeSeconds: 30,
    });
    advance(fleet, 20); // 2 с: 14 м/с успевает пересечь линию
    const snap = snapshotOf(fleet, 't:yellow-go');
    expect(snap).not.toBeNull();
    expect((snap?.x ?? 0) + 6).toBeGreaterThan(530);
    expect(snap?.phase).not.toBe('signal');
  });

  it('занятый выход блокирует въезд даже на зелёном', () => {
    // Лидер стоит в 15 м за стоп-линией; до его кормы 9 м — меньше габарита.
    const leaderEdge = edge('e1', 200, 800);
    const variant: MobilityRouteVariant = {
      ...fourStopVariant(),
      edges: ['e0', 'e1'],
      stops: [stopCall(0, 'e0', 0, 0), stopCall(1, 'e1', 15, 215), stopCall(2, 'e1', 600, 800)],
      lengthM: 800,
      bounds: [0, 0, 800, 0],
    };
    const signal = signalFixture({
      lineX: 200,
      approachEdgeId: 'e0',
      kind: 'green',
      movementPathM: 5,
    });
    const fleet = createFleet({
      variant,
      edges: [edge('e0', 0, 200), leaderEdge],
      trips: [
        trip('t:leader', variant.id, [
          stopTime(0, 1000, 1000),
          stopTime(1, 1010, 1200),
          stopTime(2, 1260, 1260),
        ]),
        trip('t:follower', variant.id, [
          stopTime(0, 1005, 1005),
          stopTime(1, 1040, 1060),
          stopTime(2, 1100, 1100),
        ]),
      ],
      signals: [signal],
    });
    advance(fleet, 800); // t = 1080 с: лидер ещё стоит на остановке 1
    const follower = snapshotOf(fleet, 't:follower');
    const leader = snapshotOf(fleet, 't:leader');
    expect(leader).not.toBeNull();
    expect(leader?.x ?? 0).toBeCloseTo(215, 1);
    expect(follower).not.toBeNull();
    expect(follower?.phase).toBe('signal');
    expect(follower?.speed ?? 1).toBe(0);
    expect((follower?.x ?? 0) + 6).toBeLessThanOrEqual(200 + 0.06);
    const controller = fleet.world.signalEntries[0]?.controller;
    expect(controller?.isOccupied('m0')).toBe(false);
  });
});

describe('TripSimulation — очередь и лимиты', () => {
  it('держит зазор за впереди идущей машиной в той же полосе', () => {
    const fleet = createFleet({
      variant: fourStopVariant(),
      trips: [
        trip('t:a', 'r:test:0:1', [
          stopTime(0, 1000, 1000),
          stopTime(1, 1080, 1100),
          stopTime(2, 1180, 1200),
          stopTime(3, 1280, 1280),
        ]),
        trip('t:b', 'r:test:0:1', [
          stopTime(0, 1010, 1010),
          stopTime(1, 1070, 1090),
          stopTime(2, 1170, 1190),
          stopTime(3, 1270, 1270),
        ]),
      ],
    });
    let minGap = Number.POSITIVE_INFINITY;
    advance(fleet, 1400, () => {
      const a = snapshotOf(fleet, 't:a');
      const b = snapshotOf(fleet, 't:b');
      if (!a || !b) return;
      const gap = Math.abs(a.x - b.x) - 12;
      if (gap < minGap) minGap = gap;
    });
    expect(minGap).toBeGreaterThanOrEqual(3 - 0.1);
    expect(fleet.sim.getDelays()['t:b'] ?? 0).toBeGreaterThan(0);
    // Машины не совпали и не проехали друг сквозь друга.
    const a = snapshotOf(fleet, 't:a');
    const b = snapshotOf(fleet, 't:b');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(Math.abs((a?.x ?? 0) - (b?.x ?? 0))).toBeGreaterThanOrEqual(12 + 2.9);
  });

  it('лимит maxTrips: лишние рейсы аналитические, порядок детерминирован', () => {
    const variant = twoStopVariant();
    const makeTrip = (index: number): MobilityTrip =>
      trip(`t:${index}`, variant.id, [stopTime(0, 1000 + index, 1000 + index), stopTime(1, 2000, 2000)]);
    const fleet = createFleet({
      variant,
      trips: [makeTrip(0), makeTrip(1), makeTrip(2), makeTrip(3)],
      edges: TWO_STOP_EDGES,
      maxTrips: 2,
      fixedTimeSeconds: 1100,
    });
    advance(fleet, 1);
    const stats = fleet.sim.getStats();
    expect(stats.modelledTrips).toBe(2);
    expect(stats.analyticTrips).toBe(2);
    expect(stats.activeTrips).toBe(4);
    const ids = fleet.sim.snapshots().map((item) => item.tripId);
    expect(ids).toEqual(['t:0', 't:1', 't:2', 't:3']);
    expect(stats.approximatedVariants).toBe(0);
    expect(stats.calendarSource).toBe('manifest');
  });
});

describe('TripSimulation — календарь, полночь и невидимая область', () => {
  it('рейс после полуночи продолжается без сброса и разворота', () => {
    const variant = twoStopVariant();
    const fleet = createFleet({
      variant,
      edges: TWO_STOP_EDGES,
      trips: [
        trip('t:night', variant.id, [stopTime(0, 86_390, 86_400), stopTime(1, 86_600, 86_620)]),
      ],
      fixedDate: '2026-11-21',
      fixedTimeSeconds: 86_390,
    });
    advance(fleet, 100); // ровно полночь (следующая календарная дата)
    expect(fleet.clock.serviceDate).toBe('2026-11-22');
    advance(fleet, 200); // t ≈ 00:00:30 следующих суток
    const snap = snapshotOf(fleet, 't:night');
    expect(snap).not.toBeNull();
    expect(snap?.nextStop).toBe(1);
    expect(snap?.x ?? 0).toBeGreaterThan(0);
    expect(snap?.x ?? 0).toBeLessThan(1000);
    expect(snap?.delayS ?? 1).toBe(0);
    expect(snap?.speed ?? 0).toBeGreaterThan(0);
  });

  it('смена календаря/даты меняет назначенные рейсы (явная и автоматическая)', () => {
    const variant = fourStopVariant();
    const weekday = trip('t:weekday', variant.id, standardTrip('x').stopTimes, 'cal:weekday');
    const weekend = trip('t:weekend', variant.id, standardTrip('x').stopTimes, 'cal:weekend');
    const fleet = createFleet({
      variant,
      trips: [weekday, weekend],
      calendars: [WEEKDAY, WEEKEND],
      fixedDate: '2026-11-21', // суббота
      fixedTimeSeconds: 1000,
    });
    fleet.sim.reinitialize();
    expect(fleet.sim.getStats().scheduledToday).toBe(1);
    advance(fleet, 1);
    expect(fleet.sim.snapshots().map((item) => item.tripId)).toEqual(['t:weekend']);

    // Явная переинициализация на понедельник.
    fleet.clock.setFixedDateTime('2026-11-23', 1000);
    fleet.sim.reinitialize();
    advance(fleet, 1);
    expect(fleet.sim.getStats().scheduledToday).toBe(1);
    expect(fleet.sim.snapshots().map((item) => item.tripId)).toEqual(['t:weekday']);

    // Автоматическое обнаружение сброса часов (без reinitialize).
    fleet.clock.setFixedDateTime('2026-11-21', 1000);
    advance(fleet, 1);
    expect(fleet.sim.snapshots().map((item) => item.tripId)).toEqual(['t:weekend']);
  });

  it('возвращение из невидимой области без скачка и без потери задержки', () => {
    const fleet = createFleet({
      variant: fourStopVariant(),
      trips: [
        trip('t:late', 'r:test:0:1', [
          stopTime(0, 1000, 1010),
          stopTime(1, 1025, 1045),
          stopTime(2, 1100, 1120),
          stopTime(3, 1180, 1180),
        ]),
      ],
    });
    advance(fleet, 700); // t = 1070 с, задержка уже зафиксирована
    const beforeHide = snapshotOf(fleet, 't:late');
    const delayBefore = fleet.sim.getDelays()['t:late'] ?? 0;
    expect(beforeHide).not.toBeNull();
    expect(delayBefore).toBeGreaterThan(0);

    // Файл варианта выгружен (камера ушла): рейс живёт аналитически.
    fleet.world.loaded = false;
    advance(fleet, 20); // 2 с
    expect(snapshotOf(fleet, 't:late')).toBeNull();
    expect(fleet.sim.getDelays()['t:late'] ?? 0).toBeCloseTo(delayBefore, 6);

    // Файл снова загружен: состояние согласуется по плановой фазе + задержке.
    fleet.world.loaded = true;
    advance(fleet, 1);
    const afterReload = snapshotOf(fleet, 't:late');
    expect(afterReload).not.toBeNull();
    expect(afterReload?.delayS ?? 0).toBeCloseTo(delayBefore, 6);
    const jump = Math.abs((afterReload?.x ?? 0) - (beforeHide?.x ?? 0));
    expect(jump).toBeLessThan(50);
    expect(afterReload?.x ?? 0).toBeGreaterThan(400);
  });

  it('внутрь занятой конфликтной зоны не возникает', () => {
    const signal = signalFixture({ lineX: 200, approachEdgeId: 'e0', kind: 'green' });
    const fleet = createFleet({
      variant: fourStopVariant(),
      trips: [standardTrip('t:zone')],
      signals: [signal],
    });
    const controller = fleet.world.signalEntries[0]?.controller;
    expect(controller).not.toBeUndefined();
    // Чужой манёвр уже занимает конфликтную зону; рейс как раз внутри неё.
    controller?.enter('m0', 5);

    fleet.clock.setFixedDateTime('2026-11-16', 1040); // x ≈ 150 м, до линии 50 м
    fleet.sim.reinitialize();
    advance(fleet, 400); // 40 с: рейс доезжает до занятой зоны и ждёт перед линией
    const snap = snapshotOf(fleet, 't:zone');
    expect(snap).not.toBeNull();
    // Внутрь занятой зоны не встал: перед линией (передний габарит ≤ 200).
    expect((snap?.x ?? 0) + 6).toBeLessThanOrEqual(200 + 0.06);
    expect(['signal', 'waiting']).toContain(snap?.phase);
  });
});

describe('TripSimulation — загрузка геометрии и явные состояния данных', () => {
  it('догруженные полосы рёбер заменяют fallback на точный путь', () => {
    const fleet = createFleet({
      variant: fourStopVariant(),
      trips: [standardTrip('t:geo')],
      geometryLoaded: false,
    });
    const fallback = fleet.sim.getStats();
    expect(fallback.approximatedVariants).toBe(1);
    expect(fleet.sim.getNotes().some((note) => note.includes('fallback'))).toBe(true);

    advance(fleet, 300); // 30 с по fallback-хорде
    const before = snapshotOf(fleet, 't:geo');
    expect(before).not.toBeNull();
    expect(Number.isFinite(before?.x)).toBe(true);

    // Полосатая геометрия догрузилась — путь пересобирается без перезапуска.
    for (const item of FOUR_STOP_EDGES) fleet.world.edges.set(item.id, item);
    advance(fleet, 2);
    expect(fleet.sim.getStats().approximatedVariants).toBe(0);
    expect(fleet.sim.getNotes().some((note) => note.includes('точный'))).toBe(true);
    const after = snapshotOf(fleet, 't:geo');
    expect(after).not.toBeNull();
    expect(Number.isFinite(after?.x)).toBe(true);
    expect(after?.delayS ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('отсутствие manifest-календарей — явный ежедневный режим, а не пустота', () => {
    const fleet = createFleet({
      variant: fourStopVariant(),
      trips: [
        trip('t:weekday', 'r:test:0:1', standardTrip('x').stopTimes, 'cal:weekday'),
        trip('t:weekend', 'r:test:0:1', standardTrip('x').stopTimes, 'cal:weekend'),
      ],
      calendars: [],
    });
    // Даже без календарей рейсы не теряются: ежедневный режим со сворачиванием
    // одинаковых прогонов разных календарей; причина записана в notes.
    expect(fleet.sim.getStats().calendarSource).toBe('fallback');
    expect(fleet.sim.getStats().scheduledToday).toBe(1);
    expect(
      fleet.sim.getNotes().some((note) => note.includes('ежедневный режим')),
    ).toBe(true);
    advance(fleet, 1);
    expect(fleet.sim.snapshots().length).toBe(1);
  });
});

describe('TripSimulation — детерминизм и render FPS', () => {
  it('разный render FPS при одинаковом фиксированном шаге даёт одинаковое состояние', () => {
    const make = (): Fleet =>
      createFleet({
        variant: fourStopVariant(),
        trips: [
          trip('t:fix', 'r:test:0:1', [
            stopTime(0, 1000, 1010),
            stopTime(1, 1400, 1420),
            stopTime(2, 1800, 1820),
            stopTime(3, 2200, 2200),
          ]),
        ],
      });
    const fast = make();
    const slow = make();
    // 20 FPS: шаг 0.05 с; 10 FPS: шаг 0.1 с. Одинаковое модельное время.
    for (let frame = 0; frame < 100; frame += 1) {
      const steps = fast.clock.advance(0.05);
      for (let step = 0; step < steps; step += 1) fast.sim.step(fast.clock.stepSeconds);
    }
    for (let frame = 0; frame < 50; frame += 1) {
      const steps = slow.clock.advance(0.1);
      for (let step = 0; step < steps; step += 1) slow.sim.step(slow.clock.stepSeconds);
    }
    expect(fast.clock.stepCount).toBe(slow.clock.stepCount);
    expect(fast.clock.serviceSecondsExact).toBeCloseTo(slow.clock.serviceSecondsExact, 6);
    expect(JSON.stringify(fast.sim.snapshots())).toBe(JSON.stringify(slow.sim.snapshots()));
    expect(fast.sim.getDelays()).toEqual(slow.sim.getDelays());
  });

  it('два одинаковых прогона дают одинаковые снимки и задержки', () => {
    const make = (): Fleet =>
      createFleet({
        variant: fourStopVariant(),
        trips: [
          trip('t:a', 'r:test:0:1', [
            stopTime(0, 1000, 1000),
            stopTime(1, 1080, 1100),
            stopTime(2, 1180, 1200),
            stopTime(3, 1280, 1280),
          ]),
          trip('t:b', 'r:test:0:1', [
            stopTime(0, 1010, 1010),
            stopTime(1, 1070, 1090),
            stopTime(2, 1170, 1190),
            stopTime(3, 1270, 1270),
          ]),
        ],
      });
    const first = make();
    const second = make();
    advance(first, 800);
    advance(second, 800);
    expect(JSON.stringify(first.sim.snapshots())).toBe(JSON.stringify(second.sim.snapshots()));
    expect(first.sim.getDelays()).toEqual(second.sim.getDelays());
    expect(first.sim.getStats()).toEqual(second.sim.getStats());
  });
});
