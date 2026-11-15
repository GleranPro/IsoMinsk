/**
 * Isometric Minsk — multi-pointer gesture recogniser.
 *
 * DOM-free on purpose: `CameraControls` feeds it normalised pointer samples and
 * forwards the resulting camera commands. Keeping the state machine free of DOM
 * types means every gesture rule (tap vs drag, double tap, pinch, twist,
 * multi-touch suppression) is unit-testable in Node.
 *
 * Recognised gestures
 *   one pointer, left / touch / pen   pan
 *   one pointer, right (mouse)        rotate; snaps to the 45° compass on release
 *   tap                               onTap (building selection)
 *   double tap                        onDoubleTap (focus on the ground point)
 *   two pointers, distance change     pinch zoom anchored at the midpoint
 *   two pointers, midpoint movement   pan
 *   two pointers, angle change        twist rotation (after a dead zone); snaps on end
 *
 * A tap is only reported when a single pointer goes down and up within the tap
 * slop. Any two-pointer gesture, any drag beyond the slop or a pointer cancel
 * suppresses it, so panning never selects a building by accident.
 */

/** Pointer kind as reported by `PointerEvent.pointerType` (unknown → mouse). */
export type PointerKind = 'mouse' | 'pen' | 'touch';

export interface PointerSample {
  /** `PointerEvent.pointerId`. */
  id: number;
  /** Client coordinates in CSS pixels. */
  x: number;
  y: number;
  /** Raw `PointerEvent.pointerType`; unknown values are treated as mouse. */
  pointerType: string;
  /** `PointerEvent.button` for a pointerdown; 0 for touch/pen contacts. */
  button: number;
}

export interface GestureHandlers {
  /** Pan by a client-pixel delta (positive x = right, positive y = down). */
  onPan(dx: number, dy: number): void;
  /** Zoom by `factor` (< 1 zooms in) keeping the given client point anchored. */
  onZoomAt(clientX: number, clientY: number, factor: number): void;
  /** Continuous azimuth rotation in radians. */
  onRotate(deltaRadians: number): void;
  /** A rotation gesture ended: snap the azimuth to the compass. */
  onRotateEnd(): void;
  /** Single tap / left click. */
  onTap(clientX: number, clientY: number): void;
  /** Second tap/click in the double-tap window. */
  onDoubleTap(clientX: number, clientY: number): void;
}

export interface PointerGestureOptions {
  /** Injectable clock for deterministic tests (defaults to `performance.now`). */
  now?: () => number;
}

/** Maximum travel for a pointer to still count as a tap, per device class. */
export const TAP_SLOP_PX: Record<PointerKind, number> = {
  mouse: 3,
  pen: 5,
  touch: 8,
};

/** Two taps within this window and distance count as a double tap. */
export const DOUBLE_TAP_INTERVAL_MS = 350;
export const DOUBLE_TAP_DISTANCE_PX = 32;

/** Twist must exceed this accumulated angle before rotation starts. */
export const TWIST_DEAD_ZONE_RAD = 0.1;

/** Per-event pinch factor limits (guards divided-by-near-zero jumps). */
export const PINCH_FACTOR_MIN = 0.5;
export const PINCH_FACTOR_MAX = 2;

/** Mouse right-drag rotation sensitivity (radians per client pixel). */
export const MOUSE_ROTATE_RAD_PER_PX = 0.0085;

const TWO_PI = Math.PI * 2;

interface TrackedPointer extends PointerSample {
  startX: number;
  startY: number;
  moved: boolean;
}

interface MultiGesture {
  distance: number;
  angle: number;
  midX: number;
  midY: number;
  /** Accumulated absolute angle change; starts rotation after the dead zone. */
  twist: number;
  twisting: boolean;
  rotated: boolean;
}

