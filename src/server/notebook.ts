// Authoritative in-memory page state: committed strokes plus strokes being
// drawn right now. M1 holds a single A4 page in memory; persistence (SQLite),
// multiple pages and the undo stack arrive in M2/M4.

import { A4, POINT_STRIDE } from "../shared/ink.ts";
import { LIMITS, type PageInfo, type StrokeBeginMsg, type StrokeData } from "../shared/protocol.ts";

interface LiveStroke {
  owner: string; // client id that is drawing it
  data: StrokeData;
}

export type BeginResult = "ok" | "duplicate" | "unknown_page";

export interface EndResult {
  stroke: StrokeData;
  /** Points the pad says it sent minus points we received (0 = complete). */
  missing: number;
}

export class Notebook {
  readonly page: PageInfo = { id: "page-1", width: A4.width, height: A4.height };
  private readonly strokes = new Map<string, StrokeData>();
  private readonly live = new Map<string, LiveStroke>();

  constructor(private readonly now: () => number = Date.now) {}

  snapshot(): { page: PageInfo; strokes: StrokeData[] } {
    return { page: { ...this.page }, strokes: [...this.strokes.values()] };
  }

  begin(owner: string, msg: StrokeBeginMsg): BeginResult {
    if (msg.pageId !== this.page.id) return "unknown_page";
    // Same id again (e.g. a resend after reconnect) — the stroke is known already.
    if (this.strokes.has(msg.id)) return "duplicate";
    const existing = this.live.get(msg.id);
    if (existing && existing.owner !== owner) return "duplicate";
    this.live.set(msg.id, {
      owner,
      data: {
        id: msg.id,
        pageId: msg.pageId,
        tool: msg.tool,
        color: msg.color,
        width: msg.width,
        pts: [],
        createdAt: this.now(),
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

  /** Commit a live stroke. Null if unknown / not ours / empty. */
  end(owner: string, id: string, n: number): EndResult | null {
    const s = this.live.get(id);
    if (!s || s.owner !== owner) return null;
    this.live.delete(id);
    const received = s.data.pts.length / POINT_STRIDE;
    if (received === 0) return null;
    this.strokes.set(id, s.data);
    return { stroke: s.data, missing: n - received };
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

  /** Remove committed strokes. Strokes being drawn right now survive and commit normally. */
  clear(pageId: string): boolean {
    if (pageId !== this.page.id) return false;
    this.strokes.clear();
    return true;
  }

  get strokeCount(): number {
    return this.strokes.size;
  }
}
