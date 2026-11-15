/**
 * Unit tests for the DOM-free multi-pointer gesture recogniser.
 *
 * These exercise the rules that are impossible to see in a screenshot: tap vs
 * drag classification, double-tap windows, pinch factor maths, twist dead zone
 * and snapping, and — most importantly — that a two-finger gesture can never
 * end in a building selection.
 */

import { describe, expect, it } from 'vitest';
import {
  DOUBLE_TAP_DISTANCE_PX,
  DOUBLE_TAP_INTERVAL_MS,
  MOUSE_ROTATE_RAD_PER_PX,
  PINCH_FACTOR_MAX,
  PINCH_FACTOR_MIN,
  PointerGestureController,
  TAP_SLOP_PX,
  TWIST_DEAD_ZONE_RAD,
  pointAngle,
  pointDistance,
  pointerKind,
  type PointerSample,
} from '../../../src/engine/camera/pointerGestures';

interface Calls {
  pan: Array<[number, number]>;
  zoom: Array<[number, number, number]>;
  rotate: number[];
  rotateEnd: number;
  taps: Array<[number, number]>;
  doubleTaps: Array<[number, number]>;
}

function createHarness() {
  let clock = 1000;
  const calls: Calls = { pan: [], zoom: [], rotate: [], rotateEnd: 0, taps: [], doubleTaps: [] };
  const controller = new PointerGestureController(
    {
      onPan: (dx, dy) => calls.pan.push([dx, dy]),
      onZoomAt: (x, y, factor) => calls.zoom.push([x, y, factor]),
      onRotate: (delta) => calls.rotate.push(delta),
      onRotateEnd: () => {
        calls.rotateEnd += 1;
      },
      onTap: (x, y) => calls.taps.push([x, y]),
      onDoubleTap: (x, y) => calls.doubleTaps.push([x, y]),
    },
    { now: () => clock },
  );
  return {
    calls,
    controller,
    tick: (ms: number) => {
      clock += ms;
    },
    panSum: () =>
      calls.pan.reduce<[number, number]>((sum, [dx, dy]) => [sum[0] + dx, sum[1] + dy], [0, 0]),
  };
}

function sample(
  id: number,
  x: number,
  y: number,
  pointerType = 'touch',
  button = 0,
): PointerSample {
  return { id, x, y, pointerType, button };
}

function down(
  controller: PointerGestureController,
  id: number,
  x: number,
  y: number,
  type = 'touch',
  button = 0,
) {
  controller.pointerDown(sample(id, x, y, type, button));
}

function move(controller: PointerGestureController, id: number, x: number, y: number, type = 'touch') {
  controller.pointerMove(sample(id, x, y, type));
}

function up(
  controller: PointerGestureController,
  id: number,
  x: number,
  y: number,
  type = 'touch',
  button = 0,
) {
  controller.pointerUp(sample(id, x, y, type, button));
}

/** Two touch points rotating around a fixed midpoint (clockwise, y down). */
function twistPair(controller: PointerGestureController, angle: number, moveFirst = true) {
  const midX = 150;
  const midY = 150;
  const radius = 50;
  const a = { x: midX - radius * Math.cos(angle), y: midY - radius * Math.sin(angle) };
  const b = { x: midX + radius * Math.cos(angle), y: midY + radius * Math.sin(angle) };
  if (moveFirst) move(controller, 1, a.x, a.y);
  move(controller, 2, b.x, b.y);
}

