import { describe, expect, test } from "bun:test";
import { qrEncode, qrSvg, qrTerminal, QR_MAX_BYTES } from "../src/shared/qr.ts";
import { encodePng } from "../src/server/icon.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_BASE = "https://192.168.178.23:7778/pad?token=" + "0123456789abcdef".repeat(14);
const zbar = Bun.which("zbarimg");

function png(m: boolean[][], scale = 4, quiet = 4): Uint8Array {
  const n = (m.length + 2 * quiet) * scale;
  const px = new Uint8Array(n * n * 4).fill(255);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!m[Math.floor(y / scale) - quiet]?.[Math.floor(x / scale) - quiet]) continue;
      const o = (y * n + x) * 4;
      px[o] = px[o + 1] = px[o + 2] = 0;
    }
  }
  return encodePng(n, n, px);
}

describe("QR", () => {
  test("size grows with the text (versions 1–10)", () => {
    expect(qrEncode("a").length).toBe(21);
    expect(qrEncode(URL_BASE.slice(0, 62)).length).toBe(33); // v4: a typical pad URL
    expect(qrEncode(URL_BASE.slice(0, QR_MAX_BYTES)).length).toBe(57); // v10
    expect(() => qrEncode(URL_BASE.slice(0, QR_MAX_BYTES + 1))).toThrow(/too long/);
  });

  test("finder patterns in three corners", () => {
    const m = qrEncode("hello");
    const n = m.length;
    for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]] as const) {
      expect(m[y]![x]).toBe(true);
      expect(m[y + 1]![x + 1]).toBe(false);
      expect(m[y + 3]![x + 3]).toBe(true);
    }
  });

  test.skipIf(!zbar)("decodes with zbarimg at every version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-taker-qr-"));
    try {
      for (const len of [1, 20, 30, 50, 63, 100, 120, 150, 180, QR_MAX_BYTES]) {
        const text = URL_BASE.slice(0, len);
        const file = join(dir, `q${len}.png`);
        await Bun.write(file, png(qrEncode(text)));
        const out = Bun.spawnSync([zbar!, "-q", "--raw", file]).stdout.toString().trim();
        expect(out).toBe(text);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("SVG and terminal renderings", () => {
    const svg = qrSvg("hello");
    expect(svg).toStartWith("<svg");
    expect(svg).toContain('viewBox="0 0 29 29"'); // 21 + 2 × 4 quiet
    const lines = qrTerminal("hello").split("\n");
    expect(lines).toHaveLength(Math.ceil((21 + 4) / 2));
  });
});
