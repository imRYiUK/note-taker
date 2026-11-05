// App icon for the pad PWA (home-screen launcher), drawn procedurally and
// encoded as PNG — no image assets or dependencies. A ruled page with a line
// of ink and a pen across it. `maskable` fills the whole square (Android crops
// it to its own shape) and keeps the drawing inside the central safe circle.

import { deflateSync } from "node:zlib";

type RGB = [number, number, number];

const BG: RGB = [0x12, 0x12, 0x14];
const PAPER: RGB = [0xf6, 0xf5, 0xf1];
const RULE: RGB = [0xc9, 0xd5, 0xe8];
const INK: RGB = [0x1d, 0x1f, 0x2b];
const PEN: RGB = [0x2f, 0x6f, 0xde];
const PEN_TIP: RGB = [0xec, 0xec, 0xef];

/** Signed distance (unit square coordinates) to a rounded box centred at (cx, cy). */
function box(x: number, y: number, cx: number, cy: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance to segment a–b minus half its thickness (a capsule). */
function capsule(x: number, y: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy) - r;
}

// A handwriting-ish wave on the second rule.
const WAVE: [number, number][] = Array.from({ length: 25 }, (_, i) => {
  const t = i / 24;
  return [0.32 + t * 0.3, 0.455 - 0.035 * Math.sin(t * Math.PI * 5) * (1 - 0.3 * t)];
});

interface Layer {
  color: RGB;
  sdf: (x: number, y: number) => number;
}

function layers(maskable: boolean): Layer[] {
  const out: Layer[] = [];
  out.push({ color: BG, sdf: maskable ? () => -1 : (x, y) => box(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) });
  // Paper: corners inside the maskable safe circle (radius 0.4).
  out.push({ color: PAPER, sdf: (x, y) => box(x, y, 0.5, 0.5, 0.22, 0.29, 0.035) });
  for (const ry of [0.38, 0.49, 0.6, 0.71]) {
    out.push({ color: RULE, sdf: (x, y) => capsule(x, y, 0.32, ry, 0.68, ry, 0.006) });
  }
  out.push({
    color: INK,
    sdf: (x, y) => {
      let d = Infinity;
      for (let i = 1; i < WAVE.length; i++) {
        const [ax, ay] = WAVE[i - 1]!;
        const [bx, by] = WAVE[i]!;
        d = Math.min(d, capsule(x, y, ax, ay, bx, by, 0.014));
      }
      return d;
    },
  });
  // The pen, resting across the page, its tip at the end of the ink.
  out.push({ color: PEN, sdf: (x, y) => capsule(x, y, 0.67, 0.5, 0.82, 0.26, 0.04) });
  out.push({ color: PEN_TIP, sdf: (x, y) => capsule(x, y, 0.635, 0.555, 0.66, 0.515, 0.016) });
  return out;
}

/** RGBA pixels of the icon, `size` × `size`. */
export function renderIcon(size: number, maskable = false): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const ls = layers(maskable);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) / size;
      const y = (j + 0.5) / size;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const l of ls) {
        // Antialiased coverage: one pixel of falloff across the edge.
        const cov = Math.max(0, Math.min(1, 0.5 - l.sdf(x, y) * size));
        if (cov <= 0) continue;
        // "over" compositing, premultiplied
        r = l.color[0] * cov + r * (1 - cov);
        g = l.color[1] * cov + g * (1 - cov);
        b = l.color[2] * cov + b * (1 - cov);
        a = cov + a * (1 - cov);
      }
      const o = (j * size + i) * 4;
      px[o] = a > 0 ? Math.round(r / a) : 0;
      px[o + 1] = a > 0 ? Math.round(g / a) : 0;
      px[o + 2] = a > 0 ? Math.round(b / a) : 0;
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}

// ------------------------------------------------------------------ PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode 8-bit RGBA pixels as a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // compression, filter, interlace: 0
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const ICON_RE = /^pad-(192|512)(-maskable)?\.png$/;
const cache = new Map<string, Uint8Array<ArrayBuffer>>();

/** PNG for `/icons/<name>` (`pad-192.png`, `pad-512.png`, `pad-512-maskable.png`), or null. */
export function iconPng(name: string): Uint8Array<ArrayBuffer> | null {
  const m = ICON_RE.exec(name);
  if (!m) return null;
  let png = cache.get(name);
  if (!png) {
    const size = Number(m[1]);
    png = encodePng(size, size, renderIcon(size, Boolean(m[2])));
    cache.set(name, png);
  }
  return png;
}
