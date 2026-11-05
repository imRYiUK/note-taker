import type { ServerWebSocket } from "bun";
import {
  CloseCode,
  PROTOCOL_VERSION,
  encode,
  parseClientMsg,
  type ClientInfo,
  type ClientMsg,
  type PadUrls,
  type ServerMsg,
  type Viewport,
} from "../shared/protocol.ts";
import type { InkSettings } from "../shared/ink.ts";
import { authorize } from "./net.ts";
import type { AdbWatcher } from "./adb.ts";
import type { Change, Notebook } from "./notebook.ts";

export interface WsData {
  id: string;
  ip: string;
  loopback: boolean;
  userAgent: string;
  info: ClientInfo | null; // set after a valid hello
  helloTimer: ReturnType<typeof setTimeout> | null;
}

type Ws = ServerWebSocket<WsData>;

export interface HubOptions {
  token: string;
  padUrls: () => PadUrls;
  /** URL the phone should open for a page, as reached over USB. */
  usbUrl: (page: "pad" | "probe") => string;
  adb: AdbWatcher | null;
  log: (msg: string) => void;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
  notebook: Notebook;
  ink: InkSettings;
  /** Called after ink settings change (to persist them). */
  onInkChange?: (ink: InkSettings) => void;
}

/** Connection registry and message router. */
export class Hub {
  private readonly sockets = new Set<Ws>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  readonly notebook: Notebook;
  ink: InkSettings;
  /** Where the pad's strip is (memory only: the pad also remembers it). */
  viewport: Viewport | null = null;

  constructor(private readonly opts: HubOptions) {
    this.notebook = opts.notebook;
    this.ink = opts.ink;
    this.pingTimer = setInterval(() => this.pingAll(), opts.pingIntervalMs ?? 2000);
  }

  dispose(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
  }

  // ------------------------------------------------------------- lifecycle

  open(ws: Ws): void {
    this.sockets.add(ws);
    ws.data.helloTimer = setTimeout(() => {
      this.send(ws, { type: "error", code: "hello_timeout", message: "no hello received" });
      ws.close(CloseCode.helloTimeout, "hello timeout");
    }, this.opts.helloTimeoutMs ?? 5000);
  }

  close(ws: Ws): void {
    this.sockets.delete(ws);
    if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
    if (ws.data.info) {
      for (const id of this.notebook.dropLive(ws.data.id)) this.toViewers({ type: "stroke.cancel", id });
      this.opts.log(`${ws.data.info.role} disconnected (${ws.data.info.transport}, ${ws.data.ip})`);
      this.broadcastClients();
    }
  }

  message(ws: Ws, raw: string | Buffer): void {
    const msg = parseClientMsg(raw);
    if (!msg) {
      this.send(ws, { type: "error", code: "bad_message", message: "invalid message" });
      return;
    }
    if (msg.type === "hello") return this.hello(ws, msg);
    if (!ws.data.info) {
      this.send(ws, { type: "error", code: "not_ready", message: "send hello first" });
      return;
    }

    switch (msg.type) {
      case "ping":
        this.send(ws, { type: "pong", t: msg.t });
        break;
      case "pong":
        ws.data.info.rtt = Math.max(0, Math.round((performance.now() - msg.t) * 10) / 10);
        break;
      case "adb.open":
        void this.adbOpen(ws, msg);
        break;
      case "stroke.begin":
      case "stroke.points":
      case "stroke.end":
      case "stroke.cancel":
        if (ws.data.info.role !== "pad") {
          this.send(ws, { type: "error", code: "forbidden", message: "only pads draw" });
          break;
        }
        this.stroke(ws, msg);
        break;
      case "erase":
        this.applyChange(ws, this.notebook.erase(msg.pageId, msg.strokeIds, msg.group), msg.pageId);
        break;
      case "page.clear": {
        const change = this.notebook.clear(msg.pageId);
        if (change?.removed) this.opts.log(`page cleared (${change.removed.ids.length} strokes)`);
        this.applyChange(ws, change, msg.pageId);
        break;
      }
      case "undo":
      case "redo": {
        const change = msg.type === "undo" ? this.notebook.undo() : this.notebook.redo();
        if (change) this.applyChange(ws, change);
        break;
      }
      case "viewport":
        if (msg.pageId !== this.notebook.page.id) {
          this.send(ws, { type: "error", code: "unknown_page", message: `no page ${msg.pageId}` });
          break;
        }
        this.viewport = { pageId: msg.pageId, rect: msg.rect };
        this.broadcast({ type: "viewport", ...this.viewport }, ws);
        break;
      case "settings.set":
        this.ink = { ...this.ink, ...msg.ink };
        this.broadcast({ type: "settings", ink: this.ink });
        this.opts.onInkChange?.(this.ink);
        break;
    }
  }

