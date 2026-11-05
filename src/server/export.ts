// Vector export of a page (PLAN.md §10). M4 uses it for the viewer's page
// thumbnails; M6 builds PDF export on top of it.

import { outlineToSvgPath, strokeOutline, type InkSettings } from "../shared/ink.ts";
import type { PageInfo, StrokeData, Template } from "../shared/protocol.ts";
import { templateSvg } from "../shared/templates.ts";

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
  for (const s of strokes) {
    const d = outlineToSvgPath(strokeOutline(s.pts, s.width, ink, true), digits);
    if (!d) continue;
    const alpha = s.tool === "highlighter" ? ` fill-opacity="0.35"` : "";
    parts.push(`<path d="${d}" fill="${s.color}"${alpha}/>`);
  }
  parts.push("</svg>");
  return parts.join("");
}
