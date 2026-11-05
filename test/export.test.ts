import { describe, expect, test } from "bun:test";
import { attachment, exportFileName, notebookPdf, pageSvg, pdfColor } from "../src/server/export.ts";
import { pdfString } from "../src/server/pdf.ts";
import { DEFAULT_INK, HIGHLIGHTER_ALPHA } from "../src/shared/ink.ts";
import type { PageInfo, StrokeData } from "../src/shared/protocol.ts";

const page: PageInfo = { id: "p", notebookId: "n", kind: "a4", width: 2100, height: 2970 };
const stroke = (id: string, tool: "pen" | "highlighter", color: string, createdAt: number): StrokeData => ({
  id,
  pageId: "p",
  tool,
  color,
  width: tool === "pen" ? 10 : 56,
  pts: [300, 400, 0.3, 0, 600, 400, 0.3, 50],
  createdAt,
});

describe("page SVG", () => {
  test("highlighter is multiplied under the ink, even when drawn after it", () => {
    const svg = pageSvg(page, "blank", [stroke("a", "pen", "#112233", 1), stroke("h", "highlighter", "#ffe14d", 2)], DEFAULT_INK);
    const pen = svg.indexOf('fill="#112233"');
    const hl = svg.indexOf('fill="#ffe14d"');
    expect(pen).toBeGreaterThan(0);
    expect(hl).toBeGreaterThan(0);
    expect(hl).toBeLessThan(pen);
    expect(svg).toContain(`fill-opacity="${HIGHLIGHTER_ALPHA}" style="mix-blend-mode:multiply"`);
    expect(svg.match(/mix-blend-mode/g)).toHaveLength(1);
  });
});

describe("notebook PDF", () => {
  const tall: PageInfo = { id: "t", notebookId: "n", kind: "infinite", width: 2100, height: 6500 };
  const src = (p: PageInfo, strokes: StrokeData[]) => ({ page: p, template: "lined" as const, strokes });
  const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

  test("one PDF page per note page, A4 in points, vector ink", () => {
    const pdf = text(notebookPdf([src(page, [stroke("a", "pen", "#112233", 1)]), src(page, [])], DEFAULT_INK, { compress: false, title: "Maths" }));
    expect(pdf).toStartWith("%PDF-1.4");
    expect(pdf).toContain("/Count 2");
    expect(pdf).toContain("/MediaBox [0 0 595.28 841.89]");
    expect(pdf).toContain("/Title (Maths)");
    expect(pdf).toContain(`${pdfColor("#112233")} rg`);
    expect(pdf).toMatch(/ c .* f/); // filled cubic outline
    expect(pdf.trimEnd()).toEndWith("%%EOF");
  });

  test("highlighter: multiply ExtGState, painted before the ink", () => {
    const pdf = text(notebookPdf([src(page, [stroke("a", "pen", "#112233", 1), stroke("h", "highlighter", "#ffe14d", 2)])], DEFAULT_INK, { compress: false }));
    expect(pdf).toContain(`/ca ${HIGHLIGHTER_ALPHA} /CA ${HIGHLIGHTER_ALPHA} /BM /Multiply`);
    expect(pdf.indexOf("/Hl gs")).toBeLessThan(pdf.indexOf(`${pdfColor("#112233")} rg`));
  });

  test("endless pages: one tall page, or cut into A4 sheets", () => {
    expect(text(notebookPdf([src(tall, [])], DEFAULT_INK, { compress: false }))).toContain("/Count 1");
    const split = text(notebookPdf([src(tall, [])], DEFAULT_INK, { compress: false, split: true }));
    expect(split).toContain("/Count 3"); // 6500 / 2970 → 3 sheets
    expect(split.match(/\/MediaBox \[0 0 595.28 841.89\]/g)).toHaveLength(3);
    // An A4 page is never split.
    expect(text(notebookPdf([src(page, [])], DEFAULT_INK, { compress: false, split: true }))).toContain("/Count 1");
  });

  test("non-ASCII titles as UTF-16, colours parsed", () => {
    expect(pdfString("Übung")).toBe("<FEFF00DC00620075006E0067>");
    expect(pdfString("a(b)")).toBe("(a\\(b\\))");
    expect(pdfColor("#ff0000")).toBe("1 0 0");
    expect(pdfColor("red")).toBe("0 0 0");
  });

  test("download names", () => {
    expect(exportFileName('Physik: "Übung" 3/4', "pdf", " - p2")).toBe("Physik Übung 3 4 - p2.pdf");
    expect(exportFileName("   ", "svg")).toBe("notes.svg");
    expect(attachment("Übung.pdf")).toBe(`attachment; filename="_bung.pdf"; filename*=UTF-8''%C3%9Cbung.pdf`);
  });
});
