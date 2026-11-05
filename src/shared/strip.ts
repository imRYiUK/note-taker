// Zoom-strip state machine (PLAN.md §5 "Modes"). The phone shows a small,
// magnified window (`rect`, page units) of the page; when you lift the pen near
// the right edge it moves on by itself, and at the end of a line it wraps to
// the start of the next one.
//
// Pure: no DOM, no timers. The caller passes timestamps in and runs a timer
// for `dueAt`; `tick` performs the shift once it is due.

import type { Rect } from "./ink.ts";
import { LINED, lineCount, type Ruling } from "./templates.ts";

export interface StripOptions {
  /** Right fraction of the strip where a pen-up arms the auto-advance. */
  advanceZone: number;
  /** Pen-up → shift delay, ms. Any pen-down before then cancels it. */
  advanceDelayMs: number;
  /** Shift distance as a fraction of the strip width. */
  advanceStep: number;
  /** How much page is shown left of the margin line after a wrap, page units. */
  wrapLead: number;
}

export const STRIP_DEFAULTS: StripOptions = {
  advanceZone: 0.2,
  advanceDelayMs: 350,
  advanceStep: 0.6,
  wrapLead: 40,
};

/** Strip zoom = CSS px per page unit. 1.6 ≈ 3× real size on an S23 Ultra (1 CSS px ≈ 0.19 mm). */
export const ZOOM_LIMITS = [0.4, 6] as const;

const EPS = 0.5;

export class Strip {
  /** Current window onto the page, page units. */
  rect: Rect;
  /** When the pending auto-advance fires (caller's clock), or null. */
  dueAt: number | null = null;
  readonly opts: StripOptions;

  constructor(
    readonly page: { width: number; height: number },
    size: { w: number; h: number },
    opts: Partial<StripOptions> = {},
    readonly ruling: Ruling = LINED,
  ) {
    this.opts = { ...STRIP_DEFAULTS, ...opts };
    this.rect = { x: 0, y: 0, ...size };
    this.goToLine(0, this.startX);
  }

  // ------------------------------------------------------------ lines

  /** Top of writing line k (the rule above it). */
  lineTop(k: number): number {
    return this.ruling.top + k * this.ruling.lineHeight;
  }

  /** Writing line whose band contains page y (clamped to the page's lines). */
  lineAt(y: number): number {
    const k = Math.floor((y - this.ruling.top) / this.ruling.lineHeight);
    return Math.max(0, Math.min(lineCount(this.page, this.ruling) - 1, k));
  }

  /** The line the strip is centred on. */
  get line(): number {
    return this.lineAt(this.rect.y + this.rect.h / 2);
  }

  /** x the strip starts at after a wrap: just left of the margin line. */
  get startX(): number {
    return this.clampX(this.ruling.marginLeft - this.opts.wrapLead);
  }

  // ------------------------------------------------------------ pen events

  /** Pen touched down: you're still writing, so a pending shift is cancelled. */
  penDown(): void {
    this.dueAt = null;
  }

  /** Pen lifted at page x. Arms the auto-advance when it's in the advance zone. */
  penUp(x: number, now: number): void {
    const zoneStart = this.rect.x + this.rect.w * (1 - this.opts.advanceZone);
    this.dueAt = x >= zoneStart ? now + this.opts.advanceDelayMs : null;
  }

  /** Perform the pending shift if it's due. Returns the new rect when the strip moved. */
  tick(now: number): Rect | null {
    if (this.dueAt === null || now < this.dueAt) return null;
    this.dueAt = null;
    return this.advance();
  }

  // ------------------------------------------------------------ moves (all return the new rect)

  /** Move right by one step; at the right edge of the page wrap to the next line. */
  advance(): Rect {
    const maxX = this.maxX;
    if (this.rect.x >= maxX - EPS) return this.newLine();
    return this.set(Math.min(maxX, this.rect.x + this.rect.w * this.opts.advanceStep), this.rect.y);
  }

  /** Start of the next line (stays on the last line of the page). */
  newLine(): Rect {
    this.dueAt = null;
    this.goToLine(Math.min(lineCount(this.page, this.ruling) - 1, this.line + 1), this.startX);
    return this.rect;
  }

  /** One step back; from the start of a line go to the end of the previous one. */
  back(): Rect {
    this.dueAt = null;
    if (this.rect.x <= this.startX + EPS && this.line > 0) {
      this.goToLine(this.line - 1, this.maxX);
      return this.rect;
    }
    return this.set(Math.max(0, this.rect.x - this.rect.w * this.opts.advanceStep), this.rect.y);
  }

  /** Centre the strip vertically on line k, optionally at a given x. */
  goToLine(k: number, x = this.rect.x): Rect {
    const lh = this.ruling.lineHeight;
    return this.set(x, this.lineTop(k) + lh / 2 - this.rect.h / 2);
  }

  /** Free move (finger pan, viewer drag, restored position). */
  moveTo(x: number, y: number): Rect {
    this.dueAt = null;
    return this.set(x, y);
  }

  panBy(dx: number, dy: number): Rect {
    return this.moveTo(this.rect.x + dx, this.rect.y + dy);
  }

  /**
   * New strip size (zoom / screen rotation). The page point `anchor` stays at the
   * same place on screen; by default the strip's centre.
   */
  resize(w: number, h: number, anchor?: { x: number; y: number }): Rect {
    const r = this.rect;
    const a = anchor ?? { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    const fx = r.w ? (a.x - r.x) / r.w : 0.5;
    const fy = r.h ? (a.y - r.y) / r.h : 0.5;
    this.rect = { ...r, w, h };
    return this.set(a.x - fx * w, a.y - fy * h);
  }

  // ------------------------------------------------------------ helpers

  /** Rightmost x the strip can have (flush with the page's right edge). */
  private get maxX(): number {
    return this.clampX(Infinity);
  }

  private clampX(x: number): number {
    if (this.rect.w >= this.page.width) return (this.page.width - this.rect.w) / 2;
    return Math.min(this.page.width - this.rect.w, Math.max(0, x));
  }

  private clampY(y: number): number {
    if (this.rect.h >= this.page.height) return (this.page.height - this.rect.h) / 2;
    return Math.min(this.page.height - this.rect.h, Math.max(0, y));
  }

  private set(x: number, y: number): Rect {
    this.rect = { x: this.clampX(x), y: this.clampY(y), w: this.rect.w, h: this.rect.h };
    return this.rect;
  }
}

/** Ease-out interpolation between two rects (for the 120 ms shift animation). */
export function lerpRect(a: Rect, b: Rect, t: number): Rect {
  const k = 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k };
}
