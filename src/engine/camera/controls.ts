/**
 * Custom camera input: no OrbitControls, no library.
 *
 *   left drag / one finger      pan (grabbed ground point follows the pointer)
 *   right drag (mouse)          rotate the azimuth (snaps to 45° on release)
 *   two fingers                 pinch zoom + pan; twist rotates (snaps on release)
 *   wheel                       cursor-anchored zoom (orthoHeight)
 *   tap / left click            selection
 *   double tap / double click   focus on the tapped ground point
 *   WASD/arrows pan, Q/E rotate, +/− zoom, R reset, Esc clear selection
 *
 * The gesture state machine lives in `pointerGestures.ts` (DOM-free, unit
 * tested); this class only wires browser events to it and to the camera rig.
 *
 * Trackpad/shift modifiers: Shift speeds up panning and turns Q/E into 45°
 * compass steps.
 */

import type { IsometricCameraRig } from './isometricCamera';
import {
  PointerGestureController,
  type PointerSample,
} from './pointerGestures';

export interface CameraControlsOptions {
  canvas: HTMLElement;
  rig: IsometricCameraRig;
  /** Left click / tap without dragging. */
  onClick?: (clientX: number, clientY: number) => void;
  /** Double click / double tap: (clientX, clientY, localX, localY). */
  onDoubleClick?: (clientX: number, clientY: number, localX: number, localY: number) => void;
  onReset?: () => void;
  onEscape?: () => void;
  /** Returns false to ignore input (e.g. while disposed). */
  isEnabled?: () => boolean;
}

const PAN_PIXELS_PER_SECOND = 0.85;
const FAST_PAN_MULTIPLIER = 2.4;
const ROTATE_RADIANS_PER_SECOND = 1.5;
const ZOOM_PER_SECOND = 2.0;

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

function pointerSample(event: PointerEvent): PointerSample {
  return {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    pointerType: event.pointerType,
    button: event.button,
  };
}

export class CameraControls {
  private readonly canvas: HTMLElement;
  private readonly rig: IsometricCameraRig;
  private readonly options: CameraControlsOptions;
  private readonly gestures: PointerGestureController;

  private readonly keys = new Set<string>();

