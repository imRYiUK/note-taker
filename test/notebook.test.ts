import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Notebook } from "../src/server/notebook.ts";
import { Store, packPoints, unpackPoints } from "../src/server/store.ts";
import { LIMITS, type StrokeBeginMsg } from "../src/shared/protocol.ts";

const begin = (id: string, pageId: string): StrokeBeginMsg => ({
  type: "stroke.begin",
  id,
  pageId,
  tool: "pen",
  color: "#000000",
  width: 10,
});

/** Fresh notebook on an in-memory database, with a ticking clock. */
function fresh() {
  let t = 1000;
  const store = new Store(":memory:");
  const nb = new Notebook(store, () => t++);
  return { store, nb, page: nb.page.id };
}

/** Draw and commit a one-point stroke. */
function draw(nb: Notebook, id: string, owner = "pad") {
  nb.begin(owner, begin(id, nb.page.id));
  nb.points(owner, id, [1, 2, 0.3, 0]);
  return nb.end(owner, id, 1);
}

const ids = (nb: Notebook) => nb.snapshot().strokes.map((s) => s.id);

describe("Notebook: live strokes", () => {
  test("begin → points → end commits the stroke", () => {
    const { nb, page } = fresh();
    expect(nb.begin("pad", begin("s1", page))).toBe("ok");
    expect(nb.points("pad", "s1", [1, 2, 0.3, 0, 3, 4, 0.3, 4])).toBe(true);
    expect(nb.points("pad", "s1", [5, 6, 0.2, 8])).toBe(true);
    const res = nb.end("pad", "s1", 3)!;
    expect(res.kind).toBe("committed");
    if (res.kind !== "committed") return;
    expect(res.stroke).toMatchObject({ id: "s1", pageId: page, pts: [1, 2, 0.3, 0, 3, 4, 0.3, 4, 5, 6, 0.2, 8] });
    expect(nb.snapshot().strokes).toHaveLength(1);
  });

  test("point count mismatch asks for a resync and commits nothing", () => {
    const { nb, page } = fresh();
    nb.begin("pad", begin("s1", page));
    nb.points("pad", "s1", [1, 2, 0.3, 0]);
    expect(nb.end("pad", "s1", 5)).toEqual({ kind: "resync", missing: 4 });
    expect(nb.strokeCount).toBe(0);
    // The resend then goes through.
    expect(draw(nb, "s1")?.kind).toBe("committed");
  });

  test("unknown pages, other owners, duplicates", () => {
    const { nb, page } = fresh();
    expect(nb.begin("pad", begin("s1", "nope"))).toBe("unknown_page");
    expect(nb.begin("a", begin("s1", page))).toBe("ok");
    expect(nb.points("b", "s1", [1, 1, 1, 1])).toBe(false);
    expect(nb.end("b", "s1", 0)).toBeNull();
    nb.points("a", "s1", [1, 1, 1, 1]);
    expect(nb.end("a", "s1", 1)?.kind).toBe("committed");
    // Re-sent after a reconnect: already committed.
    expect(nb.begin("a", begin("s1", page))).toBe("duplicate");
    expect(nb.end("c", "s1", 1)).toEqual({ kind: "duplicate" });
    expect(nb.points("a", "unknown", [1, 1, 1, 1])).toBe(false);
  });

  test("a new connection takes over a stroke still live on a dead one", () => {
    const { nb, page } = fresh();
    nb.begin("old", begin("s1", page));
    nb.points("old", "s1", [1, 1, 1, 1, 2, 2, 1, 2]);
    expect(nb.begin("new", begin("s1", page))).toBe("ok");
    expect(nb.points("old", "s1", [3, 3, 1, 3])).toBe(false);
    nb.points("new", "s1", [1, 1, 1, 1]);
    expect(nb.end("new", "s1", 1)?.kind).toBe("committed");
    expect(nb.dropLive("old")).toEqual([]);
  });

  test("empty strokes are not committed", () => {
    const { nb, page } = fresh();
    nb.begin("pad", begin("s1", page));
    expect(nb.end("pad", "s1", 0)).toBeNull();
    expect(nb.strokeCount).toBe(0);
  });

  test("cancel and dropLive", () => {
    const { nb, page } = fresh();
    nb.begin("pad", begin("s1", page));
    expect(nb.cancel("other", "s1")).toBe(false);
    expect(nb.cancel("pad", "s1")).toBe(true);
    expect(nb.cancel("pad", "s1")).toBe(false);

    nb.begin("pad", begin("s2", page));
    nb.begin("pad", begin("s3", page));
    nb.begin("other", begin("s4", page));
    expect(nb.dropLive("pad").sort()).toEqual(["s2", "s3"]);
    expect(nb.points("other", "s4", [1, 1, 1, 1])).toBe(true);
  });

  test("caps stroke length", () => {
    const { nb, page } = fresh();
    nb.begin("pad", begin("s1", page));
    const chunk = new Array(LIMITS.pointsPerMessage * 4).fill(1);
    let accepted = 0;
    while (nb.points("pad", "s1", chunk)) accepted += LIMITS.pointsPerMessage;
    expect(accepted).toBeLessThanOrEqual(LIMITS.pointsPerStroke);
    expect(accepted).toBeGreaterThan(LIMITS.pointsPerStroke - LIMITS.pointsPerMessage);
  });
});

