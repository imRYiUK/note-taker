// Viewer page rendering: one page canvas with committed strokes (re-rasterized
// only on resize / snapshot / settings change; new strokes are painted
// incrementally) and a transparent live canvas on top for strokes still being
// written, redrawn per animation frame inside a dirty rectangle.

import {
  DEFAULT_INK,
  POINT_STRIDE,
  maxPressure,
  outlineBounds,
  strokeOutline,
  traceOutline,
  unionRect,
  type InkSettings,
  type Rect,
} from "../shared/ink.ts";
import type { PageInfo, StrokeBeginMsg, StrokeData } from "../shared/protocol.ts";

export type FitMode = "width" | "page";

const STAGE_PAD = 24; // CSS px around the page
const PAPER = "#ffffff";

interface Live {
  id: string;
  color: string;
  width: number;
  pts: number[];
}

export class PageView {
  readonly wrap: HTMLDivElement;
  private readonly base = document.createElement("canvas");
  private readonly liveCanvas = document.createElement("canvas");
  private readonly bctx = this.base.getContext("2d", { alpha: false })!;
  private readonly lctx = this.liveCanvas.getContext("2d")!;

  page: PageInfo | null = null;
  fit: FitMode = "width";
  follow = true;
  private ink: InkSettings = DEFAULT_INK;
  private readonly strokes = new Map<string, StrokeData>();
  private readonly paths = new Map<string, Path2D>();
  private readonly live = new Map<string, Live>();
  private liveRect: Rect | null = null; // device px drawn last frame
  private lastLiveId: string | null = null;

  private scale = 1; // CSS px per page unit
  private dpr = 1;
  private frame = 0;

  /** Raw max pressure of recently committed strokes, newest last. */
  readonly recentPressure: number[] = [];

  constructor(private readonly stage: HTMLElement) {
    this.wrap = document.createElement("div");
    this.wrap.className = "page";
    this.liveCanvas.className = "live";
    this.wrap.append(this.base, this.liveCanvas);
    stage.append(this.wrap);
    new ResizeObserver(() => this.layout()).observe(stage);
  }

  // ------------------------------------------------------------ state

  setSnapshot(page: PageInfo, strokes: StrokeData[]): void {
    const sizeChanged = page.width !== this.page?.width || page.height !== this.page?.height;
    this.page = page;
    this.strokes.clear();
    this.paths.clear();
    for (const s of strokes) this.strokes.set(s.id, s);
    this.recentPressure.length = 0;
    for (const s of strokes.slice(-30)) this.notePressure(s.pts);
    if (sizeChanged) this.layout();
    else this.redrawBase();
  }

  addStroke(s: StrokeData): void {
    this.live.delete(s.id);
    this.strokes.set(s.id, s);
    this.paintStroke(s);
    this.notePressure(s.pts);
    this.scheduleLive();
  }

  removeStrokes(ids: string[]): void {
    let changed = false;
    for (const id of ids) {
      changed = this.strokes.delete(id) || changed;
      this.paths.delete(id);
    }
    if (changed) this.redrawBase();
  }

  /** Strokes back from undo / redo, re-sorted into creation (= paint) order. */
  restoreStrokes(strokes: StrokeData[]): void {
    const add = strokes.filter((s) => s.pageId === this.page?.id);
    if (!add.length) return;
    const all = [...this.strokes.values(), ...add].sort((a, b) => a.createdAt - b.createdAt);
    this.strokes.clear();
    for (const s of all) this.strokes.set(s.id, s);
    this.redrawBase();
  }

  setInk(ink: InkSettings): void {
    this.ink = ink;
    this.paths.clear();
    this.redrawBase();
    this.scheduleLive();
  }

  setFit(fit: FitMode): void {
    this.fit = fit;
    this.layout();
  }

  get strokeCount(): number {
    return this.strokes.size;
  }

  // ------------------------------------------------------------ live strokes

