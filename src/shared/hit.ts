// Stroke eraser hit-testing. The eraser is a circle swept along the pen path
// (segment a→b, radius r); a stroke is hit when that capsule touches the
// stroke's centerline widened by half its width. Using the full width (not
// the pressure-thinned one) errs on the side of erasing what you touched.

import { POINT_STRIDE, type Rect } from "./ink.ts";

/** Squared distance between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection §5.1.9). */
export function segmentDistanceSq(
  p1x: number, p1y: number, q1x: number, q1y: number,
  p2x: number, p2y: number, q2x: number, q2y: number,
): number {
  const d1x = q1x - p1x, d1y = q1y - p1y;
  const d2x = q2x - p2x, d2y = q2y - p2y;
  const rx = p1x - p2x, ry = p1y - p2y;
  const a = d1x * d1x + d1y * d1y;
  const e = d2x * d2x + d2y * d2y;
  const f = d2x * rx + d2y * ry;
  const EPS = 1e-9;
  let s: number;
  let t: number;
  if (a <= EPS && e <= EPS) {
    s = t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry;
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y;
      const denom = a * e - b * b;
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const dx = p1x + d1x * s - (p2x + d2x * t);
  const dy = p1y + d1y * s - (p2y + d2y * t);
  return dx * dx + dy * dy;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Bounding box of a stroke's centerline (not including its width). */
export function pointsBounds(pts: ArrayLike<number>): Rect | null {
  if (pts.length < POINT_STRIDE) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += POINT_STRIDE) {
    const x = pts[i]!, y = pts[i + 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export interface HitTarget {
  pts: ArrayLike<number>;
  width: number;
  /** Centerline bounds; pass a cached value to skip recomputing it. */
  bounds?: Rect | null;
}

/** Does the eraser capsule (a→b, radius r) touch the stroke? */
export function hitsStroke(s: HitTarget, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const reach = r + s.width / 2;
  const box = s.bounds === undefined ? pointsBounds(s.pts) : s.bounds;
  if (!box) return false;
  if (
    Math.max(ax, bx) < box.x - reach ||
    Math.min(ax, bx) > box.x + box.w + reach ||
    Math.max(ay, by) < box.y - reach ||
    Math.min(ay, by) > box.y + box.h + reach
  ) {
    return false;
  }
  const reachSq = reach * reach;
  const p = s.pts;
  const n = Math.floor(p.length / POINT_STRIDE);
  if (n === 1) return segmentDistanceSq(ax, ay, bx, by, p[0]!, p[1]!, p[0]!, p[1]!) <= reachSq;
  for (let i = 0; i + 1 < n; i++) {
    const j = i * POINT_STRIDE;
    const k = j + POINT_STRIDE;
    if (segmentDistanceSq(ax, ay, bx, by, p[j]!, p[j + 1]!, p[k]!, p[k + 1]!) <= reachSq) return true;
  }
  return false;
}