describe('pointer kind and geometry helpers', () => {
  it('normalises unknown pointer types to mouse', () => {
    expect(pointerKind('touch')).toBe('touch');
    expect(pointerKind('pen')).toBe('pen');
    expect(pointerKind('mouse')).toBe('mouse');
    expect(pointerKind('')).toBe('mouse');
  });

  it('measures distance and screen angle', () => {
    expect(pointDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5, 6);
    expect(pointAngle({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0, 6);
    // Screen y grows downwards, so a vector pointing down is +90°.
    expect(pointAngle({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe('single-pointer tap vs drag', () => {
  it('pans on one-finger drag and never reports a tap', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100);
    move(controller, 1, 130, 120);
    up(controller, 1, 130, 120);

    expect(calls.pan).toEqual([[30, 20]]);
    expect(calls.taps).toHaveLength(0);
    expect(controller.isDragging).toBe(false);
  });

  it('reports a tap for a touch that stays inside the slop', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100);
    move(controller, 1, 103, 104);
    up(controller, 1, 103, 104);

    expect(calls.taps).toEqual([[103, 104]]);
    expect(calls.pan).toHaveLength(1);
  });

  it('does not report a tap once travel exceeds the touch slop', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100);
    move(controller, 1, 100 + TAP_SLOP_PX.touch + 1, 100);
    up(controller, 1, 100 + TAP_SLOP_PX.touch + 1, 100);

    expect(calls.taps).toHaveLength(0);
  });

  it('uses a smaller slop for mouse pointers', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100, 'mouse');
    move(controller, 1, 100 + TAP_SLOP_PX.mouse + 1, 100, 'mouse');
    up(controller, 1, 100 + TAP_SLOP_PX.mouse + 1, 100, 'mouse');

    expect(calls.taps).toHaveLength(0);
  });
});

describe('double tap / double click', () => {
  it('fires onDoubleTap for two quick taps close together', () => {
    const { controller, calls, tick } = createHarness();
    down(controller, 1, 100, 100);
    up(controller, 1, 100, 100);
    tick(DOUBLE_TAP_INTERVAL_MS - 50);
    down(controller, 2, 105, 102);
    up(controller, 2, 105, 102);

    expect(calls.taps).toHaveLength(2);
    expect(calls.doubleTaps).toEqual([[105, 102]]);
  });

  it('treats a slow second tap as a separate tap', () => {
    const { controller, calls, tick } = createHarness();
    down(controller, 1, 100, 100);
    up(controller, 1, 100, 100);
    tick(DOUBLE_TAP_INTERVAL_MS + 1);
    down(controller, 2, 100, 100);
    up(controller, 2, 100, 100);

    expect(calls.taps).toHaveLength(2);
    expect(calls.doubleTaps).toHaveLength(0);
  });

  it('treats a far second tap as a separate tap', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100);
    up(controller, 1, 100, 100);
    down(controller, 2, 100 + DOUBLE_TAP_DISTANCE_PX + 4, 100);
    up(controller, 2, 100 + DOUBLE_TAP_DISTANCE_PX + 4, 100);

    expect(calls.doubleTaps).toHaveLength(0);
  });

  it('does not pair a mouse click with a touch tap', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100, 'mouse');
    up(controller, 1, 100, 100, 'mouse');
    down(controller, 2, 100, 100, 'touch');
    up(controller, 2, 100, 100, 'touch');

    expect(calls.taps).toHaveLength(2);
    expect(calls.doubleTaps).toHaveLength(0);
  });

  it('a mouse double click reports two taps and one double click', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100, 'mouse');
    up(controller, 1, 100, 100, 'mouse');
    down(controller, 2, 101, 100, 'mouse');
    up(controller, 2, 101, 100, 'mouse');

    expect(calls.taps).toHaveLength(2);
    expect(calls.doubleTaps).toEqual([[101, 100]]);
  });
});

describe('two-finger pinch and pan', () => {
  it('zooms in when the fingers spread, anchored at the midpoint', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100);
    down(controller, 2, 200, 100);
    move(controller, 2, 300, 100);

    // distance 100 → 200 halves the ortho height; midpoint moves to x = 200.
    expect(calls.zoom).toHaveLength(1);
    const [anchorX, anchorY, factor] = calls.zoom[0];
    expect(anchorX).toBeCloseTo(200, 6);
    expect(anchorY).toBeCloseTo(100, 6);
    expect(factor).toBeCloseTo(0.5, 6);
    expect(calls.pan).toEqual([[50, 0]]);
  });

  it('clamps the per-event pinch factor', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100);
    down(controller, 2, 200, 100);
    move(controller, 2, 2000, 100);

    expect(calls.zoom).toHaveLength(1);
    expect(calls.zoom[0][2]).toBeCloseTo(PINCH_FACTOR_MIN, 6);
    expect(PINCH_FACTOR_MIN).toBeLessThan(1);
    expect(PINCH_FACTOR_MAX).toBeGreaterThan(1);
  });

  it('pans by the midpoint delta when both fingers travel together', () => {
    const { controller, panSum } = createHarness();
    down(controller, 1, 100, 100);
    down(controller, 2, 200, 100);
    move(controller, 1, 120, 110);
    move(controller, 2, 220, 110);

    const [dx, dy] = panSum();
    expect(dx).toBeCloseTo(20, 6);
    expect(dy).toBeCloseTo(10, 6);
  });

  it('ignores a third finger for zoom and pan maths', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100);
    down(controller, 2, 200, 100);
    down(controller, 3, 300, 300);
    const zoomBefore = calls.zoom.length;
    const panBefore = calls.pan.length;
    // Moving the third pointer alone must not change the two-finger gesture.
    move(controller, 3, 400, 400);

    expect(calls.zoom).toHaveLength(zoomBefore);
    expect(calls.pan).toHaveLength(panBefore);
  });

  it('never reports a tap from a two-finger gesture', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100);
    down(controller, 2, 200, 100);
    move(controller, 1, 90, 90);
    up(controller, 1, 90, 90);
    up(controller, 2, 200, 100);

    expect(calls.taps).toHaveLength(0);
  });
});

