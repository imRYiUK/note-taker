// Pad rendering: the whole page letterboxed onto the screen (tablet mapping).
// Two layers: an offscreen bitmap of committed strokes, and the live stroke,
// which is redrawn every frame inside a dirty rectangle on a low-latency
// (desynchronized) canvas.

import {
  DEFAULT_INK,
  strokeOutline,
  traceOutline,
  outlineBounds,
  unionRect,
  type InkSettings,
  type Rect,
} from "../shared/ink.ts";
import { hitsStroke, pointsBounds } from "../shared/hit.ts";
import type { PageInfo, StrokeData } from "../shared/protocol.ts";

const MARGIN = 10; // CSS px around the page
const SURROUND = "#121214";
const PAPER = "#ffffff";

export interface LiveInk {
  pts: number[];
  /** Predicted points: drawn now, never stored. */
  tail: number[];
  color: string;
  width: number;
}

export class PadCanvas {
  readonly el: HTMLCanvasElement;
  readonly desynchronized: boolean;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly committed = document.createElement("canvas");
  private readonly cctx = this.committed.getContext("2d", { alpha: false })!;

  page: PageInfo | null = null;
  private ink: InkSettings = DEFAULT_INK;
  private strokes: StrokeData[] = [];
  private readonly paths = new Map<string, { path: Path2D; bounds: Rect | null }>();
  /** Centerline bounds for hit-testing (independent of ink settings). */
  private readonly centerBounds = new Map<string, Rect | null>();

  // Layout: page unit → CSS px is `x * scale + ox`.
  private dpr = 1;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private liveRect: Rect | null = null; // device px, last frame

  constructor(el: HTMLCanvasElement) {
    this.el = el;
    this.ctx = el.getContext("2d", { desynchronized: true, alpha: false })!;
    const attrs = this.ctx.getContextAttributes?.() as { desynchronized?: boolean } | undefined;
    this.desynchronized = Boolean(attrs?.desynchronized);
  }

  // ------------------------------------------------------------ state

  setPage(page: PageInfo, strokes: StrokeData[]): void {
    const pageChanged = page.width !== this.page?.width || page.height !== this.page?.height;
    this.page = page;
    this.strokes = strokes;
    this.paths.clear();
    this.centerBounds.clear();
    if (pageChanged) this.resize();
    else this.redrawAll();
  }

  addStroke(s: StrokeData): void {
    this.strokes.push(s);
    const { path, bounds } = this.path(s);
    this.paintStroke(this.cctx, s, path);
    this.blit(unionRect(this.deviceRect(bounds), this.liveRect));
    this.liveRect = null;
  }

  /** Remove strokes (erased / undone); returns true if any were on screen. */
  removeStrokes(ids: Iterable<string>): boolean {
    const gone = new Set(ids);
    const before = this.strokes.length;
    this.strokes = this.strokes.filter((s) => !gone.has(s.id));
    if (this.strokes.length === before) return false;
    for (const id of gone) {
      this.paths.delete(id);
      this.centerBounds.delete(id);
    }
    this.redrawAll();
    return true;
  }

  /** Bring strokes back (undo of an erase / redo), keeping creation order. */
  restoreStrokes(strokes: StrokeData[]): void {
    const have = new Set(this.strokes.map((s) => s.id));
    const add = strokes.filter((s) => s.pageId === this.page?.id && !have.has(s.id));
    if (!add.length) return;
    this.strokes = [...this.strokes, ...add].sort((a, b) => a.createdAt - b.createdAt);
    this.redrawAll();
  }

  /** Ids of strokes touched by an eraser moving a→b (page units) with radius r. */
  hitTest(ax: number, ay: number, bx: number, by: number, r: number): string[] {
    const hits: string[] = [];
    for (const s of this.strokes) {
      let bounds = this.centerBounds.get(s.id);
      if (bounds === undefined) {
        bounds = pointsBounds(s.pts);
        this.centerBounds.set(s.id, bounds);
      }
      if (hitsStroke({ pts: s.pts, width: s.width, bounds }, ax, ay, bx, by, r)) hits.push(s.id);
    }
    return hits;
  }

  setInk(ink: InkSettings): void {
    this.ink = ink;
    this.paths.clear();
    this.redrawAll();
  }

  // ------------------------------------------------------------ geometry

  resize(): void {
    this.dpr = devicePixelRatio || 1;
    const w = innerWidth;
    const h = innerHeight;
    for (const c of [this.el, this.committed]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
    }
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    if (this.page) {
      this.scale = Math.min((w - 2 * MARGIN) / this.page.width, (h - 2 * MARGIN) / this.page.height);
      this.ox = (w - this.page.width * this.scale) / 2;
      this.oy = (h - this.page.height * this.scale) / 2;
    }
    this.redrawAll();
  }

