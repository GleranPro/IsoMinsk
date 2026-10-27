/**
 * Custom camera input: no OrbitControls, no library.
 *
 *   left drag   pan (grabbed ground point follows the pointer)
 *   right drag  rotate the azimuth (snaps to 45° on release)
 *   wheel       cursor-anchored zoom (orthoHeight)
 *   WASD/arrows pan, Q/E rotate, +/− zoom, R reset, Esc clear selection
 *
 * Trackpad/shift modifiers: Shift speeds up panning and turns Q/E into 45°
 * compass steps.
 */

import type { IsometricCameraRig } from './isometricCamera';

export interface CameraControlsOptions {
  canvas: HTMLElement;
  rig: IsometricCameraRig;
  /** Left click without dragging. */
  onClick?: (clientX: number, clientY: number) => void;
  /** Double click: (clientX, clientY, localX, localY). */
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

export class CameraControls {
  private readonly canvas: HTMLElement;
  private readonly rig: IsometricCameraRig;
  private readonly options: CameraControlsOptions;

  private readonly keys = new Set<string>();
  private pointerId: number | null = null;
  private dragButton = 0;
  private lastX = 0;
  private lastY = 0;
  private moved = false;
  private dragging = false;

  private readonly onPointerDown = (event: PointerEvent) => {
    if (!this.enabled()) return;
    if (event.button !== 0 && event.button !== 2) return;
    if (this.pointerId !== null) return;
    this.pointerId = event.pointerId;
    this.dragButton = event.button;
    this.dragging = true;
    this.moved = false;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    try {
      (event.target as Element).setPointerCapture?.(event.pointerId);
    } catch {
      /* capture is best effort */
    }
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.dragging || event.pointerId !== this.pointerId) return;
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 1) this.moved = true;
    if (this.dragButton === 2) {
      this.rig.rotateBy(-dx * 0.0085);
    } else if (this.dragButton === 0) {
      this.rig.panByScreen(dx, dy);
    }
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    const wasLeft = this.dragButton === 0;
    const wasMoved = this.moved;
    this.dragging = false;
    this.pointerId = null;
    try {
      (event.target as Element).releasePointerCapture?.(event.pointerId);
    } catch {
      /* ignore */
    }
    if (this.dragButton === 2 && wasMoved) {
      // Rotation is continuous while dragging but locks to the 45° compass
      // when the gesture ends.
      this.rig.snapAzimuth();
    } else if (wasLeft && !wasMoved) {
      this.options.onClick?.(event.clientX, event.clientY);
    }
  };

  private readonly onPointerCancel = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    this.dragging = false;
    this.pointerId = null;
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

  private readonly onDoubleClick = (event: MouseEvent) => {
    if (!this.enabled()) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    const ndcY = -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
    const point = this.rig.groundPointAtNdc(ndcX, ndcY);
    if (point) this.options.onDoubleClick?.(event.clientX, event.clientY, point.x, -point.z);
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

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.canvas.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
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
    return this.dragging;
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.keys.clear();
  }
}
