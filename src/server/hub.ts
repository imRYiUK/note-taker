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
import type { Change, Library } from "./notebook.ts";

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
  library: Library;
  ink: InkSettings;
  /** Called after ink settings change (to persist them). */
  onInkChange?: (ink: InkSettings) => void;
}

/** Connection registry and message router. */
export class Hub {
  private readonly sockets = new Set<Ws>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  readonly library: Library;
  ink: InkSettings;
  /** Where the pad's strip is (memory only: the pad also remembers it). */
  viewport: Viewport | null = null;

  constructor(private readonly opts: HubOptions) {
    this.library = opts.library;
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
      for (const id of this.library.dropLive(ws.data.id)) this.toViewers({ type: "stroke.cancel", id });
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
        this.applyChange(ws, this.library.erase(msg.pageId, msg.strokeIds, msg.group), msg.pageId);
        break;
      case "page.goto":
        if (!this.library.goto(msg.pageId)) this.unknownPage(ws, msg.pageId);
        else this.pageChanged();
        break;
      case "page.new":
        if (!this.library.newPage(msg.afterPageId)) {
          this.send(ws, { type: "error", code: "not_allowed", message: "could not add a page" });
          break;
        }
        this.pageChanged(true);
        break;
      case "page.delete": {
        if (!this.viewerOnly(ws)) break;
        const res = this.library.deletePage(msg.pageId);
        if (!res.ok) {
          if (!this.library.hasPage(msg.pageId)) this.unknownPage(ws, msg.pageId);
          else this.send(ws, { type: "error", code: "not_allowed", message: "a notebook needs at least one page" });
          break;
        }
        if (res.switched) this.pageChanged(true);
        else this.structureChanged();
        break;
      }
      case "notebook.open":
        if (!this.viewerOnly(ws)) break;
        if (!this.library.openNotebook(msg.id)) this.unknownNotebook(ws, msg.id);
        else this.pageChanged();
        break;
      case "notebook.new":
        if (!this.viewerOnly(ws)) break;
        this.library.newNotebook(msg.title, msg.template, msg.kind);
        this.opts.log(`notebook created: ${msg.title}`);
        this.pageChanged(true);
        break;
      case "notebook.update":
        if (!this.viewerOnly(ws)) break;
        if (!this.library.updateNotebook(msg.id, msg)) this.unknownNotebook(ws, msg.id);
        else this.structureChanged();
        break;
      case "notebook.delete": {
        if (!this.viewerOnly(ws)) break;
        const res = this.library.deleteNotebook(msg.id);
        if (!res.ok) this.unknownNotebook(ws, msg.id);
        else if (res.switched) this.pageChanged(true);
        else this.broadcastNotebooks();
        break;
      }
      case "page.clear": {
        const change = this.library.clear(msg.pageId);
        if (change?.removed) this.opts.log(`page cleared (${change.removed.ids.length} strokes)`);
        this.applyChange(ws, change, msg.pageId);
        break;
      }
      case "undo":
      case "redo": {
        const change = msg.type === "undo" ? this.library.undo() : this.library.redo();
        if (!change) break;
        // A step on another page of the notebook: go there, so you see what changed.
        if (change.pageId !== this.library.page.id && this.library.goto(change.pageId)) this.pageChanged();
        else this.applyChange(ws, change);
        break;
      }
      case "viewport":
        // Only the current page has a strip; a pad that hasn't caught up yet is ignored.
        if (msg.pageId !== this.library.page.id) {
          if (!this.library.hasPage(msg.pageId)) this.unknownPage(ws, msg.pageId);
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
    const nb = this.library;
    const owner = ws.data.id;
    switch (msg.type) {
      case "stroke.begin": {
        const res = nb.begin(owner, msg);
        if (res === "ok") this.toViewers(msg);
        else if (res === "duplicate") this.send(ws, { type: "stroke.ack", id: msg.id });
        else {
          this.unknownPage(ws, msg.pageId);
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
        } else if (res.kind === "gone") {
          this.toViewers({ type: "stroke.cancel", id: msg.id });
          this.send(ws, { type: "stroke.ack", id: msg.id });
        } else {
          this.send(ws, { type: "stroke.ack", id: msg.id });
          this.broadcast({ type: "stroke.added", stroke: res.stroke }, ws);
          this.broadcast({ type: "history", ...nb.history() });
          if (res.grown?.notebookId === nb.notebook.id) this.broadcast({ type: "notebook.state", ...nb.state() });
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
      if (pageId && !this.library.hasPage(pageId)) this.unknownPage(ws, pageId);
      return;
    }
    if (change.removed) this.broadcast({ type: "strokes.removed", ...change.removed });
    if (change.restored.length) this.broadcast({ type: "strokes.restored", strokes: change.restored });
    this.broadcast({ type: "history", ...this.library.history() });
  }

  /** Another page became current: everyone gets its snapshot. `list`: the notebook list changed too. */
  private pageChanged(list = false): void {
    this.broadcast(this.snapshot());
    this.broadcast({ type: "history", ...this.library.history() });
    if (list) this.broadcastNotebooks();
  }

  /** The current notebook's title / template / pages changed (or another notebook's). */
  private structureChanged(): void {
    this.broadcast({ type: "notebook.state", ...this.library.state() });
    this.broadcast({ type: "history", ...this.library.history() });
    this.broadcastNotebooks();
  }

  broadcastNotebooks(): void {
    this.toViewers({ type: "notebooks", notebooks: this.library.notebooks() });
  }

  private viewerOnly(ws: Ws): boolean {
    if (ws.data.info?.role === "viewer") return true;
    this.send(ws, { type: "error", code: "forbidden", message: "only the viewer manages notebooks" });
    return false;
  }

  private unknownPage(ws: Ws, pageId: string): void {
    this.send(ws, { type: "error", code: "unknown_page", message: `no page ${pageId}` });
  }

  private unknownNotebook(ws: Ws, id: string): void {
    this.send(ws, { type: "error", code: "unknown_notebook", message: `no notebook ${id}` });
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
    this.send(ws, { type: "history", ...this.library.history() });
    if (msg.role === "viewer") {
      this.send(ws, { type: "notebooks", notebooks: this.library.notebooks() });
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
    const vp = this.viewport?.pageId === this.library.page.id ? this.viewport : null;
    return { type: "snapshot", ...this.library.snapshot(), viewport: vp };
  }

  private send(ws: Ws, msg: ServerMsg): void {
    ws.send(encode(msg));
  }
}
