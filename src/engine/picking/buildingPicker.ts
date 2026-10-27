/**
 * Building picking.
 *
 * A single ray is cast from the click point through the isometric camera. Tiles
 * whose bounding box is not hit are skipped, so a click only tests the handful
 * of building meshes actually under the cursor. The hit triangle is mapped back
 * to its building through the merged geometry's `triangleOwner` array, which is
 * stable across tile reloads (ids come from the tile data, not from the mesh).
 */

import * as THREE from 'three';
import type { BuildingSelection } from '../../shared/appApi';
import type { BuildingFeature, FeatureId } from '../../shared/types';
import type { TileStreamer } from '../tiles/tileStreamer';

export class BuildingPicker {
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly worldBox = new THREE.Box3();
  private readonly candidates: THREE.Mesh[] = [];

  constructor(
    private readonly tiles: TileStreamer,
    private readonly camera: THREE.Camera,
  ) {
    this.raycaster.near = 0;
    this.raycaster.far = Number.POSITIVE_INFINITY;
  }

  /**
   * @param rect Client rect of the canvas element (screen pixels).
   * @returns The picked building with the pointer position, or null.
   */
  pick(clientX: number, clientY: number, rect: DOMRect): BuildingSelection | null {
    const width = Math.max(rect.width, 1);
    const height = Math.max(rect.height, 1);
    this.ndc.set(
      ((clientX - rect.left) / width) * 2 - 1,
      -((clientY - rect.top) / height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);

    this.candidates.length = 0;
    const ray = this.raycaster.ray;
    for (const tile of this.tiles.loadedTiles()) {
      const mesh = tile.buildingMesh;
      if (!mesh) continue;
      const geometry = mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const boundingBox = geometry.boundingBox;
      if (!boundingBox) continue;
      this.worldBox.copy(boundingBox).applyMatrix4(mesh.matrixWorld);
      if (ray.intersectsBox(this.worldBox)) this.candidates.push(mesh);
    }
    if (this.candidates.length === 0) return null;

    const hits = this.raycaster.intersectObjects(this.candidates, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    const mesh = hit.object as THREE.Mesh;
    const tileKey = mesh.userData.tileKey as string | undefined;
    if (!tileKey) return null;
    const tile = this.tiles.getTile(tileKey);
    if (!tile || !tile.triangleOwner) return null;
    const faceIndex = hit.faceIndex ?? -1;
    if (faceIndex < 0 || faceIndex >= tile.triangleOwner.length) return null;
    const ownerIndex = tile.triangleOwner[faceIndex];
    if (ownerIndex === undefined || ownerIndex >= tile.buildingIds.length) return null;
    const id: FeatureId = tile.buildingIds[ownerIndex];
    const feature: BuildingFeature | undefined = tile.buildings.get(id);
    if (!feature) return null;
    return {
      id,
      feature,
      screenX: clientX,
      screenY: clientY,
    };
  }
}
