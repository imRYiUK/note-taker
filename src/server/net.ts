import { networkInterfaces } from "node:os";
import { timingSafeEqual } from "node:crypto";
import type { PadUrls } from "../shared/protocol.ts";

export function isLoopback(address: string | null | undefined): boolean {
  if (!address) return false;
  return (
    address === "::1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

/** Non-internal IPv4 addresses, for Wi-Fi pairing URLs. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

export function padUrls(port: number, token: string, hosts = lanAddresses()): PadUrls {
  return {
    // Loopback (adb reverse) is trusted, so the USB URL needs no token.
    usb: `http://localhost:${port}/pad`,
    lan: hosts.map((h) => `http://${h}:${port}/pad?token=${token}`),
  };
}

/**
 * Loopback connections are trusted: they come from this machine or from the
 * phone over `adb reverse` (USB). Everything else must present the token.
 */
export function authorize(loopback: boolean, given: string | null | undefined, token: string): boolean {
  if (loopback) return true;
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
