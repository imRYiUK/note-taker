// SQLite persistence (PLAN.md §3): notebooks, pages, strokes and the undo
// history. Strokes are soft-deleted (`deleted_at`) so erase / undo can bring
// them back. Points are packed Float32 (16 bytes per point).

import { Database } from "bun:sqlite";
import { A4, POINT_STRIDE } from "../shared/ink.ts";
import type { NotebookInfo, PageInfo, PageKind, StrokeData, Template, Tool } from "../shared/protocol.ts";

const SCHEMA_VERSION = 2;

// v2: notebooks.current_page (reopen where you left off).
const SCHEMA = `
CREATE TABLE notebooks (id TEXT PRIMARY KEY, title TEXT NOT NULL, template TEXT NOT NULL,
                        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, current_page TEXT);
CREATE TABLE pages     (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id),
                        idx INTEGER NOT NULL, kind TEXT NOT NULL, width REAL NOT NULL, height REAL NOT NULL);
CREATE TABLE strokes   (id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id), tool TEXT NOT NULL,
                        color TEXT NOT NULL, width REAL NOT NULL, points BLOB NOT NULL,
                        created_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE ops       (seq INTEGER PRIMARY KEY AUTOINCREMENT, notebook_id TEXT NOT NULL,
                        kind TEXT NOT NULL, payload TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0);
CREATE INDEX pages_notebook ON pages(notebook_id, idx);
CREATE INDEX strokes_page ON strokes(page_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX ops_notebook ON ops(notebook_id, seq);
`;

export type OpKind = "add" | "erase";

export interface OpPayload {
  pageId: string;
  ids: string[];
  /** Eraser gesture id: later erases of the same gesture merge into this op. */
  group?: string;
}

export interface Op {
  seq: number;
  kind: OpKind;
  payload: OpPayload;
  undone: boolean;
}

interface NotebookRow {
  id: string;
  title: string;
  template: string;
  created_at: number;
  updated_at: number;
  pages: number;
}

interface PageRow {
  id: string;
  notebook_id: string;
  kind: string;
  width: number;
  height: number;
}

interface StrokeRow {
  id: string;
  page_id: string;
  tool: string;
  color: string;
  width: number;
  points: Uint8Array;
  created_at: number;
}

