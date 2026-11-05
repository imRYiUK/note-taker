// Browser-side WebSocket client shared by the pad and the viewer:
// handshake, auto-reconnect with backoff, ping/pong RTT, token + device id,
// and an estimate of the server clock (for the latency HUD).

import {
  CloseCode,
  PROTOCOL_VERSION,
  WS_PATH,
  encode,
  type ClientMsg,
  type Role,
  type ServerMsg,
} from "./protocol.ts";

/** The server pings every 2 s; this much silence means the socket is dead (e.g. Wi-Fi dropped). */
const SILENCE_MS = 6000;

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

/** Random id. `crypto.randomUUID` only exists in secure contexts (not plain-http Wi-Fi). */
export function uid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function deviceId(): string {
  let id = storageGet("note-taker.deviceId");
  if (!id) {
    id = uid();
    storageSet("note-taker.deviceId", id);
  }
  return id;
}

/** Clock-sync samples kept; the one with the lowest RTT wins (least queueing → least error). */
const CLOCK_SAMPLES = 10;

export class Connection {
  status: ConnStatus = "connecting";
  rtt: number | null = null;
  private clock: { rtt: number; offset: number }[] = [];
  private ws: WebSocket | null = null;
  private retryMs = 250;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageAt = 0;

  constructor(
    private readonly role: Role,
    private readonly events: ConnectionEvents = {},
  ) {
    this.connect();
    // Reconnect immediately when the phone wakes up / tab becomes visible.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      // Timers were throttled while hidden: give the socket a fresh grace period.
      this.lastMessageAt = performance.now();
      if (this.status !== "open") this.reconnectNow();
    });
    window.addEventListener("online", () => this.reconnectNow());
  }

  /** A `performance.now()`-based time (e.g. an event's `timeStamp`) on the server clock; null until synced. */
  serverTime(perf: number = performance.now()): number | null {
    let best: { rtt: number; offset: number } | null = null;
    for (const c of this.clock) if (!best || c.rtt < best.rtt) best = c;
    return best ? perf + best.offset : null;
  }

  /** Worst-case error of `serverTime`, ms (half the best RTT); null until synced. */
  get clockError(): number | null {
    return this.clock.length ? Math.min(...this.clock.map((c) => c.rtt)) / 2 : null;
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
      this.lastMessageAt = performance.now();
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
        case "pong": {
          const rtt = performance.now() - msg.t;
          this.rtt = Math.round(rtt * 10) / 10;
          if (typeof msg.serverTime === "number") {
            // The server answered about half-way through the round trip.
            this.clock.push({ rtt, offset: msg.serverTime - (msg.t + rtt / 2) });
            if (this.clock.length > CLOCK_SAMPLES) this.clock.shift();
          }
          this.events.onRtt?.(this.rtt);
          break;
        }
      }
      this.events.onMessage?.(msg);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return; // an abandoned socket (see dropDead)
      this.stopPinging();
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
    this.lastMessageAt = performance.now();
    const ping = () => {
      if (document.visibilityState === "visible" && performance.now() - this.lastMessageAt > SILENCE_MS) {
        this.dropDead();
        return;
      }
      this.send({ type: "ping", t: performance.now() });
    };
    ping();
    this.pingTimer = setInterval(ping, 2000);
  }

  /**
   * The socket went silent. Closing a dead TCP connection can take a long
   * time to report, so abandon it and reconnect right away.
   */
  private dropDead(): void {
    const ws = this.ws;
    if (!ws) return;
    this.stopPinging();
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = null;
    try {
      ws.close();
    } catch {
      // already closing
    }
    this.setStatus("closed", "connection lost");
    this.connect();
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
