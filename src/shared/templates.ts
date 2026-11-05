// Page backgrounds. M3 only needs ruled lines (the strip snaps to them);
// M4 adds blank / grid / dotted and per-notebook choice.

import type { PageInfo } from "./protocol.ts";
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

/** Number of writing lines on a page (line k lies between rule k and rule k+1). */
export function lineCount(page: Pick<PageInfo, "height">, r: Ruling = LINED): number {
  return Math.max(1, Math.floor((page.height - r.top - r.bottom) / r.lineHeight));
}

const RULE = "#c9d5e8";
const MARGIN = "#efb4b4";

/**
 * Draw the ruled background. `c` must already map page units to the canvas;
 * `pxPerUnit` is device px per page unit (keeps hairlines ~1 device px).
 * Only rules inside `visible` (page units) are drawn.
 */
export function drawRuling(
  c: CanvasRenderingContext2D,
  page: Pick<PageInfo, "width" | "height">,
  pxPerUnit: number,
  visible: Rect = { x: 0, y: 0, w: page.width, h: page.height },
  r: Ruling = LINED,
): void {
  const hair = Math.max(1, Math.min(2.5, pxPerUnit * 1.5)) / pxPerUnit;
  const n = lineCount(page, r);
  c.save();
  c.lineWidth = hair;
  c.strokeStyle = RULE;
  c.beginPath();
  for (let k = 0; k <= n; k++) {
    const y = r.top + k * r.lineHeight;
    if (y < visible.y - hair || y > visible.y + visible.h + hair) continue;
    c.moveTo(0, y);
    c.lineTo(page.width, y);
  }
  c.stroke();
  if (r.marginLeft >= visible.x - hair && r.marginLeft <= visible.x + visible.w + hair) {
    c.strokeStyle = MARGIN;
    c.beginPath();
    c.moveTo(r.marginLeft, 0);
    c.lineTo(r.marginLeft, page.height);
    c.stroke();
  }
  c.restore();
}
