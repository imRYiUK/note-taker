import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { INFINITE_MAX, Library, grownHeight } from "../src/server/notebook.ts";
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
  const nb = new Library(store, () => t++);
  return { store, nb, page: nb.page.id };
}

/** Draw and commit a one-point stroke. */
function draw(nb: Library, id: string, owner = "pad") {
  nb.begin(owner, begin(id, nb.page.id));
  nb.points(owner, id, [1, 2, 0.3, 0]);
  return nb.end(owner, id, 1);
}

const ids = (nb: Library) => nb.snapshot().strokes.map((s) => s.id);

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
      let nb = new Library(store);
      const page = nb.page.id;
      draw(nb, "a");
      draw(nb, "b");
      nb.erase(page, ["a"]);
      store.close();

      store = new Store(file);
      nb = new Library(store);
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

describe("Library: notebooks and pages", () => {
  const drawOn = (nb: Library, id: string, pageId: string, pts = [1, 2, 0.3, 0]) => {
    nb.begin("pad", begin(id, pageId));
    nb.points("pad", id, pts);
    return nb.end("pad", id, pts.length / 4);
  };

  test("first run: one lined notebook with one A4 page", () => {
    const { nb } = fresh();
    expect(nb.notebook).toMatchObject({ title: "Notes", template: "lined", pages: 1 });
    expect(nb.pages).toEqual([nb.page]);
    expect(nb.page).toMatchObject({ kind: "a4", width: 2100, height: 2970, notebookId: nb.notebook.id });
  });

  test("new pages go after the given page and become current", () => {
    const { nb, page: first } = fresh();
    const third = nb.newPage()!;
    expect(nb.page.id).toBe(third.id);
    const second = nb.newPage(first)!;
    expect(nb.pages.map((p) => p.id)).toEqual([first, second.id, third.id]);
    expect(nb.notebook.pages).toBe(3);
    expect(nb.neighbour(-1)?.id).toBe(first);
    expect(nb.neighbour(1)?.id).toBe(third.id);
    expect(nb.newPage("nope")).toBeNull();
  });

  test("goto loads the page's strokes; strokes for a page you left still commit there", () => {
    const { nb, page: first } = fresh();
    draw(nb, "a");
    const second = nb.newPage()!;
    expect(nb.strokeCount).toBe(0);
    // Pad's outbox still had a stroke for the first page.
    expect(drawOn(nb, "late", first)?.kind).toBe("committed");
    expect(nb.strokeCount).toBe(0);
    drawOn(nb, "b", second.id);
    expect(ids(nb)).toEqual(["b"]);
    expect(nb.goto(first)).toBe(true);
    expect(ids(nb)).toEqual(["a", "late"]);
    expect(nb.goto("nope")).toBe(false);
  });

  test("undo of a step on another page reports that page", () => {
    const { nb, page: first } = fresh();
    draw(nb, "a");
    nb.newPage();
    expect(nb.undo()).toMatchObject({ pageId: first, removed: { ids: ["a"] } });
    expect(nb.redo()?.pageId).toBe(first);
  });

  test("erase and clear work on pages other than the current one", () => {
    const { nb, page: first } = fresh();
    draw(nb, "a");
    draw(nb, "b");
    nb.newPage();
    expect(nb.erase(first, ["a"])?.removed).toEqual({ pageId: first, ids: ["a"] });
    expect(nb.clear(first)?.removed?.ids).toEqual(["b"]);
    expect(nb.clear("nope")).toBeNull();
    expect(nb.pageStrokes(first)).toEqual([]);
  });

  test("deleting pages: never the last one; the current one moves to its neighbour", () => {
    const { nb, store, page: first } = fresh();
    expect(nb.deletePage(first)).toEqual({ ok: false, switched: false });
    draw(nb, "a");
    const second = nb.newPage()!;
    const third = nb.newPage()!;
    nb.goto(second.id);
    expect(nb.deletePage(second.id)).toEqual({ ok: true, switched: true });
    expect(nb.page.id).toBe(third.id);
    expect(nb.deletePage(third.id)).toEqual({ ok: true, switched: true });
    expect(nb.page.id).toBe(first);
    // Deleting a page takes its strokes and history with it.
    nb.newPage();
    expect(nb.deletePage(first).switched).toBe(false);
    expect(store.hasStroke("a")).toBe(false);
    expect(nb.history().canUndo).toBe(false);
    expect(nb.pages).toHaveLength(1);
  });

  test("a stroke on a page deleted mid-stroke is dropped", () => {
    const { nb, page: first } = fresh();
    nb.newPage();
    nb.begin("pad", begin("s", first));
    nb.points("pad", "s", [1, 1, 1, 1]);
    nb.deletePage(first);
    expect(nb.end("pad", "s", 1)).toBeNull();
    nb.begin("pad", begin("s2", nb.page.id));
    nb.points("pad", "s2", [1, 1, 1, 1]);
    const other = nb.page.id;
    nb.newPage();
    nb.deletePage(other);
    expect(nb.begin("pad", begin("s3", other))).toBe("unknown_page");
  });

  test("notebooks: create, switch (back to where you were), rename, template, delete", () => {
    const { nb, page: first } = fresh();
    const notes = nb.notebook.id;
    nb.newPage();
    nb.goto(first);
    const math = nb.newNotebook("Math", "grid", "infinite");
    expect(nb.notebook).toMatchObject({ id: math.id, title: "Math", template: "grid", pages: 1 });
    expect(nb.page.kind).toBe("infinite");
    expect(nb.history().canUndo).toBe(false);
    // New pages copy the kind of the page they follow.
    expect(nb.newPage()?.kind).toBe("infinite");
    expect(nb.notebooks().map((n) => n.title)).toEqual(["Math", "Notes"]);

    expect(nb.openNotebook(notes)).toBe(true);
    expect(nb.page.id).toBe(first);
    expect(nb.openNotebook("nope")).toBe(false);

    expect(nb.updateNotebook(notes, { title: "Journal", template: "dotted" })).toBe(true);
    expect(nb.notebook).toMatchObject({ title: "Journal", template: "dotted" });
    expect(nb.updateNotebook("nope", { title: "x" })).toBe(false);

    expect(nb.deleteNotebook(math.id)).toEqual({ ok: true, switched: false });
    expect(nb.deleteNotebook(notes)).toEqual({ ok: true, switched: true });
    // Nothing left: a fresh notebook appears.
    expect(nb.notebooks()).toHaveLength(1);
    expect(nb.notebook).toMatchObject({ title: "Notes", pages: 1 });
    expect(nb.deleteNotebook("nope").ok).toBe(false);
  });

  test("goto into another notebook switches notebooks", () => {
    const { nb, page: first } = fresh();
    const notes = nb.notebook.id;
    nb.newNotebook("Other", "blank", "a4");
    expect(nb.goto(first)).toBe(true);
    expect(nb.notebook.id).toBe(notes);
  });

  test("infinite pages grow to keep room below the writing", () => {
    const { nb } = fresh();
    nb.newNotebook("Endless", "lined", "infinite");
    const page = nb.page.id;
    expect(drawOn(nb, "top", page, [100, 500, 0.3, 0])).toMatchObject({ grown: null });
    const res = drawOn(nb, "low", page, [100, 2500, 0.3, 0, 100, 2600, 0.3, 5]);
    expect(res).toMatchObject({ kind: "committed", grown: { id: page, height: 4000 } });
    expect(nb.page.height).toBe(4000);
    expect(nb.pages[0]!.height).toBe(4000);
    expect(grownHeight({ ...nb.page, kind: "a4" }, [0, 1e5, 0, 0])).toBeNull();
    expect(grownHeight(nb.page, [0, 1e6, 0, 0])).toBe(INFINITE_MAX);
  });

  test("the current notebook and page survive a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-taker-lib-"));
    try {
      const file = join(dir, "notes.db");
      let store = new Store(file);
      let nb = new Library(store);
      nb.newNotebook("Second", "dotted", "a4");
      draw(nb, "x");
      const p2 = nb.newPage()!;
      store.close();

      store = new Store(file);
      nb = new Library(store);
      expect(nb.notebook.title).toBe("Second");
      expect(nb.page.id).toBe(p2.id);
      expect(nb.pages).toHaveLength(2);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a v1 database is migrated (template lined, current page remembered)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-taker-mig-"));
    try {
      const file = join(dir, "notes.db");
      const db = new Database(file, { create: true });
      db.exec(`
        CREATE TABLE notebooks (id TEXT PRIMARY KEY, title TEXT NOT NULL, template TEXT NOT NULL,
                                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE pages (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id),
                            idx INTEGER NOT NULL, kind TEXT NOT NULL, width REAL NOT NULL, height REAL NOT NULL);
        CREATE TABLE strokes (id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id), tool TEXT NOT NULL,
                              color TEXT NOT NULL, width REAL NOT NULL, points BLOB NOT NULL,
                              created_at INTEGER NOT NULL, deleted_at INTEGER);
        CREATE TABLE ops (seq INTEGER PRIMARY KEY AUTOINCREMENT, notebook_id TEXT NOT NULL,
                          kind TEXT NOT NULL, payload TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0);
        INSERT INTO notebooks VALUES ('nb', 'Notes', 'blank', 1, 1);
        INSERT INTO pages VALUES ('p1', 'nb', 0, 'a4', 2100, 2970);
        PRAGMA user_version = 1;`);
      db.close();

      const store = new Store(file);
      const nb = new Library(store);
      expect(nb.notebook).toMatchObject({ id: "nb", template: "lined" });
      const p2 = nb.newPage()!;
      expect(store.currentPage("nb")?.id).toBe(p2.id);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
