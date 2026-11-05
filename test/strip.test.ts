import { describe, expect, test } from "bun:test";
import { A4 } from "../src/shared/ink.ts";
import { Strip, lerpRect } from "../src/shared/strip.ts";
import { LINED, lineCount } from "../src/shared/templates.ts";

// S23 Ultra landscape fullscreen at zoom 1.6: 824×384 CSS px → 515×240 units.
const SIZE = { w: 515, h: 240 };
const make = () => new Strip(A4, SIZE);
const center = (s: Strip) => s.rect.y + s.rect.h / 2;

describe("strip", () => {
  test("starts on the first line, just left of the margin", () => {
    const s = make();
    expect(s.line).toBe(0);
    expect(s.rect.x).toBe(LINED.marginLeft - 40);
    expect(center(s)).toBe(LINED.top + LINED.lineHeight / 2);
    expect(s.rect.w).toBe(515);
  });

  test("pen-up in the advance zone shifts after the delay", () => {
    const s = make();
    const x0 = s.rect.x;
    s.penUp(x0 + 0.9 * SIZE.w, 1000);
    expect(s.dueAt).toBe(1350);
    expect(s.tick(1349)).toBeNull();
    const r = s.tick(1350);
    expect(r?.x).toBeCloseTo(x0 + 0.6 * SIZE.w);
    expect(s.dueAt).toBeNull();
    expect(s.tick(2000)).toBeNull(); // fires once
  });

  test("pen-up outside the zone doesn't arm", () => {
    const s = make();
    s.penUp(s.rect.x + 0.5 * SIZE.w, 0);
    expect(s.dueAt).toBeNull();
    expect(s.tick(10_000)).toBeNull();
  });

  test("pen-down while pending cancels the shift", () => {
    const s = make();
    const x0 = s.rect.x;
    s.penUp(x0 + 0.95 * SIZE.w, 0);
    s.penDown();
    expect(s.tick(1000)).toBeNull();
    expect(s.rect.x).toBe(x0);
  });

  test("a later pen-up outside the zone disarms", () => {
    const s = make();
    s.penUp(s.rect.x + 0.95 * SIZE.w, 0);
    s.penUp(s.rect.x + 0.1 * SIZE.w, 100);
    expect(s.tick(1000)).toBeNull();
  });

  test("advances flush to the right edge, then wraps to the next line", () => {
    const s = make();
    let steps = 0;
    while (s.line === 0 && steps < 50) {
      s.advance();
      steps++;
      expect(s.rect.x + s.rect.w).toBeLessThanOrEqual(A4.width + 1e-9);
    }
    expect(s.line).toBe(1);
    expect(s.rect.x).toBe(LINED.marginLeft - 40);
    expect(center(s)).toBe(LINED.top + 1.5 * LINED.lineHeight);
    // 210 → 1585 (flush) takes ⌈1375 / 309⌉ = 5 steps, the 6th wraps.
    expect(steps).toBe(6);
  });

  test("new line on the last line stays there", () => {
    const s = make();
    const last = lineCount(A4) - 1;
    s.goToLine(last);
    s.newLine();
    expect(s.line).toBe(last);
    expect(s.rect.y + s.rect.h).toBeLessThanOrEqual(A4.height);
  });

  test("back steps left, and from the line start goes to the end of the previous line", () => {
    const s = make();
    s.advance();
    s.advance();
    const x = s.rect.x;
    s.back();
    expect(s.rect.x).toBeCloseTo(x - 0.6 * SIZE.w);
    s.newLine();
    expect(s.line).toBe(1);
    s.back();
    expect(s.line).toBe(0);
    expect(s.rect.x).toBe(A4.width - SIZE.w);
  });

  test("moves are clamped to the page", () => {
    const s = make();
    s.moveTo(-500, -500);
    expect(s.rect).toMatchObject({ x: 0, y: 0 });
    s.panBy(1e6, 1e6);
    expect(s.rect).toMatchObject({ x: A4.width - SIZE.w, y: A4.height - SIZE.h });
  });

  test("moving cancels a pending shift", () => {
    const s = make();
    s.penUp(s.rect.x + 0.95 * SIZE.w, 0);
    s.panBy(10, 0);
    expect(s.dueAt).toBeNull();
  });

  test("resize keeps the anchor point fixed on screen", () => {
    const s = make();
    s.moveTo(800, 1000);
    const anchor = { x: 900, y: 1060 }; // 100/515 across, 60/240 down
    s.resize(SIZE.w / 2, SIZE.h / 2, anchor);
    expect(s.rect.w).toBe(SIZE.w / 2);
    expect((anchor.x - s.rect.x) / s.rect.w).toBeCloseTo(100 / 515);
    expect((anchor.y - s.rect.y) / s.rect.h).toBeCloseTo(60 / 240);
  });

  test("resize defaults to keeping the centre", () => {
    const s = make();
    s.moveTo(800, 1000);
    const cx = s.rect.x + s.rect.w / 2;
    const cy = center(s);
    s.resize(300, 140);
    expect(s.rect.x + s.rect.w / 2).toBeCloseTo(cx);
    expect(center(s)).toBeCloseTo(cy);
  });

  test("a strip wider than the page is centred", () => {
    const s = new Strip(A4, { w: 3000, h: 240 });
    expect(s.rect.x).toBe(-450);
    s.advance(); // nowhere to go: wraps
    expect(s.line).toBe(1);
  });

  test("lerpRect eases and clamps", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 100, y: 50, w: 10, h: 10 };
    expect(lerpRect(a, b, 0)).toEqual(a);
    expect(lerpRect(a, b, 1)).toEqual(b);
    expect(lerpRect(a, b, 2)).toEqual(b);
    expect(lerpRect(a, b, 0.5).x).toBeGreaterThan(50); // ease-out
  });
});
