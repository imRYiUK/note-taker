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
} from "../shared/protocol.ts";
import { authorize } from "./net.ts";
import type { AdbWatcher } from "./adb.ts";

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
}

/** Connection registry and message router. */
export class Hub {
  private readonly sockets = new Set<Ws>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: HubOptions) {
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
    }
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

  private send(ws: Ws, msg: ServerMsg): void {
    ws.send(encode(msg));
  }
}
