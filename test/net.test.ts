import { describe, expect, test } from "bun:test";
import { authorize, isLoopback, padUrls } from "../src/server/net.ts";
import { parseAdbDevices } from "../src/server/adb.ts";

describe("net", () => {
  test("isLoopback", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("192.168.1.20")).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });

  test("authorize: loopback trusted, LAN needs exact token", () => {
    expect(authorize(true, null, "secret-token-123")).toBe(true);
    expect(authorize(false, null, "secret-token-123")).toBe(false);
    expect(authorize(false, "wrong", "secret-token-123")).toBe(false);
    expect(authorize(false, "secret-token-124", "secret-token-123")).toBe(false);
    expect(authorize(false, "secret-token-123", "secret-token-123")).toBe(true);
  });

  test("padUrls", () => {
    expect(padUrls(7777, "tok", ["192.168.1.5"])).toEqual({
      usb: "http://localhost:7777/pad",
      lan: ["http://192.168.1.5:7777/pad?token=tok"],
    });
  });
});

describe("parseAdbDevices", () => {
  test("parses devices -l output", () => {
    const out = `* daemon not running; starting now at tcp:5037
* daemon started successfully
List of devices attached
R5CW30ABCDE            device usb:1-2 product:dm3qxxx model:SM_S918B device:dm3q transport_id:3
emulator-5554          unauthorized transport_id:4

`;
    expect(parseAdbDevices(out)).toEqual([
      { serial: "R5CW30ABCDE", state: "device", model: "SM S918B" },
      { serial: "emulator-5554", state: "unauthorized", model: null },
    ]);
  });

  test("empty list", () => {
    expect(parseAdbDevices("List of devices attached\n\n")).toEqual([]);
  });
});
