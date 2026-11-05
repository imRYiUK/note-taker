// Authoritative notebook state: every notebook and page (SQLite), the current
// notebook + page that all clients look at (strokes mirrored in memory),
// strokes being drawn right now (memory only) and each notebook's undo/redo
// history.
//
// Strokes may arrive for any existing page, not just the current one: a pad's
// outbox can still hold strokes from a page it has since left.

import { A4, POINT_STRIDE } from "../shared/ink.ts";
import {
  LIMITS,
  type HistoryState,
  type NotebookInfo,
  type NotebookState,
  type PageInfo,
  type PageKind,
  type StrokeBeginMsg,
  type StrokeData,
  type Template,
} from "../shared/protocol.ts";
import type { Op, Store } from "./store.ts";

interface LiveStroke {
  owner: string; // client id that is drawing it
  data: StrokeData;
}

export type BeginResult = "ok" | "duplicate" | "unknown_page";

export type EndResult =
  /** `grown`: an infinite page got taller to keep room below the writing. */
  | { kind: "committed"; stroke: StrokeData; grown: PageInfo | null }
  /** Already stored (a resend after reconnect). */
  | { kind: "duplicate" }
  /** The page was deleted while the stroke was drawn: dropped. */
  | { kind: "gone" }
  /** Point count doesn't match what the pad sent: dropped, the pad must resend it. */
  | { kind: "resync"; missing: number };

/** What an erase / undo / redo did, for broadcasting. */
export interface Change {
  /** The page it happened on. */
  pageId: string;
  removed: { pageId: string; ids: string[] } | null;
  restored: StrokeData[];
}

export const DEFAULT_TITLE = "Notes";
export const DEFAULT_TEMPLATE: Template = "lined";

/** Infinite pages keep at least this much paper below the lowest ink (10 cm)… */
export const INFINITE_FREE = 1000;
/** …growing in steps of this (5 cm)… */
export const INFINITE_STEP = 500;
/** …up to ten A4 pages long (start a new page after that). */
export const INFINITE_MAX = 10 * A4.height;

