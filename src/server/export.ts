// Vector export (PLAN.md §10): a page as SVG (also the viewer's thumbnails and
// the source of PNG export) and a notebook as PDF. Both draw the same
// perfect-freehand outlines as the screen, with the template underneath and
// highlighter multiplied under the ink.

import {
  A4,
  HIGHLIGHTER_ALPHA,
  outlineToSvgPath,
  paintOrder,
  strokeOutline,
  traceOutline,
  type InkSettings,
  type Outline,
} from "../shared/ink.ts";
import type { PageInfo, StrokeData, Template } from "../shared/protocol.ts";
import { GRID_STEP, LINED, TEMPLATE_COLORS, lineCount, steps, templateSvg } from "../shared/templates.ts";
import { PdfWriter, num } from "./pdf.ts";

export { exportFileName } from "../shared/filename.ts";

const PAPER = "#ffffff";

export interface SvgOptions {
  /** Coarser coordinates (whole page units) — fine for a thumbnail, ~40 % smaller. */
  thumb?: boolean;
}

/** The page as a standalone SVG document; 1 user unit = 0.1 mm. */
export function pageSvg(
  page: PageInfo,
  template: Template,
  strokes: StrokeData[],
  ink: InkSettings,
  opts: SvgOptions = {},
): string {
  const W = page.width;
  const H = page.height;
  const digits = opts.thumb ? 0 : 1;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W / 10}mm" height="${H / 10}mm">`,
    `<rect width="${W}" height="${H}" fill="${PAPER}"/>`,
    // Thumbnails are tiny: thicker template lines keep them visible.
    templateSvg(template, page, opts.thumb ? 4 : 2),
  ];
  // Highlighter under the ink, multiplied onto the paper like on screen.
  for (const s of paintOrder(strokes)) {
    const d = outlineToSvgPath(strokeOutline(s.pts, s.width, ink, true, undefined, s.tool), digits);
    if (!d) continue;
    const hl = s.tool === "highlighter" ? ` fill-opacity="${HIGHLIGHTER_ALPHA}" style="mix-blend-mode:multiply"` : "";
    parts.push(`<path d="${d}" fill="${s.color}"${hl}/>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

// ------------------------------------------------------------------ PDF

/** Points per page unit (0.1 mm). */
export const PT_PER_UNIT = 72 / 254;

export interface PdfSource {
  page: PageInfo;
  template: Template;
  strokes: StrokeData[];
}

export interface PdfOptions {
  title?: string;
  /** Cut pages taller than A4 (endless pages) into A4 sheets instead of one tall page. */
  split?: boolean;
  /** Flate-compress content streams (default true; off in tests to read them). */
  compress?: boolean;
  date?: Date;
}

/** "#rrggbb" → PDF colour operands; unknown formats fall back to black. */
export function pdfColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "0 0 0";
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => num(c / 255, 3)).join(" ");
}

/** An outline as PDF path operators (quadratic segments → cubic), page units. */
export function outlinePdfPath(o: Outline): string {
  const parts: string[] = [];
  const f = (v: number) => num(v, 1);
  let cx = 0;
  let cy = 0;
  traceOutline(
    {
      moveTo: (x, y) => {
        parts.push(`${f(x)} ${f(y)} m`);
        cx = x;
        cy = y;
      },
      lineTo: (x, y) => {
        parts.push(`${f(x)} ${f(y)} l`);
        cx = x;
        cy = y;
      },
      quadraticCurveTo: (qx, qy, x, y) => {
        const c1x = cx + (2 / 3) * (qx - cx);
        const c1y = cy + (2 / 3) * (qy - cy);
        const c2x = x + (2 / 3) * (qx - x);
        const c2y = y + (2 / 3) * (qy - y);
        parts.push(`${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(x)} ${f(y)} c`);
        cx = x;
        cy = y;
      },
      closePath: () => parts.push("h"),
    },
    o,
  );
  return parts.join(" ");
}

/** Template background as PDF operators, page units (y down). */
function templatePdf(template: Template, page: Pick<PageInfo, "width" | "height">): string {
  const W = page.width;
  const H = page.height;
  const hair = 2;
  const stroke = (color: string, d: string) => (d ? `${pdfColor(color)} RG ${hair} w ${d} S\n` : "");
  switch (template) {
    case "lined": {
      let d = "";
      for (let k = 0; k <= lineCount(page); k++) {
        const y = LINED.top + k * LINED.lineHeight;
        d += `0 ${y} m ${W} ${y} l `;
      }
      return stroke(TEMPLATE_COLORS.rule, d) + stroke(TEMPLATE_COLORS.margin, `${LINED.marginLeft} 0 m ${LINED.marginLeft} ${H} l`);
    }
    case "grid": {
      let d = "";
      for (const y of steps(LINED.top, 0, H)) d += `0 ${y} m ${W} ${y} l `;
      for (const x of steps(LINED.marginLeft, 0, W)) d += `${x} 0 m ${x} ${H} l `;
      return stroke(TEMPLATE_COLORS.grid, d);
    }
    case "dotted": {
      // Zero-length round-capped segments: a dot each, ~20 bytes per dot before compression.
      const xs = steps(LINED.marginLeft, 0, W, GRID_STEP);
      let d = "";
      for (const y of steps(LINED.top, 0, H, GRID_STEP)) for (const x of xs) d += `${x} ${y} m ${x} ${y} l `;
      return `${pdfColor(TEMPLATE_COLORS.dot)} RG 1 J 4 w ${d}S\n`;
    }
    case "blank":
      return "";
  }
}

/** Content stream of one note page in PDF points (origin bottom-left). */
export function pagePdfContent(src: PdfSource, ink: InkSettings): string {
  const { page, template, strokes } = src;
  const s = num(PT_PER_UNIT, 6);
  const out = [
    // Page units, y down — same coordinates as the SVG.
    `${s} 0 0 -${s} 0 ${num(page.height * PT_PER_UNIT, 3)} cm`,
    `1 1 1 rg 0 0 ${page.width} ${page.height} re f`,
    templatePdf(template, page),
  ];
  let inHighlight = false;
  for (const st of paintOrder(strokes)) {
    const path = outlinePdfPath(strokeOutline(st.pts, st.width, ink, true, undefined, st.tool));
    if (!path) continue;
    const hl = st.tool === "highlighter";
    if (hl && !inHighlight) out.push("q /Hl gs");
    if (!hl && inHighlight) out.push("Q");
    inHighlight = hl;
    out.push(`${pdfColor(st.color)} rg ${path} f`);
  }
  if (inHighlight) out.push("Q");
  return out.join("\n");
}

/** A notebook (its pages in order) as a vector PDF. */
export function notebookPdf(pages: PdfSource[], ink: InkSettings, opts: PdfOptions = {}): Uint8Array<ArrayBuffer> {
  const pdf = new PdfWriter(opts.compress ?? true);
  pdf.extGState("Hl", HIGHLIGHTER_ALPHA, "Multiply");
  const sheet = A4.height * PT_PER_UNIT;
  for (const src of pages) {
    const w = src.page.width * PT_PER_UNIT;
    const h = src.page.height * PT_PER_UNIT;
    const hasHl = src.strokes.some((s) => s.tool === "highlighter");
    const form = pdf.form({ width: w, height: h, content: pagePdfContent(src, ink), gs: hasHl ? ["Hl"] : [] });
    // 1 % slack: an A4 page is never split by rounding.
    if (!opts.split || h <= sheet * 1.01) {
      pdf.page({ width: w, height: h, form });
      continue;
    }
    // Sheet k shows form y ∈ [h − (k+1)·sheet, h − k·sheet] (PDF y is up; the page top comes first).
    for (let k = 0; k * sheet < h - 1; k++) pdf.page({ width: w, height: sheet, form, dy: -(h - (k + 1) * sheet) });
  }
  return pdf.finish({ title: opts.title, date: opts.date });
}

/** `Content-Disposition` for a download, with an ASCII fallback and the UTF-8 name. */
export function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
