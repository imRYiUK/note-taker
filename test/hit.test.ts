import { describe, expect, test } from "bun:test";
import { hitsStroke, pointsBounds, segmentDistanceSq } from "../src/shared/hit.ts";

describe("segmentDistanceSq", () => {
  test("crossing, parallel, collinear-apart and point cases", () => {
    expect(segmentDistanceSq(0, 0, 10, 10, 0, 10, 10, 0)).toBeCloseTo(0);
    expect(segmentDistanceSq(0, 0, 10, 0, 0, 3, 10, 3)).toBeCloseTo(9);
    expect(segmentDistanceSq(0, 0, 10, 0, 13, 0, 20, 0)).toBeCloseTo(9);
    expect(segmentDistanceSq(5, 5, 5, 5, 0, 0, 10, 0)).toBeCloseTo(25);
    expect(segmentDistanceSq(0, 0, 0, 0, 3, 4, 3, 4)).toBeCloseTo(25);
  });
});

describe("hitsStroke", () => {
  // Horizontal line from (100,100) to (300,100), 10 units wide.
  const stroke = { pts: [100, 100, 0.3, 0, 200, 100, 0.3, 8, 300, 100, 0.3, 16], width: 10 };

  test("eraser touching the line (incl. its half width) hits", () => {
    expect(hitsStroke(stroke, 150, 100, 150, 100, 1)).toBe(true);
    expect(hitsStroke(stroke, 150, 110, 150, 110, 5)).toBe(true); // 10 away ≤ 5 + 5
    expect(hitsStroke(stroke, 150, 111, 150, 111, 5)).toBe(false);
    expect(hitsStroke(stroke, 320, 100, 320, 100, 5)).toBe(false);
  });

  test("a fast swipe across the line hits even with no sample on it", () => {
    expect(hitsStroke(stroke, 150, 50, 150, 150, 2)).toBe(true);
    expect(hitsStroke(stroke, 50, 50, 50, 150, 2)).toBe(false);
  });

  test("single-point strokes (dots)", () => {
    const dot = { pts: [10, 10, 0.5, 0], width: 6 };
    expect(hitsStroke(dot, 15, 10, 15, 10, 2)).toBe(true);
    expect(hitsStroke(dot, 16, 10, 16, 10, 2)).toBe(false);
  });

  test("bounds", () => {
    expect(pointsBounds(stroke.pts)).toEqual({ x: 100, y: 100, w: 200, h: 0 });
    expect(pointsBounds([])).toBeNull();
    expect(hitsStroke({ pts: [], width: 10 }, 0, 0, 0, 0, 100)).toBe(false);
  });
});
