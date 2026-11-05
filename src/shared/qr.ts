// QR code encoder (ISO/IEC 18004) for the Wi-Fi pairing link — byte mode,
// error correction level M, versions 1–10 (up to 213 bytes: a pad URL is ~70).
// No dependency; used by the viewer (SVG) and the server (terminal).

/** [total codewords, EC codewords per block, blocks in group 1, data per block in group 1, blocks in group 2] (level M). */
const VERSIONS: readonly (readonly [number, number, number, number, number])[] = [
  [26, 10, 1, 16, 0],
  [44, 16, 1, 28, 0],
  [70, 26, 1, 44, 0],
  [100, 18, 2, 32, 0],
  [134, 24, 2, 43, 0],
  [172, 16, 4, 27, 0],
  [196, 18, 4, 31, 0],
  [242, 22, 2, 38, 2],
  [292, 22, 3, 36, 2],
  [346, 26, 4, 43, 1],
];
const ALIGN: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];
/** Format bits for level M. */
const EC_M = 0b00;

export const QR_MAX_BYTES = 213;

function dataCapacity(version: number): number {
  const [, , g1, d1, g2] = VERSIONS[version - 1]!;
  return g1 * d1 + g2 * (d1 + 1);
}

// ------------------------------------------------------------- Reed–Solomon over GF(256), poly 0x11D

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const d = new Array<number>(degree).fill(0);
  d[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      d[j] = gfMul(d[j]!, root);
      if (j + 1 < degree) d[j] = d[j]! ^ d[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return d;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const out = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ out.shift()!;
    out.push(0);
    for (let i = 0; i < divisor.length; i++) out[i] = out[i]! ^ gfMul(divisor[i]!, factor);
  }
  return out;
}

// ------------------------------------------------------------- codewords

function codewords(bytes: Uint8Array, version: number): number[] {
  const cap = dataCapacity(version);
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks, add EC, interleave.
  const [, ecLen, g1, d1, g2] = VERSIONS[version - 1]!;
  const div = rsDivisor(ecLen);
  const blocks: { data: number[]; ec: number[] }[] = [];
  let o = 0;
  for (let b = 0; b < g1 + g2; b++) {
    const len = b < g1 ? d1 : d1 + 1;
    const d = data.slice(o, o + len);
    o += len;
    blocks.push({ data: d, ec: rsRemainder(d, div) });
  }
  const out: number[] = [];
  for (let i = 0; i <= d1; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]!);
  return out;
}

// ------------------------------------------------------------- matrix

class Matrix {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  set(x: number, y: number, dark: boolean): void {
    this.dark[y]![x] = dark;
    this.fn[y]![x] = true;
  }
}

function drawFunctionPatterns(m: Matrix): void {
  const n = m.size;
  for (let i = 0; i < n; i++) {
    m.set(6, i, i % 2 === 0);
    m.set(i, 6, i % 2 === 0);
  }
  // Finders (with separators).
  for (const [cx, cy] of [
    [3, 3],
    [n - 4, 3],
    [3, n - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        m.set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  // Alignment patterns (not over the finders).
  const pos = ALIGN[m.version - 1]!;
  const last = pos.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) m.set(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormat(m, 0); // reserves the area; redrawn with the real mask
  if (m.version >= 7) {
    let rem = m.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (m.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m.set(a, b, dark);
      m.set(b, a, dark);
    }
  }
}

function drawFormat(m: Matrix, mask: number): void {
  const n = m.size;
  const data = (EC_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m.set(8, i, bit(i));
  m.set(8, 7, bit(6));
  m.set(8, 8, bit(7));
  m.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) m.set(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.set(8, n - 15 + i, bit(i));
  m.set(8, n - 8, true); // the dark module
}

function drawData(m: Matrix, data: number[]): void {
  const n = m.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (m.fn[y]![x] || i >= data.length * 8) continue;
        m.dark[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m: Matrix, mask: number): void {
  const f = MASKS[mask]!;
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) if (!m.fn[y]![x] && f(x, y)) m.dark[y]![x] = !m.dark[y]![x];
  }
}

/** Standard penalty score (lower is better); only used to pick the mask. */
function penalty(g: boolean[][]): number {
  const n = g.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    // Finder-like 1:1:3:1:1 with 4 light modules on one side.
    for (let i = 0; i + 11 <= n; i++) {
      const s = Array.from({ length: 11 }, (_, k) => get(i + k));
      const a = [true, false, true, true, true, false, true, false, false, false, false];
      if (s.every((v, k) => v === a[k]) || s.every((v, k) => v === a[10 - k])) score += 40;
    }
  };
  let dark = 0;
  for (let y = 0; y < n; y++) {
    line((x) => g[y]![x]!);
    line((i) => g[i]![y]!);
    for (let x = 0; x < n; x++) {
      if (g[y]![x]) dark++;
      if (x + 1 < n && y + 1 < n) {
        const c = g[y]![x];
        if (c === g[y]![x + 1] && c === g[y + 1]![x] && c === g[y + 1]![x + 1]) score += 3;
      }
    }
  }
  score += Math.floor(Math.abs((dark * 20) / (n * n) - 10)) * 10;
  return score;
}

/** QR modules (`true` = dark), row-major, without the quiet zone. Throws if `text` is too long. */
export function qrEncode(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  // Header: 4 bits mode + 8 (v1–9) or 16 (v10) bits length.
  while (version <= VERSIONS.length && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCapacity(version) * 8) version++;
  if (version > VERSIONS.length) throw new Error(`QR: text too long (${bytes.length} bytes, max ${QR_MAX_BYTES})`);
  const data = codewords(bytes, version);

  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = new Matrix(version);
    drawFunctionPatterns(m);
    drawData(m, data);
    applyMask(m, mask);
    drawFormat(m, mask);
    const s = penalty(m.dark);
    if (s < bestScore) {
      bestScore = s;
      best = m.dark;
    }
  }
  return best!;
}

/** SVG path (`d`) of the dark modules, one unit per module, offset by `quiet` modules. */
export function qrPath(modules: boolean[][], quiet = 4): string {
  let d = "";
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (row[x + w]) w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w - 1;
    }
  });
  return d;
}

/** Standalone SVG document (black on white). */
export function qrSvg(text: string, quiet = 4): string {
  const m = qrEncode(text);
  const n = m.length + quiet * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="#fff"/><path d="${qrPath(m, quiet)}" fill="#000"/></svg>`
  );
}

/** Terminal rendering: two modules per character cell, black on white (ANSI), with a quiet zone. */
export function qrTerminal(text: string, quiet = 2): string {
  const m = qrEncode(text);
  const n = m.length;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && m[y]![x]!;
  const lines: string[] = [];
  for (let y = -quiet; y < n + quiet; y += 2) {
    let s = "\x1b[30;107m";
    for (let x = -quiet; x < n + quiet; x++) {
      const top = at(x, y);
      const bottom = at(x, y + 1);
      s += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(s + "\x1b[0m");
  }
  return lines.join("\n");
}
