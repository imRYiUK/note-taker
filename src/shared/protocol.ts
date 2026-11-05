// Wire protocol shared by server, pad (phone) and viewer (PC).
// JSON over WebSocket. See PLAN.md §4. M0 covers the handshake, liveness and
// device management; stroke messages arrive in M1.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7777;
export const WS_PATH = "/ws";

export type Role = "pad" | "viewer";
/** How a client reaches the server. Loopback pads come through `adb reverse`. */
export type Transport = "usb" | "local" | "lan";

export interface ClientInfo {
  id: string;
  role: Role;
  deviceId: string;
  userAgent: string;
  transport: Transport;
  connectedAt: number;
  /** Round-trip time measured by the server, ms. */
  rtt: number | null;
}

export interface AdbDevice {
  serial: string;
  state: string; // "device" | "unauthorized" | "offline" | ...
  model: string | null;
  reversed: boolean;
}

export interface PadUrls {
  usb: string;
  lan: string[];
}

// ---------------------------------------------------------------- client → server

export type ClientMsg =
  | { type: "hello"; role: Role; token: string | null; deviceId: string; protocol: number }
  | { type: "ping"; t: number }
  | { type: "pong"; t: number }
  | { type: "adb.open"; serial: string; page: "pad" | "probe" };

// ---------------------------------------------------------------- server → client

export type ServerMsg =
  | { type: "welcome"; clientId: string; protocol: number; serverTime: number; padUrls: PadUrls }
  | { type: "clients"; clients: ClientInfo[] }
  | { type: "devices"; devices: AdbDevice[]; adbAvailable: boolean }
  | { type: "ping"; t: number }
  | { type: "pong"; t: number }
  /** A capability report posted by /probe (sent to viewers). */
  | { type: "probe.report"; file: string; report: unknown }
  | { type: "error"; code: ErrorCode; message: string };

export type ErrorCode =
  | "bad_message"
  | "bad_token"
  | "bad_protocol"
  | "not_ready"
  | "hello_timeout"
  | "adb_failed";

/** Close codes used by the server (4000–4999 is the application range). */
export const CloseCode = {
  badToken: 4001,
  badProtocol: 4002,
  helloTimeout: 4003,
} as const;

// ---------------------------------------------------------------- validation

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 256): v is string => typeof v === "string" && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Parse and validate a message from a client. Returns null when invalid. */
export function parseClientMsg(raw: string | Buffer): ClientMsg | null {
  let v: unknown;
  try {
    v = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!isObj(v) || !isStr(v.type, 64)) return null;

  switch (v.type) {
    case "hello":
      if (v.role !== "pad" && v.role !== "viewer") return null;
      if (!(v.token === null || v.token === undefined || isStr(v.token))) return null;
      if (!isStr(v.deviceId, 128) || !isNum(v.protocol)) return null;
      return {
        type: "hello",
        role: v.role,
        token: (v.token as string | null | undefined) ?? null,
        deviceId: v.deviceId,
        protocol: v.protocol,
      };
    case "ping":
    case "pong":
      return isNum(v.t) ? { type: v.type, t: v.t } : null;
    case "adb.open":
      if (!isStr(v.serial, 128) || (v.page !== "pad" && v.page !== "probe")) return null;
      return { type: "adb.open", serial: v.serial, page: v.page };
    default:
      return null;
  }
}

export function encode(msg: ServerMsg | ClientMsg): string {
  return JSON.stringify(msg);
}
