// Page backgrounds (chosen per notebook): blank / lined / grid / dotted.
// Every template shares the same writing-line geometry (`LINED`): the zoom
// strip snaps to it, and the grid and dots are aligned with it (two cells per
// line, starting at the margin), so switching templates never moves the strip.

import type { PageInfo, Template } from "./protocol.ts";
import type { Rect } from "./ink.ts";

/** Ruled-paper geometry in page units (0.1 mm). */
export interface Ruling {
  /** Distance between rules (8 mm ≈ wide-ruled). */
  lineHeight: number;
  /** y of the first rule. */
  top: number;
  /** Space kept free below the last rule. */
  bottom: number;
  /** x of the vertical margin line; writing starts right of it. */
  marginLeft: number;
}

export const LINED: Ruling = { lineHeight: 80, top: 300, bottom: 150, marginLeft: 250 };

/** Grid / dot spacing: half a writing line (4 mm). */
export const GRID_STEP = LINED.lineHeight / 2;

export const TEMPLATE_LABELS: Record<Template, string> = {
  lined: "Lined",
  grid: "Grid",
  dotted: "Dotted",
  blank: "Blank",
};

/** Number of writing lines on a page (line k lies between rule k and rule k+1). */
export function lineCount(page: Pick<PageInfo, "height">, r: Ruling = LINED): number {
  return Math.max(1, Math.floor((page.height - r.top - r.bottom) / r.lineHeight));
}

const RULE = "#c9d5e8";
const MARGIN = "#efb4b4";
const GRID = "#dbe3ef";
const DOT = "#aab6c8";

/** Grid / dot positions along one axis, aligned to `origin`, inside [lo, hi]. */
function steps(origin: number, lo: number, hi: number, step = GRID_STEP): number[] {
  const out: number[] = [];
  for (let v = origin + Math.ceil((lo - origin) / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

type Size = Pick<PageInfo, "width" | "height">;

/**
 * Draw the page background (not the paper colour). `c` must already map page
 * units to the canvas; `pxPerUnit` is device px per page unit (keeps hairlines
 * ~1 device px). Only what lies inside `visible` (page units) is drawn.
 */
export function drawTemplate(
  c: CanvasRenderingContext2D,
  template: Template,
  page: Size,
  pxPerUnit: number,
  visible: Rect = { x: 0, y: 0, w: page.width, h: page.height },
): void {
  const hair = Math.max(1, Math.min(2.5, pxPerUnit * 1.5)) / pxPerUnit;
  const x0 = Math.max(0, visible.x - hair);
  const x1 = Math.min(page.width, visible.x + visible.w + hair);
  const y0 = Math.max(0, visible.y - hair);
  const y1 = Math.min(page.height, visible.y + visible.h + hair);
  c.save();
  switch (template) {
    case "lined": {
      const n = lineCount(page);
      c.lineWidth = hair;
      c.strokeStyle = RULE;
      c.beginPath();
      for (let k = 0; k <= n; k++) {
        const y = LINED.top + k * LINED.lineHeight;
        if (y < y0 || y > y1) continue;
        c.moveTo(0, y);
        c.lineTo(page.width, y);
      }
      c.stroke();
      if (LINED.marginLeft >= x0 && LINED.marginLeft <= x1) {
        c.strokeStyle = MARGIN;
        c.beginPath();
        c.moveTo(LINED.marginLeft, 0);
        c.lineTo(LINED.marginLeft, page.height);
        c.stroke();
      }
      break;
    }
    case "grid": {
      c.lineWidth = hair;
      c.strokeStyle = GRID;
      c.beginPath();
      for (const y of steps(LINED.top, y0, y1)) {
        c.moveTo(x0, y);
        c.lineTo(x1, y);
      }
      for (const x of steps(LINED.marginLeft, x0, x1)) {
        c.moveTo(x, y0);
        c.lineTo(x, y1);
      }
      c.stroke();
      break;
    }
    case "dotted": {
      // Dots stay visible (≥ ~1.3 device px) when zoomed out, and ~0.4 mm when zoomed in.
      const r = Math.max(4, 1.3 / pxPerUnit) / 2;
      c.fillStyle = DOT;
      c.beginPath();
      const xs = steps(LINED.marginLeft, x0 - r, x1 + r);
      for (const y of steps(LINED.top, y0 - r, y1 + r)) {
        for (const x of xs) {
          c.moveTo(x + r, y);
          c.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      c.fill();
      break;
    }
    case "blank":
      break;
  }
  c.restore();
}

/** The same background as SVG elements (for thumbnails and export). `hair` = line width, page units. */
export function templateSvg(template: Template, page: Size, hair = 2): string {
  const W = page.width;
  const H = page.height;
  switch (template) {
    case "lined": {
      const n = lineCount(page);
      let d = "";
      for (let k = 0; k <= n; k++) d += `M0 ${LINED.top + k * LINED.lineHeight}H${W}`;
      return (
        `<path d="${d}" stroke="${RULE}" stroke-width="${hair}" fill="none"/>` +
        `<path d="M${LINED.marginLeft} 0V${H}" stroke="${MARGIN}" stroke-width="${hair}" fill="none"/>`
      );
    }
    case "grid": {
      let d = "";
      for (const y of steps(LINED.top, 0, H)) d += `M0 ${y}H${W}`;
      for (const x of steps(LINED.marginLeft, 0, W)) d += `M${x} 0V${H}`;
      return `<path d="${d}" stroke="${GRID}" stroke-width="${hair}" fill="none"/>`;
    }
    case "dotted": {
      // A pattern keeps the file small (thousands of dots otherwise).
      const s = GRID_STEP;
      const ox = LINED.marginLeft % s;
      const oy = LINED.top % s;
      return (
        `<defs><pattern id="dots" width="${s}" height="${s}" patternUnits="userSpaceOnUse" x="${ox - s / 2}" y="${oy - s / 2}">` +
        `<circle cx="${s / 2}" cy="${s / 2}" r="${Math.max(2, hair)}" fill="${DOT}"/></pattern></defs>` +
        `<rect width="${W}" height="${H}" fill="url(#dots)"/>`
      );
    }
    case "blank":
      return "";
  }
}
