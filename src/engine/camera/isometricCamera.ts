/**
 * Isometric orthographic camera rig.
 *
 * A hand-written camera controller (no OrbitControls): true isometric default
 * (azimuth 45°, elevation atan(1/√2)), drag-panning on the ground plane,
 * cursor-anchored wheel zoom, azimuth rotation with 45° snapping, exponential
 * damping, and a tight near/far range derived from the scene radius so the
 * depth buffer (used by the pixel-art edge pass) keeps its precision.
 *
 * Coordinate convention (see src/shared/types.ts):
 *   world X = local east, world Y = up, world Z = -local north.
 * The camera target always lives on the ground plane (y = 0).
 */

import * as THREE from 'three';
import { ISO_CAMERA } from '../../shared/config';
import type { CameraSettings } from '../../shared/appApi';

export interface WorldBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface GroundRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface IsometricCameraOptions {
  aspect?: number;
  widthCss?: number;
  heightCss?: number;
  bounds?: WorldBounds | null;
  settings?: Partial<CameraSettings>;
}

const TWO_PI = Math.PI * 2;
const SNAP_STEP = Math.PI / 4;
const TARGET_MARGIN_M = 140;
const DEFAULT_BOUNDS: WorldBounds = { minX: -1500, maxX: 1500, minZ: -1500, maxZ: 1500 };
const MIN_ELEVATION = 0.12;
const MAX_ELEVATION = 1.45;

/** Exponential smoothing that is frame-rate independent. */
function damp(current: number, goal: number, lambda: number, dt: number): number {
  return goal + (current - goal) * Math.exp(-lambda * dt);
}

function normalizeAngle(angle: number): number {
  let value = angle % TWO_PI;
  if (value > Math.PI) value -= TWO_PI;
  if (value < -Math.PI) value += TWO_PI;
  return value;
}