  private readonly onPointerDown = (event: PointerEvent) => {
    if (!this.enabled()) return;
    if (event.pointerType === 'mouse') {
      if (event.button !== 0 && event.button !== 2) return;
    } else if (event.button !== 0) {
      return;
    }
    // Capture every pointer so a drag that leaves the canvas keeps working;
    // multi-touch pointers are captured individually.
    try {
      this.canvas.setPointerCapture?.(event.pointerId);
    } catch {
      /* capture is best effort */
    }
    this.gestures.pointerDown(pointerSample(event));
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.enabled()) return;
    this.gestures.pointerMove(pointerSample(event));
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    this.gestures.pointerUp(pointerSample(event));
    try {
      if (this.canvas.hasPointerCapture?.(event.pointerId)) {
        this.canvas.releasePointerCapture?.(event.pointerId);
      }
    } catch {
      /* ignore */
    }
  };

  private readonly onPointerCancel = (event: PointerEvent) => {
    this.gestures.pointerCancel(pointerSample(event));
    try {
      if (this.canvas.hasPointerCapture?.(event.pointerId)) {
        this.canvas.releasePointerCapture?.(event.pointerId);
      }
    } catch {
      /* ignore */
    }
  };

  private readonly onWheel = (event: WheelEvent) => {
    if (!this.enabled()) return;
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    const ndcY = -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
    // Normalise across deltaMode (pixel / line / page).
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const factor = Math.exp(event.deltaY * unit * 0.0011);
    this.rig.zoomAtNdc(ndcX, ndcY, factor);
  };

  private readonly onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.enabled() || isTextInput(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'shift') {
      this.keys.add('shift');
      return;
    }
    if (event.shiftKey && (key === 'q' || key === 'e')) {
      event.preventDefault();
      this.rig.stepAzimuth(key === 'q' ? -1 : 1);
      return;
    }
    if (key === 'r') {
      this.options.onReset?.();
      return;
    }
    if (key === 'escape') {
      this.options.onEscape?.();
      return;
    }
    this.keys.add(key);
    if (
      key === 'w' ||
      key === 'a' ||
      key === 's' ||
      key === 'd' ||
      key === 'q' ||
      key === 'e' ||
      key === 'arrowup' ||
      key === 'arrowdown' ||
      key === 'arrowleft' ||
      key === 'arrowright' ||
      key === '+' ||
      key === '=' ||
      key === '-' ||
      key === '_'
    ) {
      event.preventDefault();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    this.keys.delete(key);
    if (key === 'shift') this.keys.delete('shift');
  };

  private readonly onBlur = () => this.keys.clear();

  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') this.keys.clear();
  };

  constructor(options: CameraControlsOptions) {
    this.options = options;
    this.canvas = options.canvas;
    this.rig = options.rig;

    this.gestures = new PointerGestureController({
      onPan: (dx, dy) => this.rig.panByScreen(dx, dy),
      onZoomAt: (clientX, clientY, factor) => {
        const rect = this.canvas.getBoundingClientRect();
        const ndcX = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
        const ndcY = -((clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
        this.rig.zoomAtNdc(ndcX, ndcY, factor);
      },
      onRotate: (deltaRadians) => this.rig.rotateBy(deltaRadians),
      onRotateEnd: () => this.rig.snapAzimuth(),
      onTap: (clientX, clientY) => this.options.onClick?.(clientX, clientY),
      onDoubleTap: (clientX, clientY) => this.focusFromClient(clientX, clientY),
    });

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Convert a client point to the ground point under it and report it. */
  private focusFromClient(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    const ndcY = -((clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
    const point = this.rig.groundPointAtNdc(ndcX, ndcY);
    if (point) this.options.onDoubleClick?.(clientX, clientY, point.x, -point.z);
  }

  private enabled(): boolean {
    return this.options.isEnabled ? this.options.isEnabled() : true;
  }

  /** Per-frame keyboard integration (damped movement via the rig). */
  update(dt: number): void {
    if (!this.enabled() || this.keys.size === 0) return;
    const clampedDt = Math.min(Math.max(dt, 0), 0.1);
    const shift = this.keys.has('shift');
    const speed =
      (this.canvas.clientHeight || 900) *
      PAN_PIXELS_PER_SECOND *
      (shift ? FAST_PAN_MULTIPLIER : 1) *
      clampedDt;

    let screenX = 0;
    let screenY = 0;
    if (this.keys.has('a') || this.keys.has('arrowleft')) screenX -= speed;
    if (this.keys.has('d') || this.keys.has('arrowright')) screenX += speed;
    if (this.keys.has('w') || this.keys.has('arrowup')) screenY -= speed;
    if (this.keys.has('s') || this.keys.has('arrowdown')) screenY += speed;
    if (screenX !== 0 || screenY !== 0) {
      // moveByScreen moves the camera by a screen-space delta: W/up gives a
      // negative dy, which moves the camera up-screen (the view pans north).
      this.rig.moveByScreen(screenX, screenY);
    }

    if (this.keys.has('q')) this.rig.rotateBy(-clampedDt * ROTATE_RADIANS_PER_SECOND);
    if (this.keys.has('e')) this.rig.rotateBy(clampedDt * ROTATE_RADIANS_PER_SECOND);

    if (this.keys.has('=') || this.keys.has('+')) {
      this.rig.zoomBy(Math.exp(-clampedDt * ZOOM_PER_SECOND));
    }
    if (this.keys.has('-') || this.keys.has('_')) {
      this.rig.zoomBy(Math.exp(clampedDt * ZOOM_PER_SECOND));
    }
  }

  get isDragging(): boolean {
    return this.gestures.isDragging;
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.gestures.reset();
    this.keys.clear();
  }
}
