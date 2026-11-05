import { describe, expect, test } from "bun:test";
import { Gestures, type TouchLike } from "../src/pad/gestures.ts";

function setup(penNear = () => false) {
  const log: string[] = [];
  const pans: [number, number][] = [];
  const pinches: number[] = [];
  const g = new Gestures(
    {
      tap: (n) => log.push(`tap${n}`),
      pan: (dx, dy) => pans.push([dx, dy]),
      pinch: (f) => pinches.push(f),
      end: () => log.push("end"),
    },
    penNear,
  );
  const ev = (pointerId: number, clientX: number, clientY: number, timeStamp: number, size = 10): TouchLike => ({
    pointerId,
    clientX,
    clientY,
    timeStamp,
    width: size,
    height: size,
  });
  return { g, log, pans, pinches, ev };
}

describe("gestures", () => {
  test("two- and three-finger taps", () => {
    const { g, log, ev } = setup();
    g.down(ev(1, 100, 100, 0));
    g.down(ev(2, 200, 100, 30));
    g.up(ev(1, 100, 100, 120));
    g.up(ev(2, 200, 100, 140));
    g.down(ev(3, 100, 100, 1000));
    g.down(ev(4, 150, 100, 1010));
    g.down(ev(5, 200, 100, 1020));
    for (const id of [3, 4, 5]) g.up(ev(id, 0, 0, 1100));
    expect(log).toEqual(["tap2", "tap3"]);
  });

  test("one-finger tap and slow taps do nothing", () => {
    const { g, log, ev } = setup();
    g.down(ev(1, 100, 100, 0));
    g.up(ev(1, 100, 100, 50));
    g.down(ev(1, 100, 100, 1000));
    g.down(ev(2, 200, 100, 1010));
    g.up(ev(1, 100, 100, 1500));
    g.up(ev(2, 200, 100, 1500));
    expect(log).toEqual([]);
  });

  test("one-finger drag pans, without the slop jump", () => {
    const { g, log, pans, ev } = setup();
    g.down(ev(1, 100, 100, 0));
    g.move(ev(1, 120, 100, 10)); // crosses slop: starts the pan
    g.move(ev(1, 130, 105, 20));
    g.move(ev(1, 140, 110, 30));
    g.up(ev(1, 140, 110, 40));
    expect(pans).toEqual([
      [10, 5],
      [10, 5],
    ]);
    expect(log).toEqual(["end"]);
  });

  test("two-finger spread pinches with the right factor", () => {
    const { g, log, pinches, ev } = setup();
    g.down(ev(1, 100, 100, 0));
    g.down(ev(2, 200, 100, 10));
    g.move(ev(2, 220, 100, 20)); // crosses slop → pinch baseline at d=120
    g.move(ev(2, 340, 100, 30)); // d=240
    expect(pinches).toEqual([2]);
    g.up(ev(1, 100, 100, 40));
    g.up(ev(2, 340, 100, 40));
    expect(log).toEqual(["end"]); // no tap
  });

  test("a second finger turns a pan into a pinch", () => {
    const { g, pinches, ev } = setup();
    g.down(ev(1, 100, 100, 0));
    g.move(ev(1, 130, 100, 10));
    g.down(ev(2, 230, 100, 200));
    g.move(ev(2, 330, 100, 210)); // d 100 → 200
    expect(pinches).toEqual([2]);
  });

  test("touches while the pen is near are ignored", () => {
    let near = true;
    const { g, log, pans, ev } = setup(() => near);
    g.down(ev(1, 100, 100, 0));
    g.down(ev(2, 200, 100, 10));
    near = false;
    g.move(ev(1, 150, 100, 20));
    g.up(ev(1, 150, 100, 50));
    g.up(ev(2, 200, 100, 60));
    expect(log).toEqual([]);
    expect(pans).toEqual([]);
  });

  test("the pen coming down stops a pan", () => {
    let near = false;
    const { g, log, pans, ev } = setup(() => near);
    g.down(ev(1, 100, 100, 0));
    g.move(ev(1, 130, 100, 10));
    g.move(ev(1, 140, 100, 20));
    near = true;
    g.move(ev(1, 150, 100, 30));
    expect(pans).toEqual([[10, 0]]);
    expect(log).toEqual(["end"]);
  });

  test("palm-sized contacts never gesture", () => {
    const { g, log, pans, ev } = setup();
    g.down(ev(1, 100, 100, 0, 120));
    g.move(ev(1, 200, 100, 10, 120));
    g.up(ev(1, 200, 100, 20, 120));
    expect(pans).toEqual([]);
    expect(log).toEqual([]);
  });
});