  /** Client (CSS px) → page units. */
  toPage(clientX: number, clientY: number): [number, number] {
    return [(clientX - this.ox) / this.scale, (clientY - this.oy) / this.scale];
  }

  /** CSS px → page units at the current zoom. */
  pxToPage(px: number): number {
    return px / this.scale;
  }

  inPage(x: number, y: number): boolean {
    return !!this.page && x >= 0 && y >= 0 && x <= this.page.width && y <= this.page.height;
  }

  // ------------------------------------------------------------ drawing

  /** Draw the in-progress stroke (call once per animation frame). */
  drawLive(live: LiveInk | null): void {
    if (!live || !live.pts.length) {
      this.blit(this.liveRect);
      this.liveRect = null;
      return;
    }
    const outline = strokeOutline(live.pts, live.width, this.ink, false, live.tail);
    const rect = this.deviceRect(outlineBounds(outline));
    this.blit(unionRect(rect, this.liveRect));
    this.liveRect = rect;

    const path = new Path2D();
    traceOutline(path, outline);
    this.ctx.save();
    this.clipToPage(this.ctx);
    this.ctx.fillStyle = live.color;
    this.ctx.fill(path);
    this.ctx.restore();
  }

  /** Eraser ring at (x, y) page units, radius r; null hides it. Uses the live layer. */
  drawEraser(at: { x: number; y: number; r: number } | null): void {
    if (!at) {
      this.drawLive(null);
      return;
    }
    const rect = this.deviceRect({ x: at.x - at.r, y: at.y - at.r, w: 2 * at.r, h: 2 * at.r });
    this.blit(unionRect(rect, this.liveRect));
    this.liveRect = rect;
    const c = this.ctx;
    c.save();
    this.setPageTransform(c);
    c.beginPath();
    c.arc(at.x, at.y, at.r, 0, Math.PI * 2);
    c.fillStyle = "rgba(210, 65, 58, 0.12)";
    c.fill();
    c.lineWidth = 1.5 / this.scale;
    c.strokeStyle = "rgba(210, 65, 58, 0.85)";
    c.stroke();
    c.restore();
  }

  private redrawAll(): void {
    const c = this.cctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = SURROUND;
    c.fillRect(0, 0, this.committed.width, this.committed.height);
    if (this.page) {
      this.setPageTransform(c);
      c.fillStyle = PAPER;
      c.fillRect(0, 0, this.page.width, this.page.height);
      for (const s of this.strokes) this.paintStroke(c, s, this.path(s).path);
    }
    this.liveRect = null;
    this.blit({ x: 0, y: 0, w: this.el.width, h: this.el.height });
  }

  private paintStroke(c: CanvasRenderingContext2D, s: StrokeData, path: Path2D): void {
    c.save();
    this.clipToPage(c);
    c.fillStyle = s.color;
    c.fill(path);
    c.restore();
  }

  private path(s: StrokeData): { path: Path2D; bounds: Rect | null } {
    let p = this.paths.get(s.id);
    if (!p) {
      const outline = strokeOutline(s.pts, s.width, this.ink, true);
      const path = new Path2D();
      traceOutline(path, outline);
      p = { path, bounds: outlineBounds(outline) };
      this.paths.set(s.id, p);
    }
    return p;
  }

  private setPageTransform(c: CanvasRenderingContext2D): void {
    const k = this.scale * this.dpr;
    c.setTransform(k, 0, 0, k, this.ox * this.dpr, this.oy * this.dpr);
  }

  private clipToPage(c: CanvasRenderingContext2D): void {
    this.setPageTransform(c);
    if (!this.page) return;
    c.beginPath();
    c.rect(0, 0, this.page.width, this.page.height);
    c.clip();
  }

  /** Page-unit rect → padded, integer device-pixel rect. */
  private deviceRect(r: Rect | null): Rect | null {
    if (!r) return null;
    const k = this.scale * this.dpr;
    const x = Math.floor((r.x * this.scale + this.ox) * this.dpr) - 2;
    const y = Math.floor((r.y * this.scale + this.oy) * this.dpr) - 2;
    return { x, y, w: Math.ceil(r.w * k) + 5, h: Math.ceil(r.h * k) + 5 };
  }

  /** Copy a device-pixel region of the committed layer to the screen. */
  private blit(r: Rect | null): void {
    if (!r) return;
    const x = Math.max(0, r.x);
    const y = Math.max(0, r.y);
    const w = Math.min(this.el.width, r.x + r.w) - x;
    const h = Math.min(this.el.height, r.y + r.h) - y;
    if (w <= 0 || h <= 0) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.committed, x, y, w, h, x, y, w, h);
  }
}