describe("Notebook: erase, undo, redo", () => {
  test("undo / redo of drawing", () => {
    const { nb } = fresh();
    expect(nb.history()).toEqual({ canUndo: false, canRedo: false });
    draw(nb, "a");
    draw(nb, "b");
    expect(nb.history()).toEqual({ canUndo: true, canRedo: false });

    expect(nb.undo()?.removed?.ids).toEqual(["b"]);
    expect(ids(nb)).toEqual(["a"]);
    expect(nb.undo()?.removed?.ids).toEqual(["a"]);
    expect(nb.undo()).toBeNull();
    expect(nb.history()).toEqual({ canUndo: false, canRedo: true });

    expect(nb.redo()?.restored.map((s) => s.id)).toEqual(["a"]);
    expect(nb.redo()?.restored.map((s) => s.id)).toEqual(["b"]);
    expect(nb.redo()).toBeNull();
    expect(ids(nb)).toEqual(["a", "b"]);
  });

  test("erase is undoable and restores paint order", () => {
    const { nb, page } = fresh();
    for (const id of ["a", "b", "c"]) draw(nb, id);
    expect(nb.erase(page, ["b", "missing"])?.removed).toEqual({ pageId: page, ids: ["b"] });
    expect(nb.erase(page, ["b"])).toBeNull(); // already gone
    expect(ids(nb)).toEqual(["a", "c"]);
    expect(nb.undo()?.restored.map((s) => s.id)).toEqual(["b"]);
    expect(ids(nb)).toEqual(["a", "b", "c"]);
    expect(nb.redo()?.removed?.ids).toEqual(["b"]);
  });

  test("erases of one gesture merge into one undo step", () => {
    const { nb, page } = fresh();
    for (const id of ["a", "b", "c", "d"]) draw(nb, id);
    nb.erase(page, ["a"], "g1");
    nb.erase(page, ["b"], "g1");
    nb.erase(page, ["c"], "g2");
    expect(nb.undo()?.restored.map((s) => s.id)).toEqual(["c"]);
    expect(nb.undo()?.restored.map((s) => s.id)).toEqual(["a", "b"]);
    // An erase after an undo starts a new op even with the same group.
    nb.erase(page, ["a"], "g1");
    expect(nb.undo()?.restored.map((s) => s.id)).toEqual(["a"]);
  });

  test("clear is one undo step", () => {
    const { nb, page } = fresh();
    for (const id of ["a", "b"]) draw(nb, id);
    expect(nb.clear("wrong")).toBeNull();
    expect(nb.clear(page)?.removed?.ids.sort()).toEqual(["a", "b"]);
    expect(nb.strokeCount).toBe(0);
    expect(nb.undo()?.restored).toHaveLength(2);
    expect(nb.strokeCount).toBe(2);
  });

  test("clear keeps strokes still being drawn", () => {
    const { nb, page } = fresh();
    draw(nb, "done");
    nb.begin("pad", begin("drawing", page));
    nb.points("pad", "drawing", [2, 2, 1, 1]);
    nb.clear(page);
    expect(nb.end("pad", "drawing", 1)?.kind).toBe("committed");
    expect(ids(nb)).toEqual(["drawing"]);
  });

  test("new work drops the redo branch and its orphaned strokes", () => {
    const { nb, store } = fresh();
    draw(nb, "a");
    draw(nb, "b");
    nb.undo(); // b hidden
    draw(nb, "c");
    expect(nb.history()).toEqual({ canUndo: true, canRedo: false });
    expect(store.hasStroke("b")).toBe(false);
    expect(nb.undo()?.removed?.ids).toEqual(["c"]);
    expect(nb.undo()?.removed?.ids).toEqual(["a"]);
  });
});

describe("Store", () => {
  test("points survive the Float32 round trip with the pad's rounding", () => {
    const pts = [1234.3, 2969.9, 0.317, 16.7, 0.1, 0, 1, 123456.7];
    expect(unpackPoints(packPoints(pts))).toEqual(pts);
    // Unaligned blob (as SQLite may hand it back).
    const raw = packPoints(pts);
    const shifted = new Uint8Array(raw.length + 1);
    shifted.set(raw, 1);
    expect(unpackPoints(shifted.subarray(1))).toEqual(pts);
  });

  test("strokes and history persist across restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-taker-store-"));
    try {
      const file = join(dir, "notes.db");
      let store = new Store(file);
      let nb = new Notebook(store);
      const page = nb.page.id;
      draw(nb, "a");
      draw(nb, "b");
      nb.erase(page, ["a"]);
      store.close();

      store = new Store(file);
      nb = new Notebook(store);
      expect(nb.page.id).toBe(page);
      expect(nb.snapshot().strokes).toMatchObject([{ id: "b", pts: [1, 2, 0.3, 0] }]);
      expect(nb.undo()?.restored.map((s) => s.id)).toEqual(["a"]);
      expect(ids(nb)).toEqual(["a", "b"]);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
