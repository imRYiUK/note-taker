import { describe, expect, test } from "bun:test";
import { authorize, isLoopback, lanAddresses, padUrls } from "../src/server/net.ts";
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
    expect(padUrls(7777, "tok", [{ address: "192.168.1.5", iface: "wlan0" }])).toEqual({
      usb: "http://localhost:7777/pad",
      lan: [{ url: "http://192.168.1.5:7777/pad?token=tok", iface: "wlan0", secure: false }],
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

describe("lanAddresses", () => {
  const a = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "", mac: "", cidr: null });
  test("Wi-Fi first, bridges and link-local dropped, VPN last", () => {
    const got = lanAddresses({
      lo: [a("127.0.0.1", true)],
      tailscale0: [a("100.101.1.2")],
      docker0: [a("172.17.0.1")],
      "br-1a2b": [a("172.18.0.1")],
      enp3s0: [a("192.168.1.10")],
      wlan0: [a("192.168.1.20")],
      eth1: [a("169.254.3.4")],
    } as never);
    expect(got).toEqual([
      { address: "192.168.1.20", iface: "wlan0" },
      { address: "192.168.1.10", iface: "enp3s0" },
      { address: "100.101.1.2", iface: "tailscale0" },
    ]);
  });

  test("https links when a TLS port is set", () => {
    const urls = padUrls(7777, "tok", [{ address: "10.0.0.2", iface: "wlp2s0" }], { httpsPort: 7778 });
    expect(urls.lan).toEqual([{ url: "https://10.0.0.2:7778/pad?token=tok", iface: "wlp2s0", secure: true }]);
  });
});
