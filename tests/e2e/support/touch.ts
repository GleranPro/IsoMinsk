/**
 * Real multi-touch dispatch through the Chrome DevTools Protocol.
 *
 * `page.touchscreen` only supports single taps, so pinch/twist tests inject
 * touch points directly. This drives Chromium's actual touch → pointer-event
 * pipeline (including `touch-action: none` handling), which a synthetic
 * `PointerEvent` dispatch would not exercise.
 */

export interface TouchDispatchClient {
  send(method: string, params?: object): Promise<unknown>;
}

export interface TouchPoint {
  /** Stable touch id; must be unique per concurrent finger. */
  id: number;
  /** CSS pixels, viewport coordinates. */
  x: number;
  y: number;
}

/**
 * Sends the full set of active touch points.
 * - `touchStart` with a new set presses added points;
 * - `touchMove` moves existing points;
 * - `touchEnd` with an empty list lifts all points.
 */
export async function dispatchTouch(
  client: TouchDispatchClient,
  type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
  points: TouchPoint[],
): Promise<void> {
  await client.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((point) => ({
      id: point.id,
      x: Math.round(point.x),
      y: Math.round(point.y),
      radiusX: 2,
      radiusY: 2,
      force: 1,
    })),
  });
}

/** Single-finger drag with intermediate moves (finger-style, not a jump). */
export async function touchDrag(
  client: TouchDispatchClient,
  from: TouchPoint,
  to: TouchPoint,
  steps = 6,
): Promise<void> {
  await dispatchTouch(client, 'touchStart', [from]);
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    await dispatchTouch(client, 'touchMove', [
      { id: from.id, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
    ]);
    await delay(16);
  }
  await dispatchTouch(client, 'touchEnd', []);
}

/**
 * Two-finger gesture defined by a pair-position function per step. The first
 * step presses both fingers, the last step lifts them.
 */
export async function touchPinchOrTwist(
  client: TouchDispatchClient,
  start: [TouchPoint, TouchPoint],
  steps: Array<[TouchPoint, TouchPoint]>,
  msPerStep = 24,
): Promise<void> {
  await dispatchTouch(client, 'touchStart', [start[0], start[1]]);
  await delay(msPerStep);
  for (const pair of steps) {
    await dispatchTouch(client, 'touchMove', [pair[0], pair[1]]);
    await delay(msPerStep);
  }
  await dispatchTouch(client, 'touchEnd', []);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
