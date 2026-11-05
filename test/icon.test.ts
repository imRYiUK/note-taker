import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { encodePng, iconPng, renderIcon } from "../src/server/icon.ts";

/** Minimal PNG reader: chunks, IHDR, raw pixels (filter 0 only — what we write). */
function readPng(png: Uint8Array) {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; data: Uint8Array }[] = [];
  for (let o = 8; o < png.length; ) {
    const len = v.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    chunks.push({ type, data: png.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  const ihdr = chunks[0]!;
  expect(ihdr.type).toBe("IHDR");
  const h = new DataView(ihdr.data.buffer, ihdr.data.byteOffset);
  const width = h.getUint32(0);
  const height = h.getUint32(4);
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
  expect(chunks.at(-1)!.type).toBe("IEND");
  const pixel = (x: number, y: number) => {
    const o = y * (width * 4 + 1) + 1 + x * 4;
    return [...raw.subarray(o, o + 4)];
  };
  return { width, height, bitDepth: ihdr.data[8], colorType: ihdr.data[9], rawLength: raw.length, pixel };
}

describe("PWA icon", () => {
  test("encodes a valid RGBA PNG", () => {
    const px = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]);
    const png = readPng(encodePng(2, 1, px));
    expect(png).toMatchObject({ width: 2, height: 1, bitDepth: 8, colorType: 6, rawLength: 9 });
    expect(png.pixel(0, 0)).toEqual([255, 0, 0, 255]);
    expect(png.pixel(1, 0)).toEqual([0, 0, 255, 128]);
  });

  test("served sizes; the maskable one fills its corners, the plain one is rounded", () => {
    for (const size of [192, 512]) {
      const png = readPng(iconPng(`pad-${size}.png`)!);
      expect(png.width).toBe(size);
      expect(png.pixel(0, 0)[3]).toBe(0); // rounded corner: transparent
      expect(png.pixel(size / 2, size / 2)[3]).toBe(255);
    }
    const mask = readPng(iconPng("pad-512-maskable.png")!);
    expect(mask.pixel(0, 0)).toEqual([0xfd, 0xbc, 0xb4, 255]); // --peach
    expect(iconPng("pad-64.png")).toBeNull();
    expect(iconPng("../etc/passwd")).toBeNull();
  });

  test("the page is drawn (light pixels in the middle)", () => {
    const px = renderIcon(64);
    const o = (20 * 64 + 26) * 4; // on the paper, away from rules and ink
    expect(px[o]!).toBeGreaterThan(200);
  });
});
