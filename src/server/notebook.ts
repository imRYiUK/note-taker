// Authoritative notebook state: strokes being drawn right now (memory only),
// committed strokes of the active page (SQLite, mirrored in memory) and the
// shared undo/redo history. Single notebook / page until M4.

import { POINT_STRIDE } from "../shared/ink.ts";
import {
  LIMITS,
  type HistoryState,
  type PageInfo,
  type StrokeBeginMsg,
  type StrokeData,
} from "../shared/protocol.ts";
import type { Op, Store } from "./store.ts";

interface LiveStroke {
  owner: string; // client id that is drawing it
  data: StrokeData;
}

export type BeginResult = "ok" | "duplicate" | "unknown_page";

export type EndResult =
  | { kind: "committed"; stroke: StrokeData }
  /** Already stored (a resend after reconnect). */
  | { kind: "duplicate" }
  /** Point count doesn't match what the pad sent: dropped, the pad must resend it. */
  | { kind: "resync"; missing: number };

/** What an erase / undo / redo did, for broadcasting. */
export interface Change {
  removed: { pageId: string; ids: string[] } | null;
  restored: StrokeData[];
}

export class Notebook {
  readonly id: string;
  readonly page: PageInfo;
  /** Visible committed strokes of the active page, in paint order. */
  private readonly strokes = new Map<string, StrokeData>();
  private readonly live = new Map<string, LiveStroke>();
  /** Stroke timestamps are strictly increasing, so they define paint order unambiguously. */
  private lastCreatedAt: number;

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    const { notebook, page } = store.openDefault(now());
    this.id = notebook.id;
    this.page = page;
    for (const s of store.pageStrokes(page.id)) this.strokes.set(s.id, s);
    this.lastCreatedAt = store.maxStrokeTime();
  }

  snapshot(): { page: PageInfo; strokes: StrokeData[] } {
    return { page: { ...this.page }, strokes: [...this.strokes.values()] };
  }

  history(): HistoryState {
    return { canUndo: this.store.lastDone(this.id) !== null, canRedo: this.store.firstUndone(this.id) !== null };
  }

  get strokeCount(): number {
    return this.strokes.size;
  }

  // ------------------------------------------------------------ live strokes

  begin(owner: string, msg: StrokeBeginMsg): BeginResult {
    if (msg.pageId !== this.page.id) return "unknown_page";
    // Same id again after a reconnect, but the first copy is already stored.
    if (this.store.hasStroke(msg.id)) return "duplicate";
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
    stroke.createdAt = this.lastCreatedAt = Math.max(this.now(), this.lastCreatedAt + 1);
    this.store.tx(() => {
      this.store.insertStroke(stroke);
      this.store.pushOp(this.id, "add", { pageId: stroke.pageId, ids: [stroke.id] });
      this.store.touchNotebook(this.id, this.now());
    });
    this.strokes.set(id, stroke);
    return { kind: "committed", stroke };
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
   * Erase committed strokes. Ids that aren't visible are ignored. Erases with
   * the same `group` (one eraser gesture) extend the previous op, so the whole
   * gesture is a single undo step. Null when the page is unknown or nothing changed.
   */
  erase(pageId: string, ids: string[], group?: string): Change | null {
    if (pageId !== this.page.id) return null;
    const visible = [...new Set(ids)].filter((id) => this.strokes.has(id));
    if (!visible.length) return null;
    this.store.tx(() => {
      this.store.setDeleted(visible, this.now());
      const last = group ? this.store.lastOp(this.id) : null;
      if (last && !last.undone && last.kind === "erase" && last.payload.group === group && last.payload.pageId === pageId) {
        this.store.updateOpPayload(last.seq, { ...last.payload, ids: [...last.payload.ids, ...visible] });
      } else {
        this.store.pushOp(this.id, "erase", { pageId, ids: visible, ...(group ? { group } : {}) });
      }
      this.store.touchNotebook(this.id, this.now());
    });
    for (const id of visible) this.strokes.delete(id);
    return { removed: { pageId, ids: visible }, restored: [] };
  }

  /** Erase every committed stroke on the page (one undo step). */
  clear(pageId: string): Change | null {
    if (pageId !== this.page.id) return null;
    return this.erase(pageId, [...this.strokes.keys()]) ?? { removed: null, restored: [] };
  }

  undo(): Change | null {
    const op = this.store.lastDone(this.id);
    if (!op) return null;
    // Undoing an add hides its strokes; undoing an erase brings them back.
    return this.apply(op, op.kind === "add" ? "hide" : "show", true);
  }

  redo(): Change | null {
    const op = this.store.firstUndone(this.id);
    if (!op) return null;
    return this.apply(op, op.kind === "add" ? "show" : "hide", false);
  }

  private apply(op: Op, action: "hide" | "show", undone: boolean): Change {
    const { pageId, ids } = op.payload;
    return this.store.tx(() => {
      this.store.setUndone(op.seq, undone);
      this.store.touchNotebook(this.id, this.now());
      if (action === "hide") {
        const changed = this.store.setDeleted(ids, this.now());
        if (pageId === this.page.id) for (const id of changed) this.strokes.delete(id);
        return { removed: changed.length ? { pageId, ids: changed } : null, restored: [] };
      }
      const changed = this.store.setDeleted(ids, null);
      const restored = this.store.strokesById(changed);
      if (pageId === this.page.id) {
        for (const s of restored) this.strokes.set(s.id, s);
        this.sortStrokes();
      }
      return { removed: null, restored };
    });
  }

  /** Keep paint order = creation order after strokes come back. */
  private sortStrokes(): void {
    const sorted = [...this.strokes.values()].sort((a, b) => a.createdAt - b.createdAt);
    this.strokes.clear();
    for (const s of sorted) this.strokes.set(s.id, s);
  }
}
