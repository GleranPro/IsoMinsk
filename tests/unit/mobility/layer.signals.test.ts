/**
 * Слой светофоров: сборка узлов, аспекты по группам, видимость отдельно от
 * правил, экранный LOD с гистерезисом и бюджет узлов.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type {
  MobilityManifest,
  MobilitySignalNode,
  MobilitySignalGroup,
  MobilityTrafficKind,
  MobilityTripSnapshot,
} from '../../../src/shared/mobility';
import {
  MOBILITY_LOD,
  MOBILITY_SIGNAL_BASE_Y,
  MobilityLayer,
  type MobilitySignalSource,
  type MobilitySignalState,
  type MobilityView,
} from '../../../src/engine/mobility/mobilityLayer';
import {
  SIGNAL_ASPECT_COLORS,
  signalHeadCentreY,
} from '../../../src/city/mobility/signalGeometry';
import { MobilityLoader, type MobilityFetchResponse } from '../../../src/engine/mobility/loader';

function group(id: string, kind: MobilityTrafficKind): MobilitySignalGroup {
  return { id, kind, aspects: kind === 'pedestrian' ? ['red', 'green'] : ['red', 'yellow', 'green'] };
}

function node(
  id: string,
  x: number,
  y: number,
  heads: { id: string; group: number; kind: MobilityTrafficKind; facing?: number; heightM?: number }[],
): MobilitySignalNode {
  return {
    id,
    kind: 'junction',
    x,
    y,
    groups: [group('g0', 'vehicle'), group('ped0', 'pedestrian'), group('tram0', 'tram')],
    movements: [],
    stopLines: [],
    heads: heads.map((head) => ({
      id: head.id,
      group: head.group,
      x,
      y,
      facing: head.facing ?? 0,
      kind: head.kind,
      heightM: head.heightM ?? 2.6,
    })),
    program: { id: 'test-v1', phases: [], offsetS: 0 },
    conflicts: [],
  };
}

class FakeSignalSource implements MobilitySignalSource {
  revision = 1;
  constructor(public nodes: readonly MobilitySignalNode[]) {}
  getSignalNodes(): readonly MobilitySignalNode[] {
    return this.nodes;
  }
}

function trip(overrides: Partial<MobilityTripSnapshot> = {}): MobilityTripSnapshot {
  return {
    tripId: 't1',
    variantId: 'v1',
    mode: 'bus',
    ref: '1',
    phase: 'moving',
    x: 0,
    y: 0,
    h: 0,
    heading: 0,
    speed: 8,
    delayS: 0,
    nextStop: 0,
    routeVariant: 'v1',
    drawn: false,
    ...overrides,
  };
}

function view(overrides: Partial<MobilityView> = {}): MobilityView {
  return {
    rect: { minX: -200, maxX: 200, minZ: -200, maxZ: 200 },
    time: 36000,
    worldPerPixel: 0.5,
    trips: [trip()],
    signals: [],
    step: 1,
    ...overrides,
  };
}

function signalMesh(layer: MobilityLayer, name: string): THREE.InstancedMesh {
  const mesh = layer.root.getObjectByName(name);
  if (!(mesh instanceof THREE.InstancedMesh)) throw new Error(`нет батча ${name}`);
  return mesh;
}

const junction = node('j:1', 10, 20, [
  { id: 'h0', group: 0, kind: 'vehicle', facing: Math.PI / 2 },
  { id: 'h1', group: 1, kind: 'pedestrian', facing: 0 },
]);

const aspectState: MobilitySignalState[] = [
  { nodeId: 'j:1', aspects: { g0: 'green', ped0: 'red' } },
];

describe('MobilityLayer signals', () => {
  it('builds head/pole/lens instances from MobilitySignalNode and facing', () => {
    const source = new FakeSignalSource([junction]);
    const layer = new MobilityLayer({ signalSource: source, maxSignalNodes: 8 });
    try {
      layer.update(0, view({ signals: aspectState }));
      const stats = layer.getStats();
      expect(stats.signalNodes).toBe(1);
      expect(stats.signalNodesDrawn).toBe(1);
      expect(stats.signalHeadsDrawn).toBe(2);
      expect(stats.unknownAspects).toBe(0);
      expect(signalMesh(layer, 'mobility-signal-poles').count).toBe(2);
      expect(signalMesh(layer, 'mobility-signal-housing-vehicle').count).toBe(1);
      expect(signalMesh(layer, 'mobility-signal-housing-pedestrian').count).toBe(1);
      const vehicleLens = signalMesh(layer, 'mobility-signal-lens-vehicle');
      expect(vehicleLens.count).toBe(1);

      const matrix = new THREE.Matrix4();
      vehicleLens.getMatrixAt(0, matrix);
      const expected = new THREE.Color(SIGNAL_ASPECT_COLORS.green);
      const color = new THREE.Color();
      vehicleLens.getColorAt(0, color);
      expect(color.r).toBeCloseTo(expected.r, 4);
      expect(color.g).toBeCloseTo(expected.g, 4);
      expect(color.b).toBeCloseTo(expected.b, 4);

      // Стойка стоит в локальной точке узла: world = (x, base, −y).
      const housing = signalMesh(layer, 'mobility-signal-housing-vehicle');
      housing.getMatrixAt(0, matrix);
      const spec = signalHeadCentreY('vehicle', 2.6);
      expect(matrix.elements[12]).toBeCloseTo(10, 4);
      expect(matrix.elements[13]).toBeCloseTo(MOBILITY_SIGNAL_BASE_Y + spec, 4);
      expect(matrix.elements[14]).toBeCloseTo(-20, 4);
    } finally {
      layer.dispose();
    }
  });

  it('shows signals only in the near view and keeps hysteresis while zooming out', () => {
    const source = new FakeSignalSource([junction]);
    const layer = new MobilityLayer({ signalSource: source });
    try {
      const frame = (worldPerPixel: number) =>
        layer.update(0, view({ worldPerPixel, signals: aspectState }));
      frame(MOBILITY_LOD.signalEnterWpp - 0.05);
      expect(layer.getStats().signalHeadsDrawn).toBe(2);
      frame(MOBILITY_LOD.signalExitWpp - 0.05);
      expect(layer.getStats().signalHeadsDrawn).toBe(2);
      frame(MOBILITY_LOD.signalExitWpp + 0.1);
      expect(layer.getStats().signalHeadsDrawn).toBe(0);
      frame(MOBILITY_LOD.signalEnterWpp + 0.1);
      expect(layer.getStats().signalHeadsDrawn).toBe(0);
      frame(MOBILITY_LOD.signalEnterWpp - 0.05);
      expect(layer.getStats().signalHeadsDrawn).toBe(2);
    } finally {
      layer.dispose();
    }
  });

  it('keeps signal visibility independent from transport visibility', () => {
    const source = new FakeSignalSource([junction]);
    const layer = new MobilityLayer({ signalSource: source });
    try {
      layer.update(0, view({ signals: aspectState }));
      expect(layer.getStats().drawnTrips).toBe(1);
      expect(layer.getStats().signalHeadsDrawn).toBe(2);

      layer.setSettings({ vehiclesVisible: true, signalsVisible: false, debug: false, paused: false });
      layer.update(0, view({ signals: aspectState }));
      expect(layer.getStats().drawnTrips).toBe(1);
      expect(layer.getStats().signalHeadsDrawn).toBe(0);
      expect(layer.root.getObjectByName('mobility-signals')?.visible).toBe(false);

      layer.setSettings({ vehiclesVisible: true, signalsVisible: true, debug: false, paused: false });
      layer.update(0, view({ signals: aspectState }));
      expect(layer.getStats().signalHeadsDrawn).toBe(2);
      expect(layer.getStats().drawnTrips).toBe(1);
    } finally {
      layer.dispose();
    }
  });

  it('falls back to red for missing runtime state and counts it', () => {
    const source = new FakeSignalSource([junction]);
    const layer = new MobilityLayer({ signalSource: source });
    try {
      layer.update(0, view({ signals: [] }));
      expect(layer.getStats().unknownAspects).toBe(2);
      const lens = signalMesh(layer, 'mobility-signal-lens-vehicle');
      const color = new THREE.Color();
      lens.getColorAt(0, color);
      const red = new THREE.Color(SIGNAL_ASPECT_COLORS.red);
      expect(color.r).toBeCloseTo(red.r, 4);
      expect(color.g).toBeCloseTo(red.g, 4);
    } finally {
      layer.dispose();
    }
  });

  it('limits the number of signal nodes by distance', () => {
    const nodes = Array.from({ length: 5 }, (_, index) =>
      node(`j:${index}`, index * 20, 0, [
        { id: `h${index}`, group: 0, kind: 'vehicle' },
      ]),
    );
    const source = new FakeSignalSource(nodes);
    const layer = new MobilityLayer({ signalSource: source, maxSignalNodes: 2 });
    try {
      layer.update(0, view({ signals: [] }));
      expect(layer.getStats().signalNodesDrawn).toBe(2);
      expect(layer.getStats().signalHeadsDrawn).toBe(2);
      // Ближайшие узлы — j:0 и j:1 (20 м), дальние не рисуются.
      const housing = signalMesh(layer, 'mobility-signal-housing-vehicle');
      const matrix = new THREE.Matrix4();
      const xs: number[] = [];
      for (let index = 0; index < housing.count; index += 1) {
        housing.getMatrixAt(index, matrix);
        xs.push(matrix.elements[12]);
      }
      expect(xs.sort((a, b) => a - b)).toEqual([0, 20]);
    } finally {
      layer.dispose();
    }
  });

  it('re-reads nodes when the loader revision changes', () => {
    const source = new FakeSignalSource([junction]);
    const layer = new MobilityLayer({ signalSource: source });
    try {
      layer.update(0, view({ signals: aspectState }));
      expect(layer.getStats().signalHeadsDrawn).toBe(2);
      source.nodes = [
        node('j:2', 5, 5, [
          { id: 'h2', group: 0, kind: 'vehicle' },
          { id: 'h3', group: 2, kind: 'tram' },
          { id: 'h4', group: 1, kind: 'pedestrian' },
        ]),
      ];
      source.revision += 1;
      layer.update(0, view({ signals: [] }));
      expect(layer.getStats().signalNodes).toBe(1);
      expect(layer.getStats().signalNodesDrawn).toBe(1);
      expect(layer.getStats().signalHeadsDrawn).toBe(3);
      expect(layer.getStats().unknownAspects).toBe(3);
      const housing = signalMesh(layer, 'mobility-signal-housing-tram');
      const matrix = new THREE.Matrix4();
      housing.getMatrixAt(0, matrix);
      expect(matrix.elements[12]).toBeCloseTo(5, 4);
    } finally {
      layer.dispose();
    }
  });

  it('ignores signals outside the camera rectangle and without a source', () => {
    const far = node('j:far', 5000, 5000, [{ id: 'h', group: 0, kind: 'vehicle' }]);
    const source = new FakeSignalSource([far]);
    const withSource = new MobilityLayer({ signalSource: source });
    try {
      withSource.update(0, view({ signals: [] }));
      expect(withSource.getStats().signalNodesDrawn).toBe(0);
      expect(withSource.getStats().signalHeadsDrawn).toBe(0);
    } finally {
      withSource.dispose();
    }
    const noSource = new MobilityLayer();
    try {
      noSource.update(0, view({ signals: aspectState }));
      expect(noSource.getStats().signalHeadsDrawn).toBe(0);
    } finally {
      noSource.dispose();
    }
  });

  it('releases all signal batches on dispose', () => {
    const source = new FakeSignalSource([junction]);
    const layer = new MobilityLayer({ signalSource: source });
    layer.update(0, view({ signals: aspectState }));
    layer.dispose();
    expect(layer.root.children).toHaveLength(0);
    expect(() => layer.update(0, view({ signals: aspectState }))).not.toThrow();
    expect(layer.getStats().signalHeadsDrawn).toBe(0);
  });

  it('consumes signal nodes loaded by MobilityLoader (integration without network)', async () => {
    const station: MobilitySignalNode = junction;
    const manifest: MobilityManifest = {
      version: 1,
      generatedAt: '2026-11-16T00:00:00Z',
      epsg: 32635,
      originUtm: [500000, 5970000],
      chunkSize: 256,
      bounds: [0, 0, 256, 256],
      chunks: [
        {
          key: '0_0',
          bounds: [0, 0, 256, 256],
          file: 'chunks/0_0.json',
          edges: 0,
          stops: 0,
          signals: 1,
          bytes: 120,
        },
      ],
      routes: [],
      signalNodes: [{ id: station.id, x: station.x, y: station.y, chunk: '0_0' }],
      calendars: [],
      release: { network: 'net-a', schedule: 'sched-a', bindings: 'bind-a' },
      scheduleStatus: 'ready',
      provenance: [],
      counts: { edges: 0, stops: 0, signalNodes: 1, variants: 0, trips: 0, verifiedVariants: 0 },
    };
    const bodies = new Map<string, string>([
      ['/data/mobility/manifest.json', JSON.stringify(manifest)],
      [
        '/data/mobility/chunks/0_0.json',
        JSON.stringify({
          version: 1,
          key: '0_0',
          bounds: [0, 0, 256, 256],
          edges: [],
          stops: [],
          signals: [station],
        }),
      ],
    ]);
    const fetchImpl = (url: string): Promise<MobilityFetchResponse> => {
      const text = bodies.get(url);
      if (text === undefined) return Promise.resolve({ ok: false, status: 404, text: async () => '' });
      return Promise.resolve({ ok: true, status: 200, text: async () => text });
    };
    const loader = new MobilityLoader({ baseUrl: '/data/mobility', fetchImpl, chunkMarginM: 0 });
    await loader.start();
    loader.update({ minX: 0, minY: 0, maxX: 30, maxY: 30 });
    await loader.whenIdle();
    expect(loader.loadedChunkCount).toBe(1);
    expect(loader.getSignalNodes()).toHaveLength(1);

    const layer = new MobilityLayer({ signalSource: loader });
    try {
      layer.update(0, view({ signals: aspectState }));
      expect(layer.getStats().signalNodes).toBe(1);
      expect(layer.getStats().signalNodesDrawn).toBe(1);
      expect(layer.getStats().signalHeadsDrawn).toBe(2);
      expect(layer.getStats().unknownAspects).toBe(0);
    } finally {
      layer.dispose();
      loader.dispose();
    }
  });
});