describe('two-finger twist', () => {
  it('ignores rotation inside the dead zone', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 150);
    down(controller, 2, 200, 150);
    twistPair(controller, TWIST_DEAD_ZONE_RAD * 0.4);
    twistPair(controller, TWIST_DEAD_ZONE_RAD * 0.8);

    expect(calls.rotate).toHaveLength(0);
    expect(calls.rotateEnd).toBe(0);
  });

  it('rotates after the dead zone and snaps to the compass on release', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 150);
    down(controller, 2, 200, 150);
    twistPair(controller, 0.05);
    twistPair(controller, 0.2);
    expect(calls.rotate.length).toBeGreaterThan(0);
    // Clockwise finger twist (screen angles grow) rotates content clockwise,
    // which is a negative azimuth delta for this camera convention.
    expect(calls.rotate.every((delta) => delta < 0)).toBe(true);

    up(controller, 1, 100, 150);
    up(controller, 2, 200, 150);
    expect(calls.rotateEnd).toBe(1);
  });

  it('re-baselines when one of two fingers lifts and does not tap afterwards', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100);
    down(controller, 2, 200, 100);
    move(controller, 2, 260, 100);
    up(controller, 2, 260, 100);
    calls.pan.length = 0;
    move(controller, 1, 110, 100);
    up(controller, 1, 110, 100);

    expect(calls.pan).toEqual([[10, 0]]);
    expect(calls.taps).toHaveLength(0);
  });
});

describe('mouse right-drag rotation', () => {
  it('rotates with horizontal travel and snaps on release', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100, 'mouse', 2);
    move(controller, 1, 140, 100);
    up(controller, 1, 140, 100);

    expect(calls.rotate).toHaveLength(1);
    expect(calls.rotate[0]).toBeCloseTo(-40 * MOUSE_ROTATE_RAD_PER_PX, 6);
    expect(calls.rotateEnd).toBe(1);
    expect(calls.taps).toHaveLength(0);
  });

  it('does not snap when the right button did not move', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100, 'mouse', 2);
    up(controller, 1, 100, 100, 'mouse', 2);

    expect(calls.rotate).toHaveLength(0);
    expect(calls.rotateEnd).toBe(0);
    expect(calls.taps).toHaveLength(0);
  });
});

describe('cancellation', () => {
  it('cancels without emitting a tap and clears tracking state', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 100);
    controller.pointerCancel(sample(1, 100, 100));
    up(controller, 1, 100, 100);

    expect(calls.taps).toHaveLength(0);
    expect(controller.isDragging).toBe(false);
    expect(controller.activePointerCount).toBe(0);
  });

  it('snaps a twisted gesture that the OS interrupted', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 150);
    down(controller, 2, 200, 150);
    twistPair(controller, 0.2);
    controller.pointerCancel(sample(1, 100, 150));

    expect(calls.rotateEnd).toBe(1);
    expect(controller.activePointerCount).toBe(0);
  });

  it('reset forgets everything silently', () => {
    const { controller, calls } = createHarness();
    down(controller, 1, 100, 150);
    down(controller, 2, 200, 150);
    twistPair(controller, 0.2);
    controller.reset();

    expect(calls.rotateEnd).toBe(0);
    expect(controller.isDragging).toBe(false);
    expect(controller.activePointerCount).toBe(0);
  });
});
