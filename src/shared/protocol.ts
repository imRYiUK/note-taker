// Wire protocol shared by server, pad (phone) and viewer (PC).
// JSON over WebSocket. See PLAN.md §4. M0: handshake, liveness, device
// management. M1: live strokes, page snapshot, ink settings. M2: stroke acks
// (pad outbox), erase, undo/redo.

import { POINT_STRIDE, parseInkPatch, type InkSettings } from "./ink.ts";

export const PROTOCOL_VERSION = 3; // 2: M1 strokes, snapshot, settings · 3: M2 acks, erase, undo
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

export type Tool = "pen" | "highlighter";

export interface PageInfo {
  id: string;
  width: number;
  height: number;
}

/** A finished stroke. `pts` is flat `[x, y, rawPressure, t, ...]` in page units / ms since start. */
export interface StrokeData {
  id: string;
  pageId: string;
  tool: Tool;
  color: string;
  width: number;
  pts: number[];
  createdAt: number;
}

/** Upper bounds that keep a misbehaving client from exhausting memory. */
export const LIMITS = {
  pointsPerMessage: 4096,
  pointsPerStroke: 100_000,
  idsPerMessage: 5000,
} as const;

/** Whether undo / redo would do anything right now. */
export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

// ---------------------------------------------------------------- client → server

export type StrokeBeginMsg = { type: "stroke.begin"; id: string; pageId: string; tool: Tool; color: string; width: number };
export type StrokePointsMsg = { type: "stroke.points"; id: string; pts: number[] };
export type StrokeCancelMsg = { type: "stroke.cancel"; id: string };

export type ClientMsg =
  | { type: "hello"; role: Role; token: string | null; deviceId: string; protocol: number }
  | { type: "ping"; t: number }
  | { type: "pong"; t: number }
  | { type: "adb.open"; serial: string; page: "pad" | "probe" }
  | StrokeBeginMsg
  | StrokePointsMsg
  /** `n` = total point count the pad sent, so the server can detect gaps. */
  | { type: "stroke.end"; id: string; n: number }
  | StrokeCancelMsg
  /** Erase whole strokes. Messages with the same `group` (one eraser gesture) merge into one undo step. */
  | { type: "erase"; pageId: string; strokeIds: string[]; group?: string }
  | { type: "undo" }
  | { type: "redo" }
  /** Erase every stroke on the page (one undo step). */
  | { type: "page.clear"; pageId: string }
  | { type: "settings.set"; ink: Partial<InkSettings> };

// ---------------------------------------------------------------- server → client

export type ServerMsg =
  | { type: "welcome"; clientId: string; protocol: number; serverTime: number; padUrls: PadUrls }
  | { type: "clients"; clients: ClientInfo[] }
  | { type: "devices"; devices: AdbDevice[]; adbAvailable: boolean }
  | { type: "ping"; t: number }
  | { type: "pong"; t: number }
  /** A capability report posted by /probe (sent to viewers). */
  | { type: "probe.report"; file: string; report: unknown }
  /** Full state of the active page; sent after welcome and whenever it is replaced. */
  | { type: "snapshot"; page: PageInfo; strokes: StrokeData[] }
  /** Live stroke traffic from a pad, forwarded to viewers. */
  | StrokeBeginMsg
  | StrokePointsMsg
  | StrokeCancelMsg
  /** A stroke was committed (sent to everyone except the pad that drew it). */
  | { type: "stroke.added"; stroke: StrokeData }
  /** To the drawing pad: the stroke is stored (or was already) — drop it from the outbox. */
  | { type: "stroke.ack"; id: string }
  /** To the drawing pad: points went missing — send the whole stroke again. */
  | { type: "stroke.resync"; id: string }
  /** Strokes erased or undone. */
  | { type: "strokes.removed"; pageId: string; ids: string[] }
  /** Strokes brought back by undo / redo. */
  | { type: "strokes.restored"; strokes: StrokeData[] }
  | ({ type: "history" } & HistoryState)
  | { type: "settings"; ink: InkSettings }
  | { type: "error"; code: ErrorCode; message: string };

export type ErrorCode =
  | "bad_message"
  | "bad_token"
  | "bad_protocol"
  | "not_ready"
  | "hello_timeout"
  | "adb_failed"
  | "forbidden"
  | "unknown_page";

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
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;
const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

function isIdArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= LIMITS.idsPerMessage && v.every(isId);
}

function isPointArray(v: unknown): v is number[] {
  if (!Array.isArray(v) || v.length % POINT_STRIDE !== 0) return false;
  if (v.length > LIMITS.pointsPerMessage * POINT_STRIDE) return false;
  for (const n of v) if (!isNum(n)) return false;
  return true;
}

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
    case "stroke.begin":
      if (!isId(v.id) || !isId(v.pageId) || (v.tool !== "pen" && v.tool !== "highlighter")) return null;
      if (!isColor(v.color) || !isNum(v.width) || v.width <= 0 || v.width > 500) return null;
      return { type: "stroke.begin", id: v.id, pageId: v.pageId, tool: v.tool, color: v.color, width: v.width };
    case "stroke.points":
      if (!isId(v.id) || !isPointArray(v.pts)) return null;
      return { type: "stroke.points", id: v.id, pts: v.pts };
    case "stroke.end":
      if (!isId(v.id) || !Number.isInteger(v.n) || (v.n as number) < 0) return null;
      return { type: "stroke.end", id: v.id, n: v.n as number };
    case "stroke.cancel":
      return isId(v.id) ? { type: "stroke.cancel", id: v.id } : null;
    case "erase":
      if (!isId(v.pageId) || !isIdArray(v.strokeIds)) return null;
      if (v.group !== undefined && !isId(v.group)) return null;
      return {
        type: "erase",
        pageId: v.pageId,
        strokeIds: v.strokeIds,
        ...(v.group !== undefined ? { group: v.group as string } : {}),
      };
    case "undo":
    case "redo":
      return { type: v.type };
    case "page.clear":
      return isId(v.pageId) ? { type: "page.clear", pageId: v.pageId } : null;
    case "settings.set": {
      const ink = parseInkPatch(v.ink);
      return ink ? { type: "settings.set", ink } : null;
    }
    default:
      return null;
  }
}

export function encode(msg: ServerMsg | ClientMsg): string {
  return JSON.stringify(msg);
}
