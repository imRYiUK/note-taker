import { describe, expect, test } from "bun:test";
import { Notebook } from "../src/server/notebook.ts";
import { LIMITS, type StrokeBeginMsg } from "../src/shared/protocol.ts";

const begin = (id: string, pageId = "page-1"): StrokeBeginMsg => ({
  type: "stroke.begin",
  id,
  pageId,
  tool: "pen",
  color: "#000000",
  width: 10,
});

describe("Notebook", () => {
  test("begin → points → end commits the stroke", () => {
    const nb = new Notebook(() => 1234);
    expect(nb.begin("pad", begin("s1"))).toBe("ok");
    expect(nb.points("pad", "s1", [1, 2, 0.3, 0, 3, 4, 0.3, 4])).toBe(true);
    expect(nb.points("pad", "s1", [5, 6, 0.2, 8])).toBe(true);
    const res = nb.end("pad", "s1", 3)!;
    expect(res.missing).toBe(0);
    expect(res.stroke).toMatchObject({ id: "s1", pts: [1, 2, 0.3, 0, 3, 4, 0.3, 4, 5, 6, 0.2, 8], createdAt: 1234 });
    expect(nb.snapshot().strokes).toHaveLength(1);
  });

  test("reports missing points", () => {
    const nb = new Notebook();
    nb.begin("pad", begin("s1"));
    nb.points("pad", "s1", [1, 2, 0.3, 0]);
    expect(nb.end("pad", "s1", 5)!.missing).toBe(4);
  });

  test("rejects unknown pages, duplicates and other owners", () => {
    const nb = new Notebook();
    expect(nb.begin("pad", begin("s1", "nope"))).toBe("unknown_page");
    expect(nb.begin("a", begin("s1"))).toBe("ok");
    expect(nb.begin("b", begin("s1"))).toBe("duplicate");
    expect(nb.points("b", "s1", [1, 1, 1, 1])).toBe(false);
    expect(nb.end("b", "s1", 0)).toBeNull();
    nb.points("a", "s1", [1, 1, 1, 1]);
    nb.end("a", "s1", 1);
    // Re-sent after a reconnect: already committed.
    expect(nb.begin("a", begin("s1"))).toBe("duplicate");
    expect(nb.points("a", "unknown", [1, 1, 1, 1])).toBe(false);
  });

  test("empty strokes are not committed", () => {
    const nb = new Notebook();
    nb.begin("pad", begin("s1"));
    expect(nb.end("pad", "s1", 0)).toBeNull();
    expect(nb.strokeCount).toBe(0);
  });

  test("cancel and dropLive", () => {
    const nb = new Notebook();
    nb.begin("pad", begin("s1"));
    expect(nb.cancel("other", "s1")).toBe(false);
    expect(nb.cancel("pad", "s1")).toBe(true);
    expect(nb.cancel("pad", "s1")).toBe(false);

    nb.begin("pad", begin("s2"));
    nb.begin("pad", begin("s3"));
    nb.begin("other", begin("s4"));
    expect(nb.dropLive("pad").sort()).toEqual(["s2", "s3"]);
    expect(nb.points("other", "s4", [1, 1, 1, 1])).toBe(true);
  });

  test("caps stroke length", () => {
    const nb = new Notebook();
    nb.begin("pad", begin("s1"));
    const chunk = new Array(LIMITS.pointsPerMessage * 4).fill(1);
    let accepted = 0;
    while (nb.points("pad", "s1", chunk)) accepted += LIMITS.pointsPerMessage;
    expect(accepted).toBeLessThanOrEqual(LIMITS.pointsPerStroke);
    expect(accepted).toBeGreaterThan(LIMITS.pointsPerStroke - LIMITS.pointsPerMessage);
  });

  test("clear keeps strokes still being drawn", () => {
    const nb = new Notebook();
    nb.begin("pad", begin("done"));
    nb.points("pad", "done", [1, 1, 1, 1]);
    nb.end("pad", "done", 1);
    nb.begin("pad", begin("drawing"));
    nb.points("pad", "drawing", [2, 2, 1, 1]);
    expect(nb.clear("wrong")).toBe(false);
    expect(nb.clear("page-1")).toBe(true);
    expect(nb.strokeCount).toBe(0);
    expect(nb.end("pad", "drawing", 1)).not.toBeNull();
    expect(nb.snapshot().strokes.map((s) => s.id)).toEqual(["drawing"]);
  });
});
