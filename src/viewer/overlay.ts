// The pad's zoom strip drawn on the PC page: a rectangle you can drag to move
// the strip; double-click the page to put the strip there (snapped to the line).

import type { Rect } from "../shared/ink.ts";
import type { HoverPoint } from "../shared/protocol.ts";
import { LINED, lineCount } from "../shared/templates.ts";
import type { PageView } from "./renderer.ts";

export class StripOverlay {
  private readonly el = document.createElement("div");
  private rect: Rect | null = null;
  private drag: { pointerId: number; sx: number; sy: number; start: Rect } | null = null;
  private frame = 0;
  private lastSet = 0;

  constructor(
    private readonly view: PageView,
    /** The user moved the strip here (at most once per frame). */
    private readonly onMove: (rect: Rect) => void,
  ) {
    this.el.className = "strip";
    this.el.hidden = true;
    this.el.title = "Pad strip — drag to move (double-click the page to jump)";
    view.wrap.append(this.el);
    view.layoutHooks.push(() => this.place());

    this.el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.rect) return;
      e.preventDefault();
      this.el.setPointerCapture(e.pointerId);
      this.drag = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, start: { ...this.rect } };
      this.el.classList.add("dragging");
    });
    this.el.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      const k = this.view.pxPerUnit;
      this.moveTo(d.start.x + (e.clientX - d.sx) / k, d.start.y + (e.clientY - d.sy) / k);
    });
    const end = (e: PointerEvent) => {
      if (this.drag?.pointerId !== e.pointerId) return;
      this.drag = null;
      this.el.classList.remove("dragging");
    };
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", end);

    view.wrap.addEventListener("dblclick", (e) => {
      if (!this.rect || e.target === this.el) return;
      const box = view.wrap.getBoundingClientRect();
      const k = this.view.pxPerUnit;
      const px = (e.clientX - box.left) / k;
      const py = (e.clientY - box.top) / k;
      const page = view.page;
      if (!page) return;
      // Start writing at the click: it lands near the strip's left edge, centred on its line.
      const line = Math.max(0, Math.min(lineCount(page) - 1, Math.floor((py - LINED.top) / LINED.lineHeight)));
      const y = LINED.top + (line + 0.5) * LINED.lineHeight - this.rect.h / 2;
      this.moveTo(px - this.rect.w * 0.1, y);
    });
  }

  /** Show the strip at `rect` (null hides it, e.g. tablet mode). */
  set(rect: Rect | null): void {
    if (this.drag) return; // the local drag wins until it ends
    // Animate isolated jumps (auto-advance); follow a stream (pad pinch / pan) directly.
    const now = performance.now();
    this.el.classList.toggle("streaming", now - this.lastSet < 150);
    this.lastSet = now;
    this.rect = rect && { ...rect };
    this.place();
    if (rect) this.view.reveal(rect);
  }

  private moveTo(x: number, y: number): void {
    const page = this.view.page;
    if (!this.rect || !page) return;
    const r = this.rect;
    r.x = Math.min(Math.max(0, page.width - r.w), Math.max(0, x));
    r.y = Math.min(Math.max(0, page.height - r.h), Math.max(0, y));
    this.place();
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (this.rect) this.onMove({ ...this.rect });
      });
    }
  }

  private place(): void {
    const r = this.rect;
    this.el.hidden = !r;
    if (!r) return;
    const k = this.view.pxPerUnit;
    Object.assign(this.el.style, {
      left: `${r.x * k}px`,
      top: `${r.y * k}px`,
      width: `${r.w * k}px`,
      height: `${r.h * k}px`,
    });
  }
}

// ------------------------------------------------------------------ pen cursor

/** No hover update for this long: hide the cursor (a lost "leave"). */
const CURSOR_TIMEOUT_MS = 3000;

/**
 * Where the pen hovers over the phone, shown on the PC page (M5): a dot in the
 * ink colour sized like the stroke it would draw, or the eraser's ring. Lets
 * you keep your eyes on the monitor (tablet mode, blank pad).
 */
export class PenCursor {
  private readonly el = document.createElement("div");
  private at: HoverPoint | null = null;
  private from: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastReveal = 0;

  constructor(private readonly view: PageView) {
    this.el.className = "pen-cursor";
    this.el.hidden = true;
    view.wrap.append(this.el);
    view.layoutHooks.push(() => this.place());
  }

  /** A pad's hover update. */
  set(from: string, at: HoverPoint | null): void {
    // Another pad leaving doesn't hide this one's cursor.
    if (!at && this.from !== null && from !== this.from) return;
    this.from = at ? from : null;
    this.at = at && this.view.page?.id === at.pageId ? at : null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = this.at ? setTimeout(() => this.hide(), CURSOR_TIMEOUT_MS) : null;
    this.place();
    // Following a hovering pen: scroll at most a few times per second.
    const now = performance.now();
    if (this.at && now - this.lastReveal > 250) {
      this.lastReveal = now;
      this.view.reveal({ y: this.at.y - 40, h: 80 });
    }
  }

  hide(): void {
    this.at = null;
    this.from = null;
    this.place();
  }

  private place(): void {
    const a = this.at;
    const page = this.view.page;
    const inside = a && page && a.x >= -50 && a.y >= -50 && a.x <= page.width + 50 && a.y <= page.height + 50;
    this.el.hidden = !inside;
    if (!inside) return;
    const k = this.view.pxPerUnit;
    const eraser = a.tool === "eraser";
    // Pen: a dot about as wide as its ink (never tiny); highlighter: its width; eraser: a ring.
    const size = eraser ? 18 : Math.max(a.tool === "highlighter" ? 8 : 7, (a.width ?? 10) * k);
    this.el.className = `pen-cursor ${a.tool}`;
    Object.assign(this.el.style, {
      left: `${a.x * k}px`,
      top: `${a.y * k}px`,
      width: `${size}px`,
      height: `${size}px`,
      color: a.color,
    });
  }
}