export class Library {
  /** The current notebook and page (what every client shows). */
  notebook!: NotebookInfo;
  pages!: PageInfo[];
  page!: PageInfo;
  /** Visible committed strokes of the current page, in paint order. */
  private readonly strokes = new Map<string, StrokeData>();
  private readonly live = new Map<string, LiveStroke>();
  /** Stroke timestamps are strictly increasing, so they define paint order unambiguously. */
  private lastCreatedAt: number;

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    this.lastCreatedAt = store.maxStrokeTime();
    const recent = store.notebooks()[0];
    this.load(recent ? recent.id : this.store.createNotebook(DEFAULT_TITLE, DEFAULT_TEMPLATE, "a4", now()).notebook.id);
  }

  // ------------------------------------------------------------ views

  snapshot(): NotebookState & { page: PageInfo; strokes: StrokeData[] } {
    return { ...this.state(), page: { ...this.page }, strokes: [...this.strokes.values()] };
  }

  state(): NotebookState {
    return { notebook: { ...this.notebook }, pages: this.pages.map((p) => ({ ...p })) };
  }

  notebooks(): NotebookInfo[] {
    return this.store.notebooks();
  }

  history(): HistoryState {
    const id = this.notebook.id;
    return { canUndo: this.store.lastDone(id) !== null, canRedo: this.store.firstUndone(id) !== null };
  }

  get strokeCount(): number {
    return this.strokes.size;
  }

  /** Visible strokes of any page (current one from memory). */
  pageStrokes(pageId: string): StrokeData[] {
    return pageId === this.page.id ? [...this.strokes.values()] : this.store.pageStrokes(pageId);
  }

  hasPage(pageId: string): boolean {
    return pageId === this.page.id || this.store.page(pageId) !== null;
  }

  // ------------------------------------------------------------ navigation

  /** Make a page current (switching notebooks if needed). False if there's no such page. */
  goto(pageId: string): boolean {
    const page = this.store.page(pageId);
    if (!page) return false;
    this.store.setCurrentPage(page.notebookId, page.id);
    if (page.notebookId !== this.notebook.id) this.load(page.notebookId);
    else this.showPage(page);
    return true;
  }

  /** The page `delta` positions away from the current one, or null at the ends. */
  neighbour(delta: number): PageInfo | null {
    const i = this.pages.findIndex((p) => p.id === this.page.id);
    return this.pages[i + delta] ?? null;
  }

  /** New page in the current notebook after `afterPageId` (default: the current page), made current. */
  newPage(afterPageId?: string): PageInfo | null {
    if (this.pages.length >= LIMITS.pagesPerNotebook) return null;
    const after = afterPageId ? this.pages.find((p) => p.id === afterPageId) : this.page;
    if (!after) return null;
    const page = this.store.tx(() => {
      const p = this.store.insertPage(this.notebook.id, this.store.pageIndex(after.id), after.kind);
      this.store.touchNotebook(this.notebook.id, this.now());
      return p;
    });
    this.refresh();
    this.goto(page.id);
    return page;
  }

  /**
   * Delete a page of any notebook (its strokes and history go with it). A
   * notebook keeps at least one page. Returns whether the current page changed.
   */
  deletePage(pageId: string): { ok: boolean; switched: boolean } {
    const page = this.store.page(pageId);
    if (!page) return { ok: false, switched: false };
    const pages = this.store.pages(page.notebookId);
    if (pages.length <= 1) return { ok: false, switched: false };
    const i = pages.findIndex((p) => p.id === pageId);
    const isCurrent = pageId === this.page.id;
    this.store.tx(() => {
      this.store.deletePage(pageId);
      this.store.touchNotebook(page.notebookId, this.now());
    });
    for (const [id, s] of this.live) if (s.data.pageId === pageId) this.live.delete(id);
    if (page.notebookId !== this.notebook.id) return { ok: true, switched: false };
    this.refresh();
    // Same position (the page after it), or the new last page.
    if (isCurrent) this.goto((pages[i + 1] ?? pages[i - 1])!.id);
    return { ok: true, switched: isCurrent };
  }

  openNotebook(id: string): boolean {
    const page = this.store.currentPage(id);
    return page ? this.goto(page.id) : false;
  }

  newNotebook(title: string, template: Template, kind: PageKind): NotebookInfo {
    const { notebook } = this.store.createNotebook(title, template, kind, this.now());
    this.load(notebook.id);
    return notebook;
  }

  updateNotebook(id: string, patch: { title?: string; template?: Template }): boolean {
    if (!this.store.updateNotebook(id, patch)) return false;
    if (id === this.notebook.id) this.refresh();
    return true;
  }

  /** Delete a notebook. If it was current, the most recent other one opens (a fresh one if none is left). */
  deleteNotebook(id: string): { ok: boolean; switched: boolean } {
    if (!this.store.notebook(id)) return { ok: false, switched: false };
    const pageIds = new Set(this.store.pages(id).map((p) => p.id));
    this.store.deleteNotebook(id);
    for (const [sid, s] of this.live) if (pageIds.has(s.data.pageId)) this.live.delete(sid);
    if (id !== this.notebook.id) return { ok: true, switched: false };
    const next = this.store.notebooks()[0];
    this.load(next ? next.id : this.store.createNotebook(DEFAULT_TITLE, DEFAULT_TEMPLATE, "a4", this.now()).notebook.id);
    return { ok: true, switched: true };
  }

  private load(notebookId: string): void {
    const page = this.store.currentPage(notebookId);
    if (!page) throw new Error(`notebook ${notebookId} has no pages`);
    this.store.setCurrentPage(notebookId, page.id);
    this.notebook = this.store.notebook(notebookId)!;
    this.pages = this.store.pages(notebookId);
    this.showPage(page);
  }

  /** Re-read the current notebook's info and page list (after structural changes). */
  private refresh(): void {
    this.notebook = this.store.notebook(this.notebook.id)!;
    this.pages = this.store.pages(this.notebook.id);
    this.page = this.pages.find((p) => p.id === this.page.id) ?? this.page;
  }

  private showPage(page: PageInfo): void {
    this.page = page;
    this.strokes.clear();
    for (const s of this.store.pageStrokes(page.id)) this.strokes.set(s.id, s);
  }

  // ------------------------------------------------------------ live strokes

  begin(owner: string, msg: StrokeBeginMsg): BeginResult {
    // Same id again after a reconnect, but the first copy is already stored.
    if (this.store.hasStroke(msg.id)) return "duplicate";
    if (msg.pageId !== this.page.id && !this.store.page(msg.pageId)) return "unknown_page";
    // A live stroke with this id from another connection: the pad reconnected
    // before the server noticed the old socket died. Ids are per-pad UUIDs, so
    // the newer connection takes the stroke over and restarts it.
    this.live.set(msg.id, {
      owner,
      data: {
        id: msg.id,
        pageId: msg.pageId,
        tool: msg.tool,
        color: msg.color,
        width: msg.width,
        pts: [],
        createdAt: 0, // assigned on commit
      },
    });
    return "ok";
  }

  /** Append points; false if the stroke is unknown, not ours or too long. */
  points(owner: string, id: string, pts: number[]): boolean {
    const s = this.live.get(id);
    if (!s || s.owner !== owner) return false;
    if ((s.data.pts.length + pts.length) / POINT_STRIDE > LIMITS.pointsPerStroke) return false;
    for (const v of pts) s.data.pts.push(v);
    return true;
  }

  /** Commit a live stroke: stored together with its undo step. Null if unknown / not ours / empty. */
  end(owner: string, id: string, n: number): EndResult | null {
    const s = this.live.get(id);
    if (!s || s.owner !== owner) return this.store.hasStroke(id) ? { kind: "duplicate" } : null;
    this.live.delete(id);
    const received = s.data.pts.length / POINT_STRIDE;
    if (received !== n) return { kind: "resync", missing: n - received };
    if (received === 0) return null;
    const stroke = s.data;
    const page = stroke.pageId === this.page.id ? this.page : this.store.page(stroke.pageId);
    if (!page) return { kind: "gone" };
    stroke.createdAt = this.lastCreatedAt = Math.max(this.now(), this.lastCreatedAt + 1);
    const height = grownHeight(page, stroke.pts);
    this.store.tx(() => {
      this.store.insertStroke(stroke);
      this.store.pushOp(page.notebookId, "add", { pageId: page.id, ids: [stroke.id] });
      if (height !== null) this.store.setPageHeight(page.id, height);
      this.store.touchNotebook(page.notebookId, this.now());
    });
    if (page.id === this.page.id) this.strokes.set(id, stroke);
    let grown: PageInfo | null = null;
    if (height !== null) {
      grown = { ...page, height };
      if (page.notebookId === this.notebook.id) this.refresh();
    }
    return { kind: "committed", stroke, grown };
  }

  cancel(owner: string, id: string): boolean {
    const s = this.live.get(id);
    if (!s || s.owner !== owner) return false;
    this.live.delete(id);
    return true;
  }

  /** Drop everything a disconnected client was still drawing; returns the stroke ids. */
  dropLive(owner: string): string[] {
    const ids: string[] = [];
    for (const [id, s] of this.live) {
      if (s.owner === owner) {
        this.live.delete(id);
        ids.push(id);
      }
    }
    return ids;
  }

  // ------------------------------------------------------------ edits

  /**
   * Erase committed strokes of a page. Ids that aren't visible on it are
   * ignored. Erases with the same `group` (one eraser gesture) extend the
   * previous op, so the whole gesture is a single undo step. Null when the
   * page is unknown or nothing changed.
   */
  erase(pageId: string, ids: string[], group?: string): Change | null {
    const page = pageId === this.page.id ? this.page : this.store.page(pageId);
    if (!page) return null;
    const nbId = page.notebookId;
    const erased = this.store.tx(() => {
      const changed = this.store.setDeleted([...new Set(ids)], this.now(), pageId);
      if (!changed.length) return changed;
      const last = group ? this.store.lastOp(nbId) : null;
      if (last && !last.undone && last.kind === "erase" && last.payload.group === group && last.payload.pageId === pageId) {
        this.store.updateOpPayload(last.seq, { ...last.payload, ids: [...last.payload.ids, ...changed] });
      } else {
        this.store.pushOp(nbId, "erase", { pageId, ids: changed, ...(group ? { group } : {}) });
      }
      this.store.touchNotebook(nbId, this.now());
      return changed;
    });
    if (!erased.length) return null;
    if (pageId === this.page.id) for (const id of erased) this.strokes.delete(id);
    return { pageId, removed: { pageId, ids: erased }, restored: [] };
  }

  /** Erase every committed stroke on a page (one undo step). Null if the page is unknown. */
  clear(pageId: string): Change | null {
    if (pageId !== this.page.id && !this.store.page(pageId)) return null;
    const ids = pageId === this.page.id ? [...this.strokes.keys()] : this.store.pageStrokeIds(pageId);
    return this.erase(pageId, ids) ?? { pageId, removed: null, restored: [] };
  }

  /** Undo the current notebook's last step (which may be on another page of it). */
  undo(): Change | null {
    const op = this.store.lastDone(this.notebook.id);
    if (!op) return null;
    // Undoing an add hides its strokes; undoing an erase brings them back.
    return this.apply(op, op.kind === "add" ? "hide" : "show", true);
  }

  redo(): Change | null {
    const op = this.store.firstUndone(this.notebook.id);
    if (!op) return null;
    return this.apply(op, op.kind === "add" ? "show" : "hide", false);
  }

  private apply(op: Op, action: "hide" | "show", undone: boolean): Change {
    const { pageId, ids } = op.payload;
    return this.store.tx(() => {
      this.store.setUndone(op.seq, undone);
      this.store.touchNotebook(this.notebook.id, this.now());
      if (action === "hide") {
        const changed = this.store.setDeleted(ids, this.now());
        if (pageId === this.page.id) for (const id of changed) this.strokes.delete(id);
        return { pageId, removed: changed.length ? { pageId, ids: changed } : null, restored: [] };
      }
      const changed = this.store.setDeleted(ids, null);
      const restored = this.store.strokesById(changed);
      if (pageId === this.page.id) {
        for (const s of restored) this.strokes.set(s.id, s);
        this.sortStrokes();
      }
      return { pageId, removed: null, restored };
    });
  }

  /** Keep paint order = creation order after strokes come back. */
  private sortStrokes(): void {
    const sorted = [...this.strokes.values()].sort((a, b) => a.createdAt - b.createdAt);
    this.strokes.clear();
    for (const s of sorted) this.strokes.set(s.id, s);
  }
}

/** New height for an infinite page whose ink reaches too close to the bottom, else null. */
export function grownHeight(page: PageInfo, pts: ArrayLike<number>): number | null {
  if (page.kind !== "infinite") return null;
  let maxY = 0;
  for (let i = 1; i < pts.length; i += POINT_STRIDE) if (pts[i]! > maxY) maxY = pts[i]!;
  const needed = Math.min(INFINITE_MAX, Math.ceil((maxY + INFINITE_FREE) / INFINITE_STEP) * INFINITE_STEP);
  return needed > page.height ? needed : null;
}
