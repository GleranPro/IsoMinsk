/**
 * Raster ground material (payload 0.4.0).
 *
 * One flat quad per tile textured with the ground compositor output
 * (`src/city/ground/groundRaster.ts`). Lighting matches the vertex-coloured
 * environment material: stock Lambert with the same small emissive ambient
 * floor, so the textured ground and the remaining geometry (bridge decks,
 * trees) read as one surface family. Texels are sampled nearest-neighbour —
 * the pixel-art pipeline owns any smoothing.
 */

import * as THREE from 'three';

export const GROUND_EMISSIVE = new THREE.Color().setRGB(0.02, 0.022, 0.027);
/** Anisotropy for the oblique isometric view (clamped by the GPU's maximum). */
export const GROUND_ANISOTROPY = 8;

export function createGroundTexture(
  data: ArrayBuffer,
  width: number,
  height: number,
): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    new Uint8Array(data),
    width,
    height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  // Magnified (close zoom): crisp texels. Minified (a texel smaller than a
  // screen pixel, which happens along the foreshortened isometric depth axis):
  // trilinear + anisotropic filtering, otherwise nearest sampling skips texels
  // and 1-texel lane dashes break into random glyphs. The pixel-art post pass
  // quantises the result back onto the pixel grid.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = GROUND_ANISOTROPY;
  texture.needsUpdate = true;
  return texture;
}

export function createGroundMaterial(texture: THREE.Texture): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({
    map: texture,
    fog: true,
    emissive: GROUND_EMISSIVE.clone(),
  });
  material.name = 'IsometricMinskRasterGround';
  return material;
}

/**
 * Flat quad covering `bounds` (local metres) at height `y`, in renderer world
 * space (x east, y up, z = -north). UV (0,0) is the north-west corner, matching
 * the compositor's row 0 = north edge.
 */
export function createGroundQuad(
  bounds: [number, number, number, number],
  y: number,
): THREE.BufferGeometry {
  const [x0, y0, x1, y1] = bounds;
  // A(x0, north) B(x1, north) C(x1, south) D(x0, south)
  const positions = new Float32Array([
    x0, y, -y1,
    x0, y, -y0,
    x1, y, -y0,
    x0, y, -y1,
    x1, y, -y0,
    x1, y, -y1,
  ]);
  const uvs = new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]);
  const normals = new Float32Array(18);
  for (let i = 1; i < 18; i += 3) normals[i] = 1;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}
