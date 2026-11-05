// Export dialog (Ctrl+E): the notebook as a vector PDF, the current page as
// PDF / SVG (all server-rendered) or PNG — the page SVG rasterized here, so a
// PNG looks exactly like the vector exports.

import type { NotebookState, PageInfo } from "../shared/protocol.ts";
import { exportFileName, pageSuffix } from "../shared/filename.ts";

/** Page units per inch (1 unit = 0.1 mm). */
const UNITS_PER_INCH = 254;
/** Chrome's canvas limit is ~16k px per side / 268 M px: keep well below. */
const MAX_PNG_SIDE = 16000;

export interface ExportContext {
  notebook: NotebookState | null;
  page: PageInfo | null;
}

function download(href: string, filename?: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename ?? ""; // "": the server's Content-Disposition names it
  document.body.append(a);
  a.click();
  a.remove();
}

/** The page SVG drawn onto a canvas at `dpi`, as a PNG blob. */
export async function pagePng(page: PageInfo, dpi: number): Promise<Blob> {
  const res = await fetch(`/api/export/${encodeURIComponent(page.id)}.svg`);
  if (!res.ok) throw new Error(`server: ${res.status}`);
  const url = URL.createObjectURL(new Blob([await res.text()], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let scale = dpi / UNITS_PER_INCH;
    scale = Math.min(scale, MAX_PNG_SIDE / page.width, MAX_PNG_SIDE / page.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(page.width * scale);
    canvas.height = Math.round(page.height * scale);
    const c = canvas.getContext("2d", { alpha: false })!;
    c.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas too large"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class ExportDialog {
  private readonly split: HTMLInputElement;
  private readonly dpi: HTMLSelectElement;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly ctx: () => ExportContext,
    private readonly toast: (text: string, kind?: "error" | "info") => void,
  ) {
    this.split = dialog.querySelector("#ex-split")!;
    this.dpi = dialog.querySelector("#ex-dpi")!;
    const on = (sel: string, fn: () => void | Promise<void>) =>
      dialog.querySelector(sel)!.addEventListener("click", () => void fn());
    on("#ex-nb-pdf", () => this.notebookPdf());
    on("#ex-page-pdf", () => this.pageFile("pdf"));
    on("#ex-page-svg", () => this.pageFile("svg"));
    on("#ex-page-png", () => this.png());
    on("#ex-close", () => dialog.close());
    // Click on the backdrop closes it.
    dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());
  }

  open(): void {
    const { notebook, page } = this.ctx();
    if (!notebook || !page) return this.toast("Nothing to export yet");
    const i = notebook.pages.findIndex((p) => p.id === page.id);
    const n = notebook.pages.length;
    const endless = notebook.pages.some((p) => p.height > 2970 * 1.01);
    this.dialog.querySelector("#ex-nb-title")!.textContent = `“${notebook.notebook.title}” · ${n} page${n === 1 ? "" : "s"}`;
    this.dialog.querySelector("#ex-page-title")!.textContent = `Page ${i + 1} of ${n}`;
    this.split.closest("label")!.hidden = !endless;
    if (!this.dialog.open) this.dialog.showModal();
  }

  toggle(): void {
    if (this.dialog.open) this.dialog.close();
    else this.open();
  }

  private notebookPdf(): void {
    const nb = this.ctx().notebook;
    if (!nb) return;
    const split = this.split.checked && !this.split.closest("label")!.hidden ? "&split=1" : "";
    download(`/api/export/${encodeURIComponent(nb.notebook.id)}.pdf?download=1${split}`);
    this.dialog.close();
  }

  private pageFile(ext: "pdf" | "svg"): void {
    const page = this.ctx().page;
    if (!page) return;
    download(`/api/export/${encodeURIComponent(page.id)}.${ext}?download=1`);
    this.dialog.close();
  }

  private async png(): Promise<void> {
    const { notebook, page } = this.ctx();
    if (!notebook || !page) return;
    const btn = this.dialog.querySelector<HTMLButtonElement>("#ex-page-png")!;
    btn.disabled = true;
    try {
      const blob = await pagePng(page, Number(this.dpi.value) || 200);
      const i = notebook.pages.findIndex((p) => p.id === page.id);
      const url = URL.createObjectURL(blob);
      download(url, exportFileName(notebook.notebook.title, "png", pageSuffix(i, notebook.pages.length)));
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      this.dialog.close();
    } catch (e) {
      this.toast(`PNG export failed: ${(e as Error).message}`);
    } finally {
      btn.disabled = false;
    }
  }
}