/** Shortest angular delta (result in [-π, π]). */
function angleDelta(from: number, to: number): number {
  return normalizeAngle(to - from);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

interface CameraPose {
  targetX: number;
  targetZ: number;
  orthoHeight: number;
  azimuth: number;
  elevation: number;
}

export class IsometricCameraRig {
  readonly camera: THREE.OrthographicCamera;

  private pose: CameraPose;
  private goal: CameraPose;
  private bounds: WorldBounds = DEFAULT_BOUNDS;
  private aspect = 1;
  private widthCss = 1;
  private heightCss = 1;
  private sceneRadius = 1700;
  private maxHeight = 160;
  private dirty = true;
  private animating = false;

  private readonly tmpNear = new THREE.Vector3();
  private readonly tmpFar = new THREE.Vector3();
  private readonly tmpRay = new THREE.Vector3();
  private readonly tmpPoint = new THREE.Vector3();
  private readonly footprint: GroundRect = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };

  constructor(options: IsometricCameraOptions = {}) {
    this.aspect = options.aspect ?? 16 / 9;
    this.widthCss = options.widthCss ?? 1600;
    this.heightCss = options.heightCss ?? 900;
    if (options.bounds) this.bounds = options.bounds;

    const settings: CameraSettings = {
      orthoHeight: ISO_CAMERA.orthoHeight,
      azimuth: ISO_CAMERA.azimuth,
      elevation: ISO_CAMERA.elevation,
      ...options.settings,
    };

    this.pose = this.clampPose({
      targetX: 0,
      targetZ: 0,
      orthoHeight: settings.orthoHeight,
      azimuth: settings.azimuth,
      elevation: settings.elevation,
    });
    this.goal = { ...this.pose };

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 12000);
    this.camera.up.set(0, 1, 0);
    this.camera.matrixAutoUpdate = true;
    this.recomputeRadius();
    this.apply();
  }

  // -------------------------------------------------------------------------
  // viewport / bounds
  // -------------------------------------------------------------------------

  setViewport(widthCss: number, heightCss: number): void {
    this.widthCss = Math.max(1, Math.floor(widthCss));
    this.heightCss = Math.max(1, Math.floor(heightCss));
    this.aspect = this.widthCss / this.heightCss;
    this.apply();
  }

  setBounds(bounds: WorldBounds): void {
    this.bounds = { ...bounds };
    this.recomputeRadius();
    this.clampPoseIntoBounds(this.pose);
    this.clampPoseIntoBounds(this.goal);
    this.apply();
  }

  setMaxBuildingHeight(height: number): void {
    if (Number.isFinite(height) && height > 0) this.maxHeight = Math.min(height, 500);
    this.recomputeRadius();
    this.apply();
  }

  private recomputeRadius(): void {
    const halfWidth = (this.bounds.maxX - this.bounds.minX) * 0.5;
    const halfDepth = (this.bounds.maxZ - this.bounds.minZ) * 0.5;
    const centreX = (this.bounds.maxX + this.bounds.minX) * 0.5;
    const centreZ = (this.bounds.maxZ + this.bounds.minZ) * 0.5;
    // Include the distance from the pilot centre so the frustum always covers
    // the whole city even when the target is at an edge.
    const reach = Math.hypot(this.bounds.maxX - centreX, this.bounds.maxZ - centreZ);
    this.sceneRadius = Math.max(900, Math.hypot(halfWidth, halfDepth) + Math.hypot(centreX, centreZ) * 0.5, reach) + this.maxHeight * 2 + 200;
  }

  // -------------------------------------------------------------------------
  // camera math
  // -------------------------------------------------------------------------

  /** Distance of the camera from its target; only affects depth range. */
  getCameraDistance(): number {
    return Math.max(ISO_CAMERA.distance, this.sceneRadius * 1.8);
  }

  private cameraDistance: number = ISO_CAMERA.distance;

  private apply(): void {
    const pose = this.pose;
    const halfHeight = pose.orthoHeight;
    const halfWidth = halfHeight * this.aspect;
    const camera = this.camera;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;

    const distance = this.getCameraDistance();
    this.cameraDistance = distance;
    const cosElevation = Math.cos(pose.elevation);
    const sinElevation = Math.sin(pose.elevation);
    const sinAzimuth = Math.sin(pose.azimuth);
    const cosAzimuth = Math.cos(pose.azimuth);

    camera.position.set(
      pose.targetX + distance * cosElevation * sinAzimuth,
      distance * sinElevation,
      pose.targetZ + distance * cosElevation * cosAzimuth,
    );
    camera.lookAt(pose.targetX, 0, pose.targetZ);

    // Tight near/far: the whole city plus tall roofs must fit between them,
    // and nothing else. This keeps the linear depth buffer precise.
    const viewExtent =
      this.sceneRadius + pose.orthoHeight * 2.4 + this.maxHeight * 2 + 200;
    camera.near = Math.max(1, distance - viewExtent);
    camera.far = distance + viewExtent;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    this.dirty = false;
  }

  /** Advance the damped pose; returns true when the camera actually moved. */
  update(dt: number): boolean {
    if (!this.animating) return false;
    const clampedDt = clamp(dt, 0, 0.1);
    const lambdaPan = 18;
    const lambdaZoom = 12;
    const lambdaRotate = 14;

    this.pose.targetX = damp(this.pose.targetX, this.goal.targetX, lambdaPan, clampedDt);
    this.pose.targetZ = damp(this.pose.targetZ, this.goal.targetZ, lambdaPan, clampedDt);
    this.pose.orthoHeight = damp(this.pose.orthoHeight, this.goal.orthoHeight, lambdaZoom, clampedDt);
    this.pose.azimuth = normalizeAngle(
      this.pose.azimuth + angleDelta(this.pose.azimuth, this.goal.azimuth) * (1 - Math.exp(-lambdaRotate * clampedDt)),
    );
    this.pose.elevation = damp(this.pose.elevation, this.goal.elevation, lambdaRotate, clampedDt);

    let settled = true;
    if (Math.abs(this.pose.targetX - this.goal.targetX) > 0.02) settled = false;
    if (Math.abs(this.pose.targetZ - this.goal.targetZ) > 0.02) settled = false;
    if (Math.abs(this.pose.orthoHeight - this.goal.orthoHeight) > 0.02) settled = false;
    if (Math.abs(angleDelta(this.pose.azimuth, this.goal.azimuth)) > 0.0005) settled = false;
    if (Math.abs(this.pose.elevation - this.goal.elevation) > 0.0005) settled = false;

    if (settled) {
      // Snap exactly to the goal so the image is perfectly still at rest
      // (no sub-pixel shimmer from an almost-converged camera).
      this.pose = { ...this.goal };
      this.animating = false;
    }

    this.apply();
    return true;
  }

  /** True when the camera has been asked to move but has not settled yet. */
  isAnimating(): boolean {
    return this.animating;
  }

  private markAnimating(): void {
    this.animating = true;
  }

  private clampPoseIntoBounds(pose: CameraPose): void {
    pose.targetX = clamp(
      pose.targetX,
      this.bounds.minX - TARGET_MARGIN_M,
      this.bounds.maxX + TARGET_MARGIN_M,
    );
    pose.targetZ = clamp(
      pose.targetZ,
      this.bounds.minZ - TARGET_MARGIN_M,
      this.bounds.maxZ + TARGET_MARGIN_M,
    );
  }

  private clampPose(pose: CameraPose): CameraPose {
    pose.orthoHeight = clamp(
      pose.orthoHeight,
      ISO_CAMERA.minOrthoHeight,
      ISO_CAMERA.maxOrthoHeight,
    );
    pose.elevation = clamp(pose.elevation, MIN_ELEVATION, MAX_ELEVATION);
    pose.azimuth = normalizeAngle(pose.azimuth);
    this.clampPoseIntoBounds(pose);
    return pose;
  }

  // -------------------------------------------------------------------------
  // public camera API
  // -------------------------------------------------------------------------

  getSettings(): CameraSettings {
    return {
      orthoHeight: this.pose.orthoHeight,
      azimuth: normalizeAngle(this.pose.azimuth),
      elevation: this.pose.elevation,
    };
  }

  /** Applies immediately (used by the React controls) and clamps to limits. */
  setSettings(partial: Partial<CameraSettings>): void {
    const next: CameraPose = { ...this.pose };
    if (typeof partial.orthoHeight === 'number' && Number.isFinite(partial.orthoHeight)) {
      next.orthoHeight = partial.orthoHeight;
    }
    if (typeof partial.azimuth === 'number' && Number.isFinite(partial.azimuth)) {
      next.azimuth = partial.azimuth;
    }
    if (typeof partial.elevation === 'number' && Number.isFinite(partial.elevation)) {
      next.elevation = partial.elevation;
    }
    this.clampPose(next);
    this.pose = { ...next };
    this.goal = { ...next };
    this.animating = false;
    this.apply();
  }

  reset(): void {
    const pose = this.clampPose({
      targetX: 0,
      targetZ: 0,
      orthoHeight: ISO_CAMERA.orthoHeight,
      azimuth: ISO_CAMERA.azimuth,
      elevation: ISO_CAMERA.elevation,
    });
    this.goal = { ...pose };
    this.pose = { ...pose };
    this.animating = false;
    this.apply();
  }

  /** Instantly centre the view on a local-metre coordinate. */
  focusOnLocal(localX: number, localY: number, instant = true): void {
    const goalX = localX;
    const goalZ = -localY;
    if (instant) {
      this.pose.targetX = goalX;
      this.pose.targetZ = goalZ;
      this.clampPoseIntoBounds(this.pose);
      this.goal.targetX = this.pose.targetX;
      this.goal.targetZ = this.pose.targetZ;
      this.animating = false;
      this.apply();
    } else {
      this.goal.targetX = goalX;
      this.goal.targetZ = goalZ;
      this.clampPoseIntoBounds(this.goal);
      this.markAnimating();
    }
  }

  /** Local-metre target (the inverse of the world mapping). */
  getTargetLocal(): { x: number; y: number } {
    return { x: this.pose.targetX, y: -this.pose.targetZ };
  }

  getTargetWorld(): THREE.Vector3 {
    return new THREE.Vector3(this.pose.targetX, 0, this.pose.targetZ);
  }

  getCameraDistanceValue(): number {
    return this.cameraDistance;
  }

  getOrthoHeight(): number {
    return this.pose.orthoHeight;
  }

  getElevation(): number {
    return this.pose.elevation;
  }

  getAzimuth(): number {
    return normalizeAngle(this.pose.azimuth);
  }

  /** World metres covered by one low-resolution vertical pixel. */
  getPixelWorldSize(renderHeightPx: number): number {
    return (2 * this.pose.orthoHeight) / Math.max(1, renderHeightPx);
  }

  // -------------------------------------------------------------------------
  // screen <-> ground helpers
  // -------------------------------------------------------------------------

  /** NDC (-1..1, y up) point on the ground plane (y = 0), or null. */
  groundPointAtNdc(ndcX: number, ndcY: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const nearPoint = this.tmpNear.set(ndcX, ndcY, -1).unproject(this.camera);
    const farPoint = this.tmpFar.set(ndcX, ndcY, 1).unproject(this.camera);
    const direction = this.tmpRay.subVectors(farPoint, nearPoint);
    if (Math.abs(direction.y) < 1e-6) return null;
    const t = -nearPoint.y / direction.y;
    if (!Number.isFinite(t) || t < 0 || t > 1.5) return null;
    out.copy(nearPoint).addScaledVector(direction, t);
    out.y = 0;
    return out;
  }

  /**
   * Convert a screen-space drag into a ground-plane world delta.
   * The result is the movement of the *content*: dragging right moves the world
   * right in screen space.
   */
  screenDeltaToWorld(dxPx: number, dyPx: number): { x: number; z: number } {
    const worldPerPixel = (2 * this.pose.orthoHeight) / Math.max(1, this.heightCss);
    const azimuth = this.pose.azimuth;
    const cos = Math.cos(azimuth);
    const sin = Math.sin(azimuth);
    // Camera right on the ground = (cos, 0, -sin); screen down on the ground =
    // (sin, 0, cos).
    return {
      x: (cos * dxPx + sin * dyPx) * worldPerPixel,
      z: (-sin * dxPx + cos * dyPx) * worldPerPixel,
    };
  }

  /** Pan like a map: the grabbed ground point follows the pointer. */
  panByScreen(dxPx: number, dyPx: number): void {
    if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return;
    const delta = this.screenDeltaToWorld(dxPx, dyPx);
    this.goal.targetX -= delta.x;
    this.goal.targetZ -= delta.z;
    this.clampPoseIntoBounds(this.goal);
    // Panning should feel direct: move the current pose as well, otherwise a
    // fast drag visibly lags behind the pointer.
    this.pose.targetX = this.goal.targetX;
    this.pose.targetZ = this.goal.targetZ;
    this.apply();
  }

  /** Move the camera in screen space (WASD-style). Positive y = down-screen. */
  moveByScreen(dxPx: number, dyPx: number): void {
    const delta = this.screenDeltaToWorld(dxPx, dyPx);
    this.goal.targetX += delta.x;
    this.goal.targetZ += delta.z;
    this.clampPoseIntoBounds(this.goal);
    this.markAnimating();
  }

  /**
   * Zoom by `factor` keeping the ground point under the given NDC position
   * approximately fixed (cursor anchored zoom).
   */
  zoomAtNdc(ndcX: number, ndcY: number, factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const oldHeight = this.pose.orthoHeight;
    const goalHeight = this.goal.orthoHeight;
    const newHeight = clamp(
      goalHeight * factor,
      ISO_CAMERA.minOrthoHeight,
      ISO_CAMERA.maxOrthoHeight,
    );
    const appliedFactor = newHeight / Math.max(goalHeight, 1e-6);
    const anchor = this.groundPointAtNdc(ndcX, ndcY, this.tmpPoint);
    if (anchor) {
      this.goal.targetX = anchor.x - (anchor.x - this.goal.targetX) * appliedFactor;
      this.goal.targetZ = anchor.z - (anchor.z - this.goal.targetZ) * appliedFactor;
      this.clampPoseIntoBounds(this.goal);
    }
    this.goal.orthoHeight = newHeight;
    void oldHeight;
    this.markAnimating();
  }

  /** Zoom from the keyboard / UI without a cursor anchor. */
  zoomBy(factor: number): void {
    this.zoomAtNdc(0, 0, factor);
  }

  /** Continuous rotation; delta in radians. */
  rotateBy(deltaRadians: number): void {
    if (!Number.isFinite(deltaRadians) || deltaRadians === 0) return;
    this.goal.azimuth = normalizeAngle(this.goal.azimuth + deltaRadians);
    this.markAnimating();
  }

  /** Snap the goal azimuth to the nearest 45° compass step. */
  snapAzimuth(): void {
    const snapped = Math.round(this.goal.azimuth / SNAP_STEP) * SNAP_STEP;
    this.goal.azimuth = normalizeAngle(snapped);
    this.markAnimating();
  }

  /** One 45° compass step (Shift + Q/E). */
  stepAzimuth(direction: number): void {
    const currentStep = Math.round(this.goal.azimuth / SNAP_STEP);
    this.goal.azimuth = normalizeAngle((currentStep + Math.sign(direction || 1)) * SNAP_STEP);
    this.markAnimating();
  }

  // -------------------------------------------------------------------------
  // footprint used by tile streaming + shadow fitting
  // -------------------------------------------------------------------------

  /**
   * Axis-aligned world-space rectangle on the ground that the ortho frustum
   * covers (also taking objects of `heightMargin` metres into account so tall
   * roofs above the visible ground are included).
   */
  getVisibleGroundRect(heightMargin = 170): GroundRect {
    const corners: Array<[number, number]> = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const nearPoint = this.tmpNear;
    const farPoint = this.tmpFar;
    const direction = this.tmpRay;

    for (const [sx, sy] of corners) {
      nearPoint.set(sx, sy, -1).unproject(this.camera);
      farPoint.set(sx, sy, 1).unproject(this.camera);
      direction.subVectors(farPoint, nearPoint);
      if (Math.abs(direction.y) < 1e-6) continue;
      for (const height of [0, heightMargin]) {
        const t = (height - nearPoint.y) / direction.y;
        if (!Number.isFinite(t)) continue;
        const px = nearPoint.x + direction.x * t;
        const pz = nearPoint.z + direction.z * t;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (pz < minZ) minZ = pz;
        if (pz > maxZ) maxZ = pz;
      }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) {
      return { minX: this.bounds.minX, maxX: this.bounds.maxX, minZ: this.bounds.minZ, maxZ: this.bounds.maxZ };
    }
    this.footprint.minX = minX;
    this.footprint.maxX = maxX;
    this.footprint.minZ = minZ;
    this.footprint.maxZ = maxZ;
    return this.footprint;
  }
}