  liveBegin(m: StrokeBeginMsg): void {
    this.live.set(m.id, { id: m.id, color: m.color, width: m.width, pts: [] });
  }

  livePoints(id: string, pts: number[]): void {
    const l = this.live.get(id);
    if (!l) return; // joined mid-stroke — it arrives complete with stroke.added
    for (const v of pts) l.pts.push(v);
    this.lastLiveId = id;
    this.scheduleLive();
  }

  liveCancel(id: string): void {
    if (this.live.delete(id)) this.scheduleLive();
  }

  private scheduleLive(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.drawLive();
    });
  }

  private drawLive(): void {
    const c = this.lctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (this.liveRect) {
      const r = this.liveRect;
      c.clearRect(r.x, r.y, r.w, r.h);
    }
    let rect: Rect | null = null;
    const k = this.scale * this.dpr;
    c.setTransform(k, 0, 0, k, 0, 0);
    for (const l of this.live.values()) {
      if (!l.pts.length) continue;
      const outline = strokeOutline(l.pts, l.width, this.ink, false);
      rect = unionRect(rect, outlineBounds(outline));
      const path = new Path2D();
      traceOutline(path, outline);
      c.fillStyle = l.color;
      c.fill(path);
    }
    this.liveRect = rect && {
      x: Math.floor(rect.x * k) - 2,
      y: Math.floor(rect.y * k) - 2,
      w: Math.ceil(rect.w * k) + 5,
      h: Math.ceil(rect.h * k) + 5,
    };
    this.followPen();
  }

  /** Keep the newest live point on screen (vertical scroll only). */
  private followPen(): void {
    if (!this.follow || !this.lastLiveId) return;
    const pts = this.live.get(this.lastLiveId)?.pts;
    if (!pts || pts.length < POINT_STRIDE) return;
    const y = this.wrap.offsetTop + pts[pts.length - 3]! * this.scale;
    const top = this.stage.scrollTop;
    const h = this.stage.clientHeight;
    const margin = h * 0.12;
    if (y < top + margin || y > top + h - margin) {
      this.stage.scrollTo({ top: y - h / 2, behavior: "smooth" });
    }
  }

  // ------------------------------------------------------------ committed layer

  private layout(): void {
    if (!this.page) return;
    const availW = Math.max(100, this.stage.clientWidth - 2 * STAGE_PAD);
    const availH = Math.max(100, this.stage.clientHeight - 2 * STAGE_PAD);
    const byWidth = availW / this.page.width;
    this.scale = this.fit === "width" ? byWidth : Math.min(byWidth, availH / this.page.height);
    this.dpr = devicePixelRatio || 1;

    const cssW = Math.round(this.page.width * this.scale);
    const cssH = Math.round(this.page.height * this.scale);
    this.wrap.style.width = `${cssW}px`;
    this.wrap.style.height = `${cssH}px`;
    for (const c of [this.base, this.liveCanvas]) {
      c.width = Math.round(cssW * this.dpr);
      c.height = Math.round(cssH * this.dpr);
    }
    this.liveRect = null;
    this.redrawBase();
    this.scheduleLive();
  }

  private redrawBase(): void {
    if (!this.page) return;
    const c = this.bctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = PAPER;
    c.fillRect(0, 0, this.base.width, this.base.height);
    for (const s of this.strokes.values()) this.paintStroke(s);
  }

  private paintStroke(s: StrokeData): void {
    let path = this.paths.get(s.id);
    if (!path) {
      path = new Path2D();
      traceOutline(path, strokeOutline(s.pts, s.width, this.ink, true));
      this.paths.set(s.id, path);
    }
    const k = this.scale * this.dpr;
    this.bctx.setTransform(k, 0, 0, k, 0, 0);
    this.bctx.fillStyle = s.color;
    this.bctx.fill(path);
  }

  private notePressure(pts: number[]): void {
    this.recentPressure.push(maxPressure(pts));
    if (this.recentPressure.length > 30) this.recentPressure.shift();
  }
}
