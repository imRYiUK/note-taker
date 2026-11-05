// Ink model shared by pad, viewer and (later) export: page geometry, the
// pressure curve and perfect-freehand outlines. Strokes always store *raw*
// pressure; the curve is applied at render time so it can be re-tuned later.

import { getStroke, type StrokeOptions } from "perfect-freehand";

/** 1 unit = 0.1 mm. A4 portrait. */
export const A4 = { width: 2100, height: 2970 } as const;

/** Points are flat `[x, y, pressure, t, x, y, pressure, t, ...]`. */
export const POINT_STRIDE = 4;

export const DEFAULT_PEN_COLOR = "#1d1f2b";
/** Pen diameter at mid pressure, page units. */
export const DEFAULT_PEN_WIDTH = 10;

// ------------------------------------------------------------- pressure curve

export interface InkSettings {
  /** Raw pressure that maps to full width (S23 Ultra tops out ≈ 0.37 in normal writing). */
  pressureMax: number;
  /** Exponent applied after normalizing; < 1 boosts light strokes. */
  pressureGamma: number;
}

export const DEFAULT_INK: InkSettings = { pressureMax: 0.45, pressureGamma: 0.8 };

export const INK_LIMITS: { [K in keyof InkSettings]: readonly [min: number, max: number] } = {
  pressureMax: [0.1, 1],
  pressureGamma: [0.2, 3],
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Validate a partial, untrusted settings object, clamping values to limits.
 * Returns null when `v` isn't an object or has a non-numeric field.
 */
export function parseInkPatch(v: unknown): Partial<InkSettings> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Partial<InkSettings> = {};
  for (const key of Object.keys(INK_LIMITS) as (keyof InkSettings)[]) {
    const value = (v as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    out[key] = clamp(value, ...INK_LIMITS[key]);
  }
  return out;
}

/** `parseInkPatch` merged onto `base` (for loading stored settings). */
export function sanitizeInkSettings(v: unknown, base: InkSettings = DEFAULT_INK): InkSettings | null {
  const patch = parseInkPatch(v);
  return patch ? { ...base, ...patch } : null;
}

/** Raw device pressure → 0..1 width factor. */
export function applyPressureCurve(p: number, s: InkSettings): number {
  return clamp(p / s.pressureMax, 0, 1) ** s.pressureGamma;
}

// ------------------------------------------------------------- outlines

const STROKE_OPTIONS: StrokeOptions = {
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.3,
  simulatePressure: false,
  start: { cap: true, taper: 0 },
  end: { cap: true, taper: 0 },
};

export type Outline = [number, number][];

/**
 * Outline polygon (page units) of a stroke. `tail` holds extra points that are
 * drawn but not stored (predicted pen positions on the pad).
 */
export function strokeOutline(
  pts: ArrayLike<number>,
  width: number,
  ink: InkSettings,
  complete: boolean,
  tail?: ArrayLike<number>,
): Outline {
  const input: number[][] = [];
  const push = (a: ArrayLike<number>) => {
    for (let i = 0; i + POINT_STRIDE <= a.length; i += POINT_STRIDE) {
      input.push([a[i]!, a[i + 1]!, applyPressureCurve(a[i + 2]!, ink)]);
    }
  };
  push(pts);
  if (tail) push(tail);
  return getStroke(input, { ...STROKE_OPTIONS, size: width, last: complete }) as Outline;
}

/** Anything with the canvas path API: a 2D context or a Path2D. */
interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  closePath(): void;
}

/** Trace an outline as smooth quadratic segments through the edge midpoints. */
export function traceOutline(sink: PathSink, o: Outline): void {
  const n = o.length;
  if (n < 2) return;
  if (n < 4) {
    sink.moveTo(o[0]![0], o[0]![1]);
    for (let i = 1; i < n; i++) sink.lineTo(o[i]![0], o[i]![1]);
    sink.closePath();
    return;
  }
  const [x0, y0] = o[0]!;
  const [x1, y1] = o[n - 1]!;
  sink.moveTo((x0 + x1) / 2, (y0 + y1) / 2);
  for (let i = 0; i < n; i++) {
    const [ax, ay] = o[i]!;
    const [bx, by] = o[(i + 1) % n]!;
    sink.quadraticCurveTo(ax, ay, (ax + bx) / 2, (ay + by) / 2);
  }
  sink.closePath();
}

/** Same shape as `traceOutline`, as an SVG path `d` attribute (for export). */
export function outlineToSvgPath(o: Outline, digits = 1): string {
  const parts: string[] = [];
  const f = (v: number) => +v.toFixed(digits);
  traceOutline(
    {
      moveTo: (x, y) => parts.push(`M${f(x)} ${f(y)}`),
      lineTo: (x, y) => parts.push(`L${f(x)} ${f(y)}`),
      quadraticCurveTo: (cx, cy, x, y) => parts.push(`Q${f(cx)} ${f(cy)} ${f(x)} ${f(y)}`),
      closePath: () => parts.push("Z"),
    },
    o,
  );
  return parts.join("");
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function outlineBounds(o: Outline): Rect | null {
  if (!o.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of o) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Highest raw pressure in a flat point array (for calibrating `pressureMax`). */
export function maxPressure(pts: ArrayLike<number>): number {
  let max = 0;
  for (let i = 2; i < pts.length; i += POINT_STRIDE) if (pts[i]! > max) max = pts[i]!;
  return max;
}
