import { describe, expect, test } from "bun:test";
import {
  DEFAULT_INK,
  applyPressureCurve,
  maxPressure,
  outlineBounds,
  outlineToSvgPath,
  parseInkPatch,
  sanitizeInkSettings,
  strokeOutline,
  unionRect,
} from "../src/shared/ink.ts";

/** A horizontal line from (100,100) to (300,100), constant raw pressure. */
function line(p = 0.3, n = 40): number[] {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) pts.push(100 + (200 * i) / (n - 1), 100, p, i * 4);
  return pts;
}

describe("pressure curve", () => {
  test("normalizes by pressureMax and clamps", () => {
    const s = { pressureMax: 0.4, pressureGamma: 1 };
    expect(applyPressureCurve(0, s)).toBe(0);
    expect(applyPressureCurve(0.2, s)).toBeCloseTo(0.5);
    expect(applyPressureCurve(0.4, s)).toBe(1);
    expect(applyPressureCurve(0.9, s)).toBe(1);
    expect(applyPressureCurve(-1, s)).toBe(0);
  });

  test("gamma < 1 boosts light pressure, and the curve is monotonic", () => {
    expect(applyPressureCurve(0.1, DEFAULT_INK)).toBeGreaterThan(0.1 / DEFAULT_INK.pressureMax);
    let prev = -1;
    for (let p = 0; p <= 1; p += 0.01) {
      const f = applyPressureCurve(p, DEFAULT_INK);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  test("S23 Ultra normal writing (max ≈ 0.37) gets near full width with defaults", () => {
    expect(applyPressureCurve(0.37, DEFAULT_INK)).toBeGreaterThan(0.85);
  });
});

describe("ink settings validation", () => {
  test("patches are clamped and partial", () => {
    expect(parseInkPatch({ pressureMax: 5 })).toEqual({ pressureMax: 1 });
    expect(parseInkPatch({ pressureGamma: 0 })).toEqual({ pressureGamma: 0.2 });
    expect(parseInkPatch({})).toEqual({});
    expect(parseInkPatch({ pressureMax: "0.5" })).toBeNull();
    expect(parseInkPatch({ pressureMax: Number.NaN })).toBeNull();
    expect(parseInkPatch(null)).toBeNull();
    expect(parseInkPatch([1])).toBeNull();
  });

  test("sanitize merges onto defaults", () => {
    expect(sanitizeInkSettings({ pressureGamma: 1.2 })).toEqual({ ...DEFAULT_INK, pressureGamma: 1.2 });
    expect(sanitizeInkSettings(undefined)).toBeNull();
  });
});

describe("outlines", () => {
  test("a stroke produces a closed polygon around its points", () => {
    const o = strokeOutline(line(), 10, DEFAULT_INK, true);
    expect(o.length).toBeGreaterThan(10);
    const b = outlineBounds(o)!;
    expect(b.x).toBeLessThan(100);
    expect(b.x + b.w).toBeGreaterThan(300);
    expect(b.y).toBeLessThan(100);
    expect(b.y + b.h).toBeGreaterThan(100);
  });

  test("more pressure → wider stroke", () => {
    const height = (p: number) => outlineBounds(strokeOutline(line(p), 10, DEFAULT_INK, true))!.h;
    expect(height(0.35)).toBeGreaterThan(height(0.05) * 1.5);
  });

  test("predicted tail extends the drawn shape", () => {
    const pts = line().slice(0, 20 * 4);
    const tail = [400, 100, 0.3, 200];
    const without = outlineBounds(strokeOutline(pts, 10, DEFAULT_INK, false))!;
    const withTail = outlineBounds(strokeOutline(pts, 10, DEFAULT_INK, false, tail))!;
    expect(withTail.x + withTail.w).toBeGreaterThan(without.x + without.w + 50);
  });

  test("a single tap makes a dot", () => {
    const o = strokeOutline([500, 500, 0.3, 0], 10, DEFAULT_INK, true);
    const b = outlineBounds(o)!;
    expect(b.w).toBeGreaterThan(2);
    expect(b.h).toBeGreaterThan(2);
  });

  test("SVG path", () => {
    const d = outlineToSvgPath(strokeOutline(line(), 10, DEFAULT_INK, true));
    expect(d).toMatch(/^M[\d.]+ [\d.]+(Q[\d. ]+)+Z$/);
    expect(outlineToSvgPath([])).toBe("");
  });

  test("empty input", () => {
    expect(strokeOutline([], 10, DEFAULT_INK, true)).toEqual([]);
    expect(outlineBounds([])).toBeNull();
  });
});

test("unionRect and maxPressure", () => {
  expect(unionRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: -5, w: 10, h: 5 })).toEqual({ x: 0, y: -5, w: 15, h: 15 });
  expect(unionRect(null, { x: 1, y: 1, w: 1, h: 1 })).toEqual({ x: 1, y: 1, w: 1, h: 1 });
  expect(maxPressure([0, 0, 0.2, 0, 1, 1, 0.37, 4, 2, 2, 0.1, 8])).toBe(0.37);
});
