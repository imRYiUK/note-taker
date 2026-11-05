import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { X509Certificate, timingSafeEqual } from "node:crypto";
import type { PadLink, PadUrls } from "../shared/protocol.ts";

export function isLoopback(address: string | null | undefined): boolean {
  if (!address) return false;
  return (
    address === "::1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

export interface LanAddress {
  address: string;
  /** Interface name (wlan0, enp3s0, …). */
  iface: string;
}

/** Container / VM bridges: never reachable from the phone. */
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|cali|podman|lxc|lxd|kube|incus)/;
/** VPN-ish interfaces: only useful if the phone is on the same VPN, so listed last. */
const VPN_IFACE = /^(tailscale|zt|tun|tap|wg|ppp)/;

function ifaceRank(name: string): number {
  if (/^(wl|wlan|wifi|ath|ra\d)/.test(name)) return 0; // Wi-Fi: where the phone is
  if (/^(en|eth|em|usb)/.test(name)) return 1; // wired, but the router usually bridges it to Wi-Fi
  if (VPN_IFACE.test(name)) return 3;
  return 2;
}

/** Private (RFC 1918) addresses first within a rank: they are what a home / office LAN uses. */
const isPrivate = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);

/**
 * IPv4 addresses the phone could reach over Wi-Fi, best guess first:
 * Wi-Fi interfaces, then wired, then the rest, VPNs last. Container bridges
 * and link-local addresses are left out.
 */
export function lanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): LanAddress[] {
  const out: (LanAddress & { rank: number })[] = [];
  for (const [iface, list] of Object.entries(ifaces)) {
    if (VIRTUAL_IFACE.test(iface)) continue;
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      out.push({ address: a.address, iface, rank: ifaceRank(iface) * 2 + (isPrivate(a.address) ? 0 : 1) });
    }
  }
  // Stable: keep the OS order within a rank.
  return out.sort((a, b) => a.rank - b.rank).map(({ address, iface }) => ({ address, iface }));
}

export interface PadUrlOptions {
  /** HTTPS port for LAN links (when a certificate is configured). */
  httpsPort?: number;
  /** PEM certificate: LAN addresses it doesn't cover get a warning. */
  cert?: X509Certificate | null;
}

export function padUrls(port: number, token: string, hosts: LanAddress[] = lanAddresses(), opts: PadUrlOptions = {}): PadUrls {
  const secure = opts.httpsPort !== undefined;
  return {
    // Loopback (adb reverse) is trusted, so the USB URL needs no token.
    usb: `http://localhost:${port}/pad`,
    lan: hosts.map((h): PadLink => {
      const link: PadLink = {
        url: secure ? `https://${h.address}:${opts.httpsPort}/pad?token=${token}` : `http://${h.address}:${port}/pad?token=${token}`,
        iface: h.iface,
        secure,
      };
      if (secure && opts.cert && !certCovers(opts.cert, h.address)) {
        link.warning = `certificate does not cover ${h.address} — re-run \`note-taker mkcert\``;
      }
      return link;
    }),
  };
}

/** Does the certificate list this IP address (or a matching name) in its SANs? */
export function certCovers(cert: X509Certificate, ip: string): boolean {
  try {
    return cert.checkIP(ip) !== undefined;
  } catch {
    return false;
  }
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
