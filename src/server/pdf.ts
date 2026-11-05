// Minimal PDF 1.4 writer — just what vector notebook export needs: pages that
// draw Form XObjects, Flate-compressed content streams, ExtGStates (opacity /
// blend mode) and document info. No fonts, no images.

import { deflateSync } from "node:zlib";

type Body = string | { dict: string; stream: Uint8Array };

export interface PdfForm {
  /** Size in points. */
  width: number;
  height: number;
  /** Content stream operators. */
  content: string;
  /** Names of ExtGStates (from `extGState`) the content uses. */
  gs?: string[];
}

export interface PdfPage {
  width: number;
  height: number;
  /** Draw `form` translated by (dx, dy) points. */
  form: number;
  dx?: number;
  dy?: number;
}

const enc = new TextEncoder();

/** A PDF text string: literal for printable ASCII, UTF-16BE hex otherwise. */
export function pdfString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, (c) => "\\" + c)})`;
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0");
  return `<${hex.toUpperCase()}>`;
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Shortest decimal form, `digits` after the point. */
export const num = (v: number, digits = 2) => String(+v.toFixed(digits));

export class PdfWriter {
  private readonly objects: Body[] = [];
  private readonly forms: { id: number; gs: string[] }[] = [];
  private readonly pages: PdfPage[] = [];
  private readonly gstates = new Map<string, string>();
  private readonly gsIds = new Map<string, number>();

  constructor(private readonly compress = true) {}

  private add(body: Body): number {
    this.objects.push(body);
    return this.objects.length; // object numbers start at 1
  }

  private stream(dict: string, text: string): Body {
    const raw = enc.encode(text);
    if (!this.compress) return { dict: `${dict} /Length ${raw.length}`, stream: raw };
    const z = deflateSync(raw, { level: 9 });
    return { dict: `${dict} /Filter /FlateDecode /Length ${z.length}`, stream: z };
  }

  /** Register a graphics state: `ca` = fill opacity, `bm` = blend mode (e.g. "Multiply"). */
  extGState(name: string, ca: number, bm = "Normal"): void {
    this.gstates.set(name, `<< /Type /ExtGState /ca ${num(ca, 3)} /CA ${num(ca, 3)} /BM /${bm} >>`);
  }

  /** Add a reusable drawing; returns its handle for `page()`. */
  form(f: PdfForm): number {
    const id = this.add(
      this.stream(`<< /Type /XObject /Subtype /Form /BBox [0 0 ${num(f.width)} ${num(f.height)}] /Resources ${this.resources(f.gs ?? [])}`, f.content),
    );
    this.forms.push({ id, gs: f.gs ?? [] });
    return this.forms.length - 1;
  }

  page(p: PdfPage): void {
    if (!this.forms[p.form]) throw new Error("pdf: unknown form");
    this.pages.push(p);
  }

  private resources(gs: string[]): string {
    if (!gs.length) return "<< >>";
    const entries = gs.map((name) => {
      let id = this.gsIds.get(name);
      if (id === undefined) {
        const dict = this.gstates.get(name);
        if (!dict) throw new Error(`pdf: unknown ExtGState ${name}`);
        id = this.add(dict);
        this.gsIds.set(name, id);
      }
      return `/${name} ${id} 0 R`;
    });
    return `<< /ExtGState << ${entries.join(" ")} >> >>`;
  }

  /** Serialize. `info.title` becomes the document title. */
  finish(info: { title?: string; date?: Date } = {}): Uint8Array<ArrayBuffer> {
    const pagesId = this.objects.length + 1;
    this.add(""); // placeholder for the page tree, filled below
    const kids: number[] = [];
    for (const p of this.pages) {
      const content = this.add(this.stream("<<", `q 1 0 0 1 ${num(p.dx ?? 0)} ${num(p.dy ?? 0)} cm /F${p.form} Do Q`));
      const xo = `<< /XObject << /F${p.form} ${this.forms[p.form]!.id} 0 R >> >>`;
      kids.push(
        this.add(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}] /Resources ${xo} /Contents ${content} 0 R >>`,
        ),
      );
    }
    this.objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    const catalog = this.add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    const date = pdfDate(info.date ?? new Date());
    const infoId = this.add(
      `<< ${info.title ? `/Title ${pdfString(info.title)} ` : ""}/Producer (note-taker) /CreationDate (${date}) >>`,
    );

    const chunks: Uint8Array[] = [];
    let size = 0;
    const push = (b: Uint8Array | string) => {
      const bytes = typeof b === "string" ? enc.encode(b) : b;
      chunks.push(bytes);
      size += bytes.length;
    };
    // Header + a binary comment so tools treat the file as binary.
    push(new Uint8Array([...enc.encode("%PDF-1.4\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    const offsets: number[] = [];
    this.objects.forEach((body, i) => {
      offsets.push(size);
      push(`${i + 1} 0 obj\n`);
      if (typeof body === "string") push(body);
      else {
        push(`${body.dict} >>\nstream\n`);
        push(body.stream);
        push("\nendstream");
      }
      push("\nendobj\n");
    });
    const xref = size;
    push(`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`);
    for (const o of offsets) push(`${String(o).padStart(10, "0")} 00000 n \n`);
    push(`trailer\n<< /Size ${this.objects.length + 1} /Root ${catalog} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    const out = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}
