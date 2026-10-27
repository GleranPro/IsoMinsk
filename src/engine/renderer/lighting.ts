/**
 * Sun + ambient lighting rig with a shadow camera fitted to the visible
 * footprint.
 *
 * The directional sun comes from the real solar position for Minsk (see
 * solarPosition.ts) clamped to a sane elevation, while colour/intensity come
 * from the blended time-of-day palette. The shadow map follows the camera so
 * shadows stay crisp at every zoom level: the orthographic shadow frustum is
 * sized to the ground footprint visible on screen (plus the distance shadows
 * can reach out from taller buildings), snapped to shadow-map texels to stop
 * the shadow edges from crawling while panning.
 */

import * as THREE from 'three';
import { PILOT_CENTER } from '../../shared/config';
import { solarPosition, sunDirectionFromAngles } from './solarPosition';
import { sampleLook, hexToColor, type BlendedLook } from './timeOfDay';

/** The sun is not allowed below this elevation; below the horizon we light the
 * city like moonlit night from the same azimuth. */
const MIN_SUN_ELEVATION_DEG = 14;
/** Lower clamp for the shadow-frustum half extent (metres). */
const MIN_SHADOW_EXTENT = 260;
/** Upper clamp: beyond this the map is fully zoomed out anyway. */
const MAX_SHADOW_EXTENT = 1700;

export interface LightState {
  hours: number;
  look: BlendedLook;
  /** Unit vector towards the sun. */
  direction: THREE.Vector3;
  /** Sun elevation actually used for shading, radians. */
  elevation: number;
}

export class LightingRig {
  readonly sun: THREE.DirectionalLight;
  readonly ambient: THREE.HemisphereLight;
  readonly fill: THREE.DirectionalLight;
  state: LightState;

  private readonly scene: THREE.Scene;
  private readonly shadowMapSize: number;
  private shadowExtent = 900;
  private shadowCenter = new THREE.Vector3();
  private readonly shadowBasisX = new THREE.Vector3();
  private readonly shadowBasisY = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private lastShadowKey = '';

