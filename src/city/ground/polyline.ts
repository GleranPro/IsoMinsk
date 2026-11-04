/**
 * Polyline helpers for the raster ground compositor.
 *
 * `offsetPolyline` is a miter offset of a flat centreline (`[x0, y0, ...]`):
 * each vertex moves along the averaged left normal of its adjacent segments,
 * scaled by 1/cos(half-angle) (clamped to 2×) so parallel lines stay parallel
 * through bends. Positive offsets move to the LEFT of the travel direction.
 */

export function offsetPolyline(flat: readonly number[], offset: number): number[] {
  const n = Math.floor(flat.length / 2);
  const out = new Array<number>(n * 2);
  if (n < 2 || offset === 0) {
    for (let i = 0; i < n * 2; i++) out[i] = flat[i];
    return out;
  }
  for (let i = 0; i < n; i++) {
    let nx = 0;
    let ny = 0;
    for (const [a, b] of [
      [i - 1, i],
      [i, i + 1],
    ]) {
      if (a < 0 || b >= n) continue;
      const dx = flat[2 * b] - flat[2 * a];
      const dy = flat[2 * b + 1] - flat[2 * a + 1];
      const len = Math.hypot(dx, dy) || 1;
      nx += -dy / len;
      ny += dx / len;
    }
    const nlen = Math.hypot(nx, ny) || 1;
    nx /= nlen;
    ny /= nlen;
    let scale = 1;
    if (i > 0 && i < n - 1) {
      const dx = flat[2 * i + 2] - flat[2 * i];
      const dy = flat[2 * i + 3] - flat[2 * i + 1];
      const len = Math.hypot(dx, dy) || 1;
      // cos of the angle between the averaged normal and this segment's normal
      const cos = (-dy / len) * nx + (dx / len) * ny;
      scale = 1 / Math.max(0.5, cos);
    }
    out[2 * i] = flat[2 * i] + nx * offset * scale;
    out[2 * i + 1] = flat[2 * i + 1] + ny * offset * scale;
  }
  return out;
}

/** Total length of a flat polyline, metres. */
export function polylineLength(flat: readonly number[]): number {
  let total = 0;
  for (let i = 2; i + 1 < flat.length; i += 2) {
    total += Math.hypot(flat[i] - flat[i - 2], flat[i + 1] - flat[i - 1]);
  }
  return total;
}
