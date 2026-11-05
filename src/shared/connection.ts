// Browser-side WebSocket client shared by the pad and the viewer:
// handshake, auto-reconnect with backoff, ping/pong RTT, token + device id.

import {
  CloseCode,
  PROTOCOL_VERSION,
  WS_PATH,
  encode,
  type ClientMsg,
  type Role,
  type ServerMsg,
} from "./protocol.ts";

export type ConnStatus = "connecting" | "open" | "closed" | "unauthorized" | "outdated";

export interface ConnectionEvents {
  onMessage?: (msg: ServerMsg) => void;
  onStatus?: (status: ConnStatus, detail?: string) => void;
  onRtt?: (rtt: number) => void;
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode / blocked storage — fine, just not remembered
  }
}

/** Token from `?token=` (remembered so a PWA launch without the query still works). */
export function resolveToken(): string | null {
  const fromUrl = new URLSearchParams(location.search).get("token");
  if (fromUrl) {
    storageSet("note-taker.token", fromUrl);
    return fromUrl;
  }
  return storageGet("note-taker.token");
}

export function deviceId(): string {
  let id = storageGet("note-taker.deviceId");
  if (!id) {
    id = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
    storageSet("note-taker.deviceId", id);
  }
  return id;
}

export class Connection {
  status: ConnStatus = "connecting";
  rtt: number | null = null;
  private ws: WebSocket | null = null;
  private retryMs = 250;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly role: Role,
    private readonly events: ConnectionEvents = {},
  ) {
    this.connect();
    // Reconnect immediately when the phone wakes up / tab becomes visible.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.status !== "open") this.reconnectNow();
    });
    window.addEventListener("online", () => this.reconnectNow());
  }

  send(msg: ClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(encode(msg));
    return true;
  }

  private connect(): void {
    this.setStatus("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(
        encode({ type: "hello", role: this.role, token: resolveToken(), deviceId: deviceId(), protocol: PROTOCOL_VERSION }),
      );
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      switch (msg.type) {
        case "welcome":
          this.retryMs = 250;
          this.setStatus("open");
          this.startPinging();
          break;
        case "ping":
          this.send({ type: "pong", t: msg.t });
          break;
        case "pong":
          this.rtt = Math.round((performance.now() - msg.t) * 10) / 10;
          this.events.onRtt?.(this.rtt);
          break;
      }
      this.events.onMessage?.(msg);
    };

    ws.onclose = (ev) => {
      this.stopPinging();
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === CloseCode.badToken) {
        this.setStatus("unauthorized", "Wrong or missing token — open the link from the PC (QR / URL with ?token=)");
        this.scheduleRetry(5000);
      } else if (ev.code === CloseCode.badProtocol) {
        this.setStatus("outdated", "Server was updated — reload this page");
      } else {
        this.setStatus("closed");
        this.scheduleRetry(this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 2000);
      }
    };
  }

  private reconnectNow(): void {
    if (this.status === "outdated") return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.connect();
  }

  private scheduleRetry(ms: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, ms);
  }

  private startPinging(): void {
    this.stopPinging();
    const ping = () => this.send({ type: "ping", t: performance.now() });
    ping();
    this.pingTimer = setInterval(ping, 2000);
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private setStatus(status: ConnStatus, detail?: string): void {
    this.status = status;
    this.events.onStatus?.(status, detail);
  }
}