  constructor(scene: THREE.Scene, shadowMapSize = 4096) {
    this.scene = scene;
    this.shadowMapSize = shadowMapSize;

    this.sun = new THREE.DirectionalLight(hexToColor('#fff6e0'), 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 8000;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.intensity = 0.55;
    this.sun.shadow.camera.left = -this.shadowExtent;
    this.sun.shadow.camera.right = this.shadowExtent;
    this.sun.shadow.camera.top = this.shadowExtent;
    this.sun.shadow.camera.bottom = -this.shadowExtent;
    this.sun.shadow.camera.updateProjectionMatrix();

    this.ambient = new THREE.HemisphereLight(hexToColor('#b7c9da'), hexToColor('#727466'), 0.52);
    this.ambient.position.set(0, 400, 0);

    this.fill = new THREE.DirectionalLight(hexToColor('#9fb4cc'), 0.18);
    this.fill.castShadow = false;
    this.fill.position.set(-600, 500, 600);

    scene.add(this.sun);
    scene.add(this.sun.target);
    scene.add(this.ambient);
    scene.add(this.fill);

    this.state = {
      hours: 13,
      look: sampleLook(13),
      direction: new THREE.Vector3(0, 1, 0),
      elevation: Math.PI / 2,
    };
    this.setTimeOfDay(13);
  }

  /**
   * Apply the blended palette + real solar direction for a clock hour.
   * Shadow-map sizing is refreshed on the next `updateShadow` call.
   */
  setTimeOfDay(hours: number, date: Date = new Date()): LightState {
    const look = sampleLook(hours);
    const solar = solarPosition(hours, PILOT_CENTER.lat, PILOT_CENTER.lon, date);

    // At night the sun is below the horizon: clamp to a moon-like direction.
    const elevationDeg = Math.max(solar.elevation, MIN_SUN_ELEVATION_DEG);
    const elevation = (elevationDeg * Math.PI) / 180;
    const direction = new THREE.Vector3(
      ...sunDirectionFromAngles(solar.azimuth, elevationDeg),
    ).normalize();

    this.sun.color.copy(look.sunColor);
    this.sun.intensity = look.sunIntensity;
    this.sun.shadow.intensity = THREE.MathUtils.clamp(look.shadowOpacity, 0, 1);

    this.ambient.color.copy(look.ambientColor);
    this.ambient.groundColor.copy(look.groundColor);
    this.ambient.intensity = look.ambientIntensity;

    // A weak counter-light softens the unlit sides without flattening the
    // stylised look; it comes from the opposite horizontal side of the sun.
    this.fill.color.copy(look.ambientColor);
    this.fill.intensity = look.ambientIntensity * 0.3;

    const fillDirection = this.scratch
      .set(-direction.x, direction.y * 0.55 + 0.25, -direction.z)
      .normalize();
    this.fill.position.copy(fillDirection).multiplyScalar(1200);

    this.state = { hours, look, direction, elevation };
    this.lastShadowKey = '';
    return this.state;
  }

  /**
   * Fit the shadow camera to the visible ground footprint.
   *
   * @param footprint  Visible ground rectangle in world metres.
   * @param maxHeight  Tallest caster near the view, used to expand the fit for
   *                   shadows that fall into the visible footprint from outside.
   */
  updateShadow(
    footprint: { minX: number; maxX: number; minZ: number; maxZ: number },
    maxHeight = 140,
  ): void {
    const direction = this.state.direction;
    const elevation = Math.max(this.state.elevation, (MIN_SUN_ELEVATION_DEG * Math.PI) / 180);
    const tanElevation = Math.max(Math.tan(elevation), 0.18);

    const halfWidth = Math.max((footprint.maxX - footprint.minX) * 0.5, 30);
    const halfDepth = Math.max((footprint.maxZ - footprint.minZ) * 0.5, 30);
    const footprintHalfDiagonal = Math.hypot(halfWidth, halfDepth);
    const shadowReach = Math.min(maxHeight / tanElevation, 420);
    const extent = THREE.MathUtils.clamp(
      footprintHalfDiagonal + shadowReach * 0.85 + 30,
      MIN_SHADOW_EXTENT,
      MAX_SHADOW_EXTENT,
    );

    const centerX = (footprint.minX + footprint.maxX) * 0.5;
    const centerZ = (footprint.minZ + footprint.maxZ) * 0.5;
    const centerY = 0;

    // Texel snapping in light space removes shadow shimmer while panning.
    const mapSize = this.shadowMapSize;
    const worldPerTexel = (extent * 2) / mapSize;
    const up = THREE.Object3D.DEFAULT_UP;
    this.shadowBasisX.crossVectors(up, direction);
    if (this.shadowBasisX.lengthSq() < 1e-6) this.shadowBasisX.set(1, 0, 0);
    this.shadowBasisX.normalize();
    this.shadowBasisY.crossVectors(direction, this.shadowBasisX).normalize();

    const rawX = centerX * this.shadowBasisX.x + centerY * this.shadowBasisX.y + centerZ * this.shadowBasisX.z;
    const rawY = centerX * this.shadowBasisY.x + centerY * this.shadowBasisY.y + centerZ * this.shadowBasisY.z;
    const snappedX = Math.round(rawX / worldPerTexel) * worldPerTexel;
    const snappedY = Math.round(rawY / worldPerTexel) * worldPerTexel;
    const deltaX = snappedX - rawX;
    const deltaY = snappedY - rawY;

    this.shadowCenter
      .set(centerX, centerY, centerZ)
      .addScaledVector(this.shadowBasisX, deltaX)
      .addScaledVector(this.shadowBasisY, deltaY);

    const lightDistance = extent * 2 + 900;
    this.sun.target.position.copy(this.shadowCenter);
    this.sun.target.updateMatrixWorld();
    this.sun.position.copy(this.shadowCenter).addScaledVector(direction, lightDistance);
    this.sun.updateMatrixWorld();

    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.left = -extent;
    shadowCamera.right = extent;
    shadowCamera.top = extent;
    shadowCamera.bottom = -extent;
    shadowCamera.near = 1;
    shadowCamera.far = lightDistance + extent * 2 + maxHeight * 2;
    shadowCamera.updateProjectionMatrix();

    // Normal bias in world units, derived from the shadow-map texel size: big
    // enough to kill acne on sloped roofs, small enough not to detach shadows.
    this.sun.shadow.normalBias = THREE.MathUtils.clamp(worldPerTexel * 0.9, 0.2, 1.6);
    this.sun.shadow.bias = -0.00015;

    this.shadowExtent = extent;
    this.lastShadowKey = `${centerX.toFixed(1)}:${centerZ.toFixed(1)}:${extent.toFixed(1)}`;
  }

  getShadowExtent(): number {
    return this.shadowExtent;
  }

  getMaxShadowTexel(): number {
    return (this.shadowExtent * 2) / this.shadowMapSize;
  }

  dispose(): void {
    this.sun.dispose();
    this.ambient.dispose();
    this.fill.dispose();
    this.scene.remove(this.sun.target);
    this.scene.remove(this.sun);
    this.scene.remove(this.ambient);
    this.scene.remove(this.fill);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
  }
}