interface OpRow {
  seq: number;
  kind: string;
  payload: string;
  undone: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function packPoints(pts: ArrayLike<number>): Uint8Array {
  return new Uint8Array(Float32Array.from(pts).buffer);
}

/** Float32 → the rounding the pad used (0.1 for x/y/t, 0.001 for pressure). */
export function unpackPoints(blob: Uint8Array): number[] {
  const f = new Float32Array(blob.slice().buffer); // copy: blob may not be 4-byte aligned
  const out = new Array<number>(f.length);
  for (let i = 0; i < f.length; i++) out[i] = i % POINT_STRIDE === 2 ? r3(f[i]!) : r1(f[i]!);
  return out;
}

function toStroke(r: StrokeRow): StrokeData {
  return {
    id: r.id,
    pageId: r.page_id,
    tool: r.tool as Tool,
    color: r.color,
    width: r.width,
    pts: unpackPoints(r.points),
    createdAt: r.created_at,
  };
}

const toNotebook = (r: NotebookRow): NotebookInfo => ({
  id: r.id,
  title: r.title,
  template: r.template as Template,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  pages: r.pages,
});

const toPage = (r: PageRow): PageInfo => ({
  id: r.id,
  notebookId: r.notebook_id,
  kind: r.kind as PageKind,
  width: r.width,
  height: r.height,
});

const NOTEBOOK_COLS = `id, title, template, created_at, updated_at,
  (SELECT COUNT(*) FROM pages p WHERE p.notebook_id = notebooks.id) AS pages`;
const PAGE_COLS = "id, notebook_id, kind, width, height";

const toOp = (r: OpRow): Op => ({
  seq: r.seq,
  kind: r.kind as OpKind,
  payload: JSON.parse(r.payload) as OpPayload,
  undone: r.undone !== 0,
});

/** `?, ?, ?` for an IN (...) list. */
const marks = (n: number) => new Array(n).fill("?").join(", ");

/** SQLite's default limit on bound parameters is 32766; stay well below. */
function chunks<T>(xs: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL"); // WAL + NORMAL: survives app crashes, fast commits
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const { user_version } = this.db.query("PRAGMA user_version").get() as { user_version: number };
    if (user_version === SCHEMA_VERSION) return;
    if (user_version > SCHEMA_VERSION) {
      throw new Error(`database schema v${user_version} is newer than this server (v${SCHEMA_VERSION})`);
    }
    this.tx(() => {
      if (user_version === 0) {
        this.db.exec(SCHEMA);
      } else if (user_version === 1) {
        this.db.exec("ALTER TABLE notebooks ADD COLUMN current_page TEXT");
        // v1 stored 'blank' but always drew ruled lines: keep what people saw.
        this.db.exec("UPDATE notebooks SET template = 'lined' WHERE template = 'blank'");
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ------------------------------------------------------------ notebooks

  /** All notebooks, most recently used first. */
  notebooks(): NotebookInfo[] {
    const rows = this.db
      .query(`SELECT ${NOTEBOOK_COLS} FROM notebooks ORDER BY updated_at DESC, rowid DESC`)
      .all() as NotebookRow[];
    return rows.map(toNotebook);
  }

  notebook(id: string): NotebookInfo | null {
    const r = this.db.query(`SELECT ${NOTEBOOK_COLS} FROM notebooks WHERE id = ?`).get(id) as NotebookRow | null;
    return r && toNotebook(r);
  }

  /** A new notebook with one empty page. */
  createNotebook(title: string, template: Template, kind: PageKind, now: number): { notebook: NotebookInfo; page: PageInfo } {
    return this.tx(() => {
      const id = crypto.randomUUID();
      this.db
        .query("INSERT INTO notebooks (id, title, template, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, title, template, now, now);
      const page = this.insertPage(id, -1, kind);
      this.setCurrentPage(id, page.id);
      return { notebook: this.notebook(id)!, page };
    });
  }

  updateNotebook(id: string, patch: { title?: string; template?: Template }): boolean {
    const nb = this.notebook(id);
    if (!nb) return false;
    this.db
      .query("UPDATE notebooks SET title = ?, template = ? WHERE id = ?")
      .run(patch.title ?? nb.title, patch.template ?? nb.template, id);
    return true;
  }

  /** Delete a notebook with all its pages, strokes and history. */
  deleteNotebook(id: string): void {
    this.tx(() => {
      this.db.query("DELETE FROM strokes WHERE page_id IN (SELECT id FROM pages WHERE notebook_id = ?)").run(id);
      this.db.query("DELETE FROM ops WHERE notebook_id = ?").run(id);
      this.db.query("DELETE FROM pages WHERE notebook_id = ?").run(id);
      this.db.query("DELETE FROM notebooks WHERE id = ?").run(id);
    });
  }

  touchNotebook(id: string, now: number): void {
    this.db.query("UPDATE notebooks SET updated_at = ? WHERE id = ?").run(now, id);
  }

  /** The page the notebook was last on (or its first page). */
  currentPage(notebookId: string): PageInfo | null {
    const r = this.db
      .query(
        `SELECT ${PAGE_COLS} FROM pages WHERE notebook_id = ?1
         ORDER BY id = (SELECT current_page FROM notebooks WHERE id = ?1) DESC, idx LIMIT 1`,
      )
      .get(notebookId) as PageRow | null;
    return r && toPage(r);
  }

  setCurrentPage(notebookId: string, pageId: string): void {
    this.db.query("UPDATE notebooks SET current_page = ? WHERE id = ?").run(pageId, notebookId);
  }

  // ------------------------------------------------------------ pages

  /** Pages of a notebook, in order. */
  pages(notebookId: string): PageInfo[] {
    const rows = this.db
      .query(`SELECT ${PAGE_COLS} FROM pages WHERE notebook_id = ? ORDER BY idx`)
      .all(notebookId) as PageRow[];
    return rows.map(toPage);
  }

  page(id: string): PageInfo | null {
    const r = this.db.query(`SELECT ${PAGE_COLS} FROM pages WHERE id = ?`).get(id) as PageRow | null;
    return r && toPage(r);
  }

  /** Insert an empty page after position `afterIdx` (-1 = at the start). */
  insertPage(notebookId: string, afterIdx: number, kind: PageKind): PageInfo {
    return this.tx(() => {
      // Two steps: shifting in place could collide with a unique index on (notebook_id, idx) one day.
      this.db.query("UPDATE pages SET idx = -(idx + 1) WHERE notebook_id = ? AND idx > ?").run(notebookId, afterIdx);
      this.db.query("UPDATE pages SET idx = -idx WHERE notebook_id = ? AND idx < 0").run(notebookId);
      const page: PageInfo = { id: crypto.randomUUID(), notebookId, kind, width: A4.width, height: A4.height };
      this.db
        .query("INSERT INTO pages (id, notebook_id, idx, kind, width, height) VALUES (?, ?, ?, ?, ?, ?)")
        .run(page.id, notebookId, afterIdx + 1, kind, page.width, page.height);
      return page;
    });
  }

  /** Position of a page in its notebook. */
  pageIndex(id: string): number {
    const r = this.db.query("SELECT idx FROM pages WHERE id = ?").get(id) as { idx: number } | null;
    return r?.idx ?? -1;
  }

  setPageHeight(id: string, height: number): void {
    this.db.query("UPDATE pages SET height = ? WHERE id = ?").run(height, id);
  }

  /** Delete a page, its strokes and the history entries that refer to it. */
  deletePage(id: string): void {
    this.tx(() => {
      const page = this.page(id);
      if (!page) return;
      const idx = this.pageIndex(id);
      this.db.query("DELETE FROM strokes WHERE page_id = ?").run(id);
      this.db.query("DELETE FROM ops WHERE json_extract(payload, '$.pageId') = ?").run(id);
      this.db.query("DELETE FROM pages WHERE id = ?").run(id);
      this.db.query("UPDATE pages SET idx = idx - 1 WHERE notebook_id = ? AND idx > ?").run(page.notebookId, idx);
    });
  }

  // ------------------------------------------------------------ strokes

  /** Visible strokes of a page, oldest first (= paint order). */
  pageStrokes(pageId: string): StrokeData[] {
    const rows = this.db
      .query(
        `SELECT id, page_id, tool, color, width, points, created_at FROM strokes
         WHERE page_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid`,
      )
      .all(pageId) as StrokeRow[];
    return rows.map(toStroke);
  }

  /** Ids of a page's visible strokes. */
  pageStrokeIds(pageId: string): string[] {
    const rows = this.db.query("SELECT id FROM strokes WHERE page_id = ? AND deleted_at IS NULL").all(pageId) as {
      id: string;
    }[];
    return rows.map((r) => r.id);
  }

  /** Strokes by id (deleted or not), oldest first. */
  strokesById(ids: string[]): StrokeData[] {
    const out: StrokeData[] = [];
    for (const part of chunks(ids)) {
      const rows = this.db
        .query(
          `SELECT id, page_id, tool, color, width, points, created_at FROM strokes WHERE id IN (${marks(part.length)})`,
        )
        .all(...part) as StrokeRow[];
      out.push(...rows.map(toStroke));
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Latest stroke timestamp (0 when empty). */
  maxStrokeTime(): number {
    const r = this.db.query("SELECT MAX(created_at) AS t FROM strokes").get() as { t: number | null };
    return r.t ?? 0;
  }

  /** True if the stroke was ever stored (also when erased since). */
  hasStroke(id: string): boolean {
    return this.db.query("SELECT 1 FROM strokes WHERE id = ?").get(id) !== null;
  }

  insertStroke(s: StrokeData): void {
    this.db
      .query(
        `INSERT INTO strokes (id, page_id, tool, color, width, points, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.pageId, s.tool, s.color, s.width, packPoints(s.pts), s.createdAt);
  }

  /**
   * Soft-delete (`at` = timestamp) or restore (`at` = null) strokes.
   * Returns the ids whose state actually changed. With `pageId`, only strokes of that page.
   */
  setDeleted(ids: string[], at: number | null, pageId?: string): string[] {
    const changed: string[] = [];
    let where = at === null ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";
    if (pageId !== undefined) where += " AND page_id = ?";
    for (const part of chunks(ids)) {
      const args = pageId !== undefined ? [at, ...part, pageId] : [at, ...part];
      const rows = this.db
        .query(`UPDATE strokes SET deleted_at = ? WHERE id IN (${marks(part.length)}) AND ${where} RETURNING id`)
        .all(...args) as { id: string }[];
      for (const r of rows) changed.push(r.id);
    }
    return changed;
  }

  // ------------------------------------------------------------ undo history

  /** Most recent op that can be undone. */
  lastDone(notebookId: string): Op | null {
    const r = this.db
      .query("SELECT * FROM ops WHERE notebook_id = ? AND undone = 0 ORDER BY seq DESC LIMIT 1")
      .get(notebookId) as OpRow | null;
    return r && toOp(r);
  }

  /** Oldest undone op (the next one to redo). Undone ops always form the tail of the history. */
  firstUndone(notebookId: string): Op | null {
    const r = this.db
      .query("SELECT * FROM ops WHERE notebook_id = ? AND undone = 1 ORDER BY seq ASC LIMIT 1")
      .get(notebookId) as OpRow | null;
    return r && toOp(r);
  }

  /** Newest op, done or not. */
  lastOp(notebookId: string): Op | null {
    const r = this.db
      .query("SELECT * FROM ops WHERE notebook_id = ? ORDER BY seq DESC LIMIT 1")
      .get(notebookId) as OpRow | null;
    return r && toOp(r);
  }

  /**
   * Record a new op. Like any editor, doing something new forgets the redo
   * branch; strokes only that branch could bring back are deleted for good.
   */
  pushOp(notebookId: string, kind: OpKind, payload: OpPayload): number {
    const undone = this.db
      .query("SELECT * FROM ops WHERE notebook_id = ? AND undone = 1")
      .all(notebookId) as OpRow[];
    if (undone.length) {
      const orphans = undone.map(toOp).flatMap((op) => (op.kind === "add" ? op.payload.ids : []));
      for (const part of chunks(orphans)) {
        this.db.query(`DELETE FROM strokes WHERE id IN (${marks(part.length)}) AND deleted_at IS NOT NULL`).run(...part);
      }
      this.db.query("DELETE FROM ops WHERE notebook_id = ? AND undone = 1").run(notebookId);
    }
    const r = this.db
      .query("INSERT INTO ops (notebook_id, kind, payload) VALUES (?, ?, ?) RETURNING seq")
      .get(notebookId, kind, JSON.stringify(payload)) as { seq: number };
    return r.seq;
  }

  updateOpPayload(seq: number, payload: OpPayload): void {
    this.db.query("UPDATE ops SET payload = ? WHERE seq = ?").run(JSON.stringify(payload), seq);
  }

  setUndone(seq: number, undone: boolean): void {
    this.db.query("UPDATE ops SET undone = ? WHERE seq = ?").run(undone ? 1 : 0, seq);
  }
}