interface TapRecord {
  time: number;
  x: number;
  y: number;
  kind: 'mouse' | 'touch';
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function normalizeAngle(angle: number): number {
  let value = angle % TWO_PI;
  if (value > Math.PI) value -= TWO_PI;
  if (value < -Math.PI) value += TWO_PI;
  return value;
}

/** `pointerType` is "mouse" | "pen" | "touch" in browsers; be defensive. */
export function pointerKind(pointerType: string): PointerKind {
  if (pointerType === 'touch') return 'touch';
  if (pointerType === 'pen') return 'pen';
  return 'mouse';
}

export function pointDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Screen-space angle of the vector from `a` to `b` (y down, clockwise positive). */
export function pointAngle(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

export class PointerGestureController {
  private readonly handlers: GestureHandlers;
  private readonly now: () => number;
  private readonly pointers = new Map<number, TrackedPointer>();

  /** Pointer driving a one-pointer gesture (pan or right-drag rotation). */
  private singlePointerId: number | null = null;
  private singleButton = 0;

  /** Active two-pointer gesture, when two non-mouse pointers are down. */
  private multi: MultiGesture | null = null;

  /** Set once a two-pointer gesture starts; the gesture never produces a tap. */
  private suppressTap = false;

  private lastTap: TapRecord | null = null;

  constructor(handlers: GestureHandlers, options: PointerGestureOptions = {}) {
    this.handlers = handlers;
    this.now = options.now ?? (() => performance.now());
  }

  get isDragging(): boolean {
    return this.pointers.size > 0;
  }

  /** Number of pointers currently tracked (for diagnostics/tests). */
  get activePointerCount(): number {
    return this.pointers.size;
  }

  pointerDown(sample: PointerSample): void {
    const kind = pointerKind(sample.pointerType);
    if (this.pointers.has(sample.id)) return;
    // Mouse: only the primary and secondary buttons drive the camera.
    if (kind === 'mouse' && sample.button !== 0 && sample.button !== 2) return;
    if (kind !== 'mouse' && sample.button !== 0) return;

    const tracked: TrackedPointer = {
      ...sample,
      startX: sample.x,
      startY: sample.y,
      moved: false,
    };
    this.pointers.set(sample.id, tracked);

    if (this.pointers.size === 1) {
      this.singlePointerId = sample.id;
      this.singleButton = kind === 'mouse' ? sample.button : 0;
      this.suppressTap = false;
      this.multi = null;
      return;
    }

    // Two-finger gestures are touch/pen only; a mouse and a touch together is
    // not a supported combination and keeps the single-pointer behaviour.
    const pair = this.firstTwo();
    if (this.multi || !pair) return;
    if (pair.some((pointer) => pointerKind(pointer.pointerType) === 'mouse')) return;
    this.multi = this.beginMulti(pair[0], pair[1]);
    this.singlePointerId = null;
    // A two-pointer gesture must never end in a surprise click.
    this.suppressTap = true;
    this.lastTap = null;
  }

  pointerMove(sample: PointerSample): void {
    const tracked = this.pointers.get(sample.id);
    if (!tracked) return;
    const dx = sample.x - tracked.x;
    const dy = sample.y - tracked.y;
    tracked.x = sample.x;
    tracked.y = sample.y;
    const slop = TAP_SLOP_PX[pointerKind(sample.pointerType)];
    if (!tracked.moved && Math.hypot(tracked.x - tracked.startX, tracked.y - tracked.startY) > slop) {
      tracked.moved = true;
      // A drag breaks a pending double-tap chain; the next tap must be a fresh
      // first tap, not the second half of an interrupted pair.
      this.lastTap = null;
    }

    if (this.multi) {
      this.updateMulti(sample.id);
      return;
    }
    if (tracked.id !== this.singlePointerId) return;
    if (this.singleButton === 2) {
      if (dx !== 0) this.handlers.onRotate(-dx * MOUSE_ROTATE_RAD_PER_PX);
      return;
    }
    if (dx !== 0 || dy !== 0) this.handlers.onPan(dx, dy);
  }

  pointerUp(sample: PointerSample): void {
    const tracked = this.pointers.get(sample.id);
    if (!tracked) return;
    this.pointers.delete(sample.id);

    if (this.multi) {
      if (this.pointers.size >= 2) {
        // A third finger lifted (or one of two in a 3-finger gesture): re-anchor
        // the remaining pair so the image does not jump.
        const pair = this.firstTwo();
        if (pair) this.multi = this.beginMulti(pair[0], pair[1]);
        return;
      }
      const rotated = this.multi.rotated || this.multi.twisting;
      this.multi = null;
      if (rotated) this.handlers.onRotateEnd();
      this.suppressTap = true;
      this.lastTap = null;
      if (this.pointers.size === 1) {
        // Drop to one finger: keep panning, but the leftover finger must not
        // produce a click when it lifts.
        const remaining = this.firstPointer();
        if (remaining) {
          this.singlePointerId = remaining.id;
          this.singleButton = 0;
          remaining.startX = remaining.x;
          remaining.startY = remaining.y;
          remaining.moved = true;
        }
      } else {
        this.singlePointerId = null;
        this.suppressTap = false;
      }
      return;
    }

    if (tracked.id !== this.singlePointerId) return;

    if (this.pointers.size === 0) {
      if (this.singleButton === 0 && !this.suppressTap && !tracked.moved) {
        this.emitTap(tracked);
      } else if (this.singleButton === 2 && tracked.moved) {
        this.handlers.onRotateEnd();
      }
      this.singlePointerId = null;
      this.suppressTap = false;
      return;
    }

    // Mixed pointers (e.g. mouse held while a finger taps): hand the gesture to
    // whatever remains without emitting a click.
    const remaining = this.firstPointer();
    this.singlePointerId = remaining?.id ?? null;
    this.singleButton = 0;
    this.suppressTap = true;
  }

  pointerCancel(sample: PointerSample): void {
    if (!this.pointers.has(sample.id)) return;
    if (this.multi && (this.multi.rotated || this.multi.twisting)) {
      this.handlers.onRotateEnd();
    }
    // An OS-level cancellation ends the whole gesture; dropping a single
    // pointer here could otherwise leave a phantom pan state.
    this.pointers.clear();
    this.multi = null;
    this.singlePointerId = null;
    this.suppressTap = false;
  }

  /** Forget all state without emitting camera commands (used by dispose). */
  reset(): void {
    this.pointers.clear();
    this.multi = null;
    this.singlePointerId = null;
    this.suppressTap = false;
    this.lastTap = null;
  }

  private firstPointer(): TrackedPointer | null {
    for (const pointer of this.pointers.values()) return pointer;
    return null;
  }

  private firstTwo(): [TrackedPointer, TrackedPointer] | null {
    const pointers: TrackedPointer[] = [];
    for (const pointer of this.pointers.values()) {
      pointers.push(pointer);
      if (pointers.length === 2) break;
    }
    if (pointers.length < 2) return null;
    return [pointers[0], pointers[1]];
  }

  private beginMulti(a: TrackedPointer, b: TrackedPointer): MultiGesture {
    return {
      distance: Math.max(pointDistance(a, b), 1),
      angle: pointAngle(a, b),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      twist: 0,
      twisting: false,
      rotated: false,
    };
  }

  private updateMulti(movedId: number): void {
    const multi = this.multi;
    const pair = this.firstTwo();
    if (!multi || !pair) return;
    const [a, b] = pair;
    // The third finger of a 3-finger gesture must not add rotation/zoom.
    if (movedId !== a.id && movedId !== b.id) return;

    const distance = Math.max(pointDistance(a, b), 1);
    const angle = pointAngle(a, b);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;

    const factor = clamp(multi.distance / distance, PINCH_FACTOR_MIN, PINCH_FACTOR_MAX);
    const midDx = midX - multi.midX;
    const midDy = midY - multi.midY;

    // Zoom first, then move: the anchor is the current midpoint, so the ground
    // point under the fingers stays put while the pair travels.
    if (Math.abs(factor - 1) > 1e-4) this.handlers.onZoomAt(midX, midY, factor);
    if (midDx !== 0 || midDy !== 0) this.handlers.onPan(midDx, midDy);

    const deltaAngle = normalizeAngle(angle - multi.angle);
    multi.twist += Math.abs(deltaAngle);
    if (!multi.twisting && multi.twist >= TWIST_DEAD_ZONE_RAD) multi.twisting = true;
    if (multi.twisting && deltaAngle !== 0) {
      // Screen angles grow clockwise; clockwise content rotation is a negative
      // azimuth change for this camera convention (see isometricCamera.apply).
      this.handlers.onRotate(-deltaAngle);
      multi.rotated = true;
    }

    multi.distance = distance;
    multi.angle = angle;
    multi.midX = midX;
    multi.midY = midY;
  }

  private emitTap(tracked: TrackedPointer): void {
    const kind: 'mouse' | 'touch' = pointerKind(tracked.pointerType) === 'mouse' ? 'mouse' : 'touch';
    const time = this.now();
    const previous = this.lastTap;
    this.handlers.onTap(tracked.x, tracked.y);
    const isDouble =
      previous !== null &&
      previous.kind === kind &&
      time - previous.time <= DOUBLE_TAP_INTERVAL_MS &&
      pointDistance(previous, tracked) <= DOUBLE_TAP_DISTANCE_PX;
    if (isDouble) {
      this.lastTap = null;
      this.handlers.onDoubleTap(tracked.x, tracked.y);
    } else {
      this.lastTap = { time, x: tracked.x, y: tracked.y, kind };
    }
  }
}