  private stroke(
    ws: Ws,
    msg: Extract<ClientMsg, { type: "stroke.begin" | "stroke.points" | "stroke.end" | "stroke.cancel" }>,
  ): void {
    const nb = this.notebook;
    const owner = ws.data.id;
    switch (msg.type) {
      case "stroke.begin": {
        const res = nb.begin(owner, msg);
        if (res === "ok") this.toViewers(msg);
        else if (res === "duplicate") this.send(ws, { type: "stroke.ack", id: msg.id });
        else {
          this.send(ws, { type: "error", code: "unknown_page", message: `no page ${msg.pageId}` });
          // The pad is out of date — give it the current page; it drops the stroke from its outbox.
          this.send(ws, { type: "stroke.ack", id: msg.id });
          this.send(ws, this.snapshot());
        }
        break;
      }
      case "stroke.points":
        if (nb.points(owner, msg.id, msg.pts)) this.toViewers(msg);
        break;
      case "stroke.end": {
        const res = nb.end(owner, msg.id, msg.n);
        if (!res) {
          this.toViewers({ type: "stroke.cancel", id: msg.id });
        } else if (res.kind === "duplicate") {
          this.send(ws, { type: "stroke.ack", id: msg.id });
        } else if (res.kind === "resync") {
          this.opts.log(`stroke ${msg.id}: ${res.missing} point(s) missing — asking for a resend`);
          this.toViewers({ type: "stroke.cancel", id: msg.id });
          this.send(ws, { type: "stroke.resync", id: msg.id });
        } else {
          this.send(ws, { type: "stroke.ack", id: msg.id });
          this.broadcast({ type: "stroke.added", stroke: res.stroke }, ws);
          this.broadcast({ type: "history", ...nb.history() });
        }
        break;
      }
      case "stroke.cancel":
        if (nb.cancel(owner, msg.id)) this.toViewers(msg);
        break;
    }
  }

  /** Broadcast the effect of an erase / undo / redo. */
  private applyChange(ws: Ws, change: Change | null, pageId?: string): void {
    if (!change) {
      if (pageId && pageId !== this.notebook.page.id) {
        this.send(ws, { type: "error", code: "unknown_page", message: `no page ${pageId}` });
      }
      return;
    }
    if (change.removed) this.broadcast({ type: "strokes.removed", ...change.removed });
    if (change.restored.length) this.broadcast({ type: "strokes.restored", strokes: change.restored });
    this.broadcast({ type: "history", ...this.notebook.history() });
  }

  private hello(ws: Ws, msg: Extract<ClientMsg, { type: "hello" }>): void {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.send(ws, {
        type: "error",
        code: "bad_protocol",
        message: `server speaks protocol ${PROTOCOL_VERSION}, client ${msg.protocol} — reload the page`,
      });
      ws.close(CloseCode.badProtocol, "protocol mismatch");
      return;
    }
    if (!authorize(ws.data.loopback, msg.token, this.opts.token)) {
      this.opts.log(`rejected ${msg.role} from ${ws.data.ip}: bad token`);
      this.send(ws, { type: "error", code: "bad_token", message: "missing or wrong token" });
      ws.close(CloseCode.badToken, "bad token");
      return;
    }

    if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
    ws.data.helloTimer = null;
    const transport = !ws.data.loopback ? "lan" : msg.role === "pad" ? "usb" : "local";
    ws.data.info = {
      id: ws.data.id,
      role: msg.role,
      deviceId: msg.deviceId,
      userAgent: ws.data.userAgent,
      transport,
      connectedAt: Date.now(),
      rtt: null,
    };
    this.opts.log(`${msg.role} connected (${transport}, ${ws.data.ip})`);

    this.send(ws, {
      type: "welcome",
      clientId: ws.data.id,
      protocol: PROTOCOL_VERSION,
      serverTime: Date.now(),
      padUrls: this.opts.padUrls(),
    });
    this.send(ws, { type: "settings", ink: this.ink });
    this.send(ws, this.snapshot());
    this.send(ws, { type: "history", ...this.notebook.history() });
    if (msg.role === "viewer") {
      this.sendDevices(ws);
    }
    this.broadcastClients();
  }

  private async adbOpen(ws: Ws, msg: Extract<ClientMsg, { type: "adb.open" }>): Promise<void> {
    if (ws.data.info?.role !== "viewer" || !ws.data.loopback) return;
    const adb = this.opts.adb;
    const ok = adb ? await adb.openUrl(msg.serial, this.opts.usbUrl(msg.page)) : false;
    if (!ok) {
      this.send(ws, { type: "error", code: "adb_failed", message: `could not open ${msg.page} on ${msg.serial}` });
    }
  }

  // ------------------------------------------------------------- broadcasting

  clients(): ClientInfo[] {
    return [...this.sockets].flatMap((s) => (s.data.info ? [s.data.info] : []));
  }

  broadcastClients(): void {
    this.toViewers({ type: "clients", clients: this.clients() });
  }

  broadcastDevices(): void {
    for (const ws of this.viewers()) this.sendDevices(ws);
  }

  /** Send to every client that completed the handshake, optionally skipping one. */
  broadcast(msg: ServerMsg, except?: Ws): void {
    const data = encode(msg);
    for (const ws of this.sockets) if (ws.data.info && ws !== except) ws.send(data);
  }

  toViewers(msg: ServerMsg): void {
    const data = encode(msg);
    for (const ws of this.viewers()) ws.send(data);
  }

  private sendDevices(ws: Ws): void {
    const adb = this.opts.adb;
    this.send(ws, { type: "devices", devices: adb?.devices ?? [], adbAvailable: adb?.available ?? false });
  }

  private *viewers(): Generator<Ws> {
    for (const ws of this.sockets) if (ws.data.info?.role === "viewer") yield ws;
  }

  private pingAll(): void {
    const ping = encode({ type: "ping", t: performance.now() });
    for (const ws of this.sockets) if (ws.data.info) ws.send(ping);
    // Viewers get a fresh client list (with RTTs) on the same cadence.
    if (this.sockets.size) this.broadcastClients();
  }

  private snapshot(): ServerMsg {
    const vp = this.viewport?.pageId === this.notebook.page.id ? this.viewport : null;
    return { type: "snapshot", ...this.notebook.snapshot(), viewport: vp };
  }

  private send(ws: Ws, msg: ServerMsg): void {
    ws.send(encode(msg));
  }
}
