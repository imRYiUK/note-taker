import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/main.ts";
import { lanAddresses } from "../src/server/net.ts";
import { CloseCode, PROTOCOL_VERSION, type ServerMsg } from "../src/shared/protocol.ts";
import { DEFAULT_INK, type InkSettings } from "../src/shared/ink.ts";

const TOKEN = "test-token-0123456789";
let app: ReturnType<typeof startServer>;
let dataDir: string;
const savedInk: InkSettings[] = [];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "note-taker-test-"));
  app = startServer({ port: 0, token: TOKEN, adb: false, dataDir, log: () => {}, helloTimeoutMs: 300,
    onInkChange: (ink) => savedInk.push(ink),
  });
});

afterAll(async () => {
  await app.stop();
  await rm(dataDir, { recursive: true, force: true });
});

/** Minimal test client that queues incoming messages. */
async function client(host = "localhost", port = app.port) {
  const ws = new WebSocket(`ws://${host}:${port}/ws`);
  const queue: ServerMsg[] = [];
  const waiters: ((m: ServerMsg) => void)[] = [];
  let closed: { code: number } | null = null;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string) as ServerMsg;
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  };
  ws.onclose = (ev) => (closed = { code: ev.code });
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws error"));
  });

  const next = (): Promise<ServerMsg> =>
    queue.length ? Promise.resolve(queue.shift()!) : new Promise((res) => waiters.push(res));

  return {
    ws,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    next,
    /** Wait for the next message of a given type, skipping others (pings, client lists). */
    async expect<T extends ServerMsg["type"]>(type: T, timeoutMs = 1500): Promise<Extract<ServerMsg, { type: T }>> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const m = await Promise.race([next(), Bun.sleep(deadline - Date.now()).then(() => null)]);
        if (m?.type === type) return m as Extract<ServerMsg, { type: T }>;
      }
      throw new Error(`timed out waiting for ${type}`);
    },
    closed: async () => {
      for (let i = 0; i < 50 && !closed; i++) await Bun.sleep(20);
      return closed;
    },
  };
}

const hello = (role: "pad" | "viewer", token: string | null = null) => ({
  type: "hello",
  role,
  token,
  deviceId: `${role}-device`,
  protocol: PROTOCOL_VERSION,
});

describe("server", () => {
  test("health endpoint", async () => {
    const res = await fetch(`${app.url}/api/health`);
    expect(await res.json()).toMatchObject({ ok: true, name: "note-taker" });
  });

  test("serves the pad, viewer and probe pages", async () => {
    for (const page of ["pad", "viewer", "probe"]) {
      const res = await fetch(`${app.url}/${page}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<html");
    }
  });

  test("loopback pad handshake without token, viewer sees it", async () => {
    const viewer = await client();
    viewer.send(hello("viewer"));
    const welcome = await viewer.expect("welcome");
    expect(welcome.protocol).toBe(PROTOCOL_VERSION);
    expect(welcome.padUrls.usb).toBe(`http://localhost:${app.port}/pad`);
    for (const l of welcome.padUrls.lan) expect(l.url).toEndWith(`/pad?token=${TOKEN}`);
    await viewer.expect("devices");

    const pad = await client();
    pad.send(hello("pad"));
    await pad.expect("welcome");

    let clients = (await viewer.expect("clients")).clients;
    while (!clients.some((c) => c.role === "pad")) clients = (await viewer.expect("clients")).clients;
    expect(clients.find((c) => c.role === "pad")).toMatchObject({ transport: "usb", deviceId: "pad-device" });

    const before = performance.timeOrigin + performance.now();
    pad.send({ type: "ping", t: 42 });
    const pong = await pad.expect("pong");
    expect(pong.t).toBe(42);
    // Server clock for clock sync: epoch ms (same process here, so it brackets our clock).
    expect(pong.serverTime).toBeGreaterThanOrEqual(before - 1);
    expect(pong.serverTime).toBeLessThanOrEqual(performance.timeOrigin + performance.now() + 1);

    pad.ws.close();
    viewer.ws.close();
  });

  test("rejects messages before hello and invalid messages", async () => {
    const c = await client();
    c.send({ type: "ping", t: 1 });
    expect((await c.expect("error")).code).toBe("not_ready");
    c.send({ type: "garbage" });
    expect((await c.expect("error")).code).toBe("bad_message");
    c.ws.close();
  });

  test("protocol mismatch closes the connection", async () => {
    const c = await client();
    c.send({ ...hello("pad"), protocol: 999 });
    expect((await c.expect("error")).code).toBe("bad_protocol");
    expect((await c.closed())?.code).toBe(CloseCode.badProtocol);
  });

  test("hello timeout closes idle sockets", async () => {
    const c = await client();
    expect((await c.expect("error")).code).toBe("hello_timeout");
    expect((await c.closed())?.code).toBe(CloseCode.helloTimeout);
  });

  const lan = lanAddresses()[0]?.address;
  test.skipIf(!lan)("LAN clients need the token", async () => {
    const bad = await client(lan);
    bad.send(hello("pad", "wrong"));
    expect((await bad.expect("error")).code).toBe("bad_token");
    expect((await bad.closed())?.code).toBe(CloseCode.badToken);

    const good = await client(lan);
    good.send(hello("pad", TOKEN));
    expect((await good.expect("welcome")).type).toBe("welcome");
    good.ws.close();

    const res = await fetch(`http://${lan}:${app.port}/api/probe`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  test("probe report is saved and pushed to viewers", async () => {
    const viewer = await client();
    viewer.send(hello("viewer"));
    await viewer.expect("welcome");

    const report = { version: 1, pen: { detected: true } };
    const res = await fetch(`${app.url}/api/probe`, { method: "POST", body: JSON.stringify(report) });
    expect(res.status).toBe(200);
    const { file } = (await res.json()) as { file: string };
    expect(file.startsWith(join(dataDir, "probes"))).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(report);

    const pushed = await viewer.expect("probe.report");
    expect(pushed.report).toEqual(report);

    const latest = await (await fetch(`${app.url}/api/probe/latest`)).json();
    expect(latest.report).toEqual(report);
    viewer.ws.close();
  });

  test("rejects invalid probe JSON", async () => {
    const res = await fetch(`${app.url}/api/probe`, { method: "POST", body: "{nope" });
    expect(res.status).toBe(400);
  });

  test("pad strokes stream live to viewers, are acked and in the next snapshot", async () => {
    const viewer = await client();
    viewer.send(hello("viewer"));
    await viewer.expect("welcome");
    expect((await viewer.expect("settings")).ink).toEqual(DEFAULT_INK);
    const snap = await viewer.expect("snapshot");
    expect(snap.page).toMatchObject({ width: 2100, height: 2970 });
    const pageId = snap.page.id;

    const pad = await client();
    pad.send(hello("pad"));
    await pad.expect("welcome");
    expect((await pad.expect("snapshot")).page.id).toBe(pageId);

    const id = "stroke-live-1";
    pad.send({ type: "stroke.begin", id, pageId, tool: "pen", color: "#112233", width: 10 });
    expect(await viewer.expect("stroke.begin")).toMatchObject({ id, color: "#112233" });
    pad.send({ type: "stroke.points", id, pts: [10, 20, 0.3, 0, 30, 40, 0.35, 4] });
    expect((await viewer.expect("stroke.points")).pts).toEqual([10, 20, 0.3, 0, 30, 40, 0.35, 4]);
    pad.send({ type: "stroke.end", id, n: 2 });
    expect(await pad.expect("stroke.ack")).toEqual({ type: "stroke.ack", id });
    const added = await viewer.expect("stroke.added");
    expect(added.stroke).toMatchObject({ id, pageId, pts: [10, 20, 0.3, 0, 30, 40, 0.35, 4] });
    expect((await viewer.expect("history")).canUndo).toBe(true);

    // A newcomer gets the committed stroke in its snapshot.
    const late = await client();
    late.send(hello("viewer"));
    expect((await late.expect("snapshot")).strokes.map((s) => s.id)).toContain(id);

    // Viewers can't draw.
    viewer.send({ type: "stroke.begin", id: "v", pageId, tool: "pen", color: "#000000", width: 1 });
    expect((await viewer.expect("error")).code).toBe("forbidden");

    // Clear → everyone removes the strokes; undo brings them back.
    viewer.send({ type: "page.clear", pageId });
    expect((await pad.expect("strokes.removed")).ids).toContain(id);
    expect((await late.expect("strokes.removed")).ids).toContain(id);
    pad.send({ type: "undo" });
    expect((await viewer.expect("strokes.restored")).strokes.map((s) => s.id)).toContain(id);

    for (const c of [pad, viewer, late]) c.ws.close();
  });

  test("a resent stroke (reconnect) is acked but stored once", async () => {
    const pad = await client();
    pad.send(hello("pad"));
    const pageId = (await pad.expect("snapshot")).page.id;
    const stroke = (id: string, n = 1) => {
      pad.send({ type: "stroke.begin", id, pageId, tool: "pen", color: "#000000", width: 10 });
      pad.send({ type: "stroke.points", id, pts: [5, 5, 0.3, 0] });
      pad.send({ type: "stroke.end", id, n });
    };
    stroke("dup");
    await pad.expect("stroke.ack");
    pad.ws.close();

    const again = await client();
    again.send(hello("pad"));
    const before = (await again.expect("snapshot")).strokes.length;
    again.send({ type: "stroke.begin", id: "dup", pageId, tool: "pen", color: "#000000", width: 10 });
    expect(await again.expect("stroke.ack")).toEqual({ type: "stroke.ack", id: "dup" });
    expect(app.hub.library.strokeCount).toBe(before);
    again.ws.close();
  });

  test("missing points → resync request, nothing stored", async () => {
    const pad = await client();
    pad.send(hello("pad"));
    const pageId = (await pad.expect("snapshot")).page.id;
    const count = app.hub.library.strokeCount;
    pad.send({ type: "stroke.begin", id: "gap", pageId, tool: "pen", color: "#000000", width: 10 });
    pad.send({ type: "stroke.points", id: "gap", pts: [5, 5, 0.3, 0] });
    pad.send({ type: "stroke.end", id: "gap", n: 3 });
    expect(await pad.expect("stroke.resync")).toEqual({ type: "stroke.resync", id: "gap" });
    expect(app.hub.library.strokeCount).toBe(count);
    pad.ws.close();
  });

  test("erase gesture is broadcast and undone as one step", async () => {
    const pad = await client();
    pad.send(hello("pad"));
    const pageId = (await pad.expect("snapshot")).page.id;
    for (const id of ["e1", "e2"]) {
      pad.send({ type: "stroke.begin", id, pageId, tool: "pen", color: "#000000", width: 10 });
      pad.send({ type: "stroke.points", id, pts: [5, 5, 0.3, 0] });
      pad.send({ type: "stroke.end", id, n: 1 });
      await pad.expect("stroke.ack");
    }
    const viewer = await client();
    viewer.send(hello("viewer"));
    await viewer.expect("snapshot");

    pad.send({ type: "erase", pageId, strokeIds: ["e1"], group: "g" });
    expect((await viewer.expect("strokes.removed")).ids).toEqual(["e1"]);
    pad.send({ type: "erase", pageId, strokeIds: ["e2"], group: "g" });
    expect((await viewer.expect("strokes.removed")).ids).toEqual(["e2"]);
    viewer.send({ type: "undo" });
    expect((await pad.expect("strokes.restored")).strokes.map((s) => s.id)).toEqual(["e1", "e2"]);
    expect(await pad.expect("history")).toMatchObject({ canRedo: true });

    pad.send({ type: "erase", pageId: "nope", strokeIds: ["e1"] });
    expect((await pad.expect("error")).code).toBe("unknown_page");
    pad.ws.close();
    viewer.ws.close();
  });

  test("a pad disconnecting mid-stroke cancels it on viewers", async () => {
    const viewer = await client();
    viewer.send(hello("viewer"));
    await viewer.expect("snapshot");
    const pad = await client();
    pad.send(hello("pad"));
    const pageId = (await pad.expect("snapshot")).page.id;
    pad.send({ type: "stroke.begin", id: "half", pageId, tool: "pen", color: "#000000", width: 10 });
    await viewer.expect("stroke.begin");
    pad.ws.close();
    expect((await viewer.expect("stroke.cancel")).id).toBe("half");
    viewer.ws.close();
  });

  test("stale page id: stroke dropped from the outbox, current snapshot sent", async () => {
    const pad = await client();
    pad.send(hello("pad"));
    const pageId = (await pad.expect("snapshot")).page.id;
    pad.send({ type: "stroke.begin", id: "x", pageId: "old-page", tool: "pen", color: "#000000", width: 10 });
    expect((await pad.expect("error")).code).toBe("unknown_page");
    expect((await pad.expect("stroke.ack")).id).toBe("x");
    expect((await pad.expect("snapshot")).page.id).toBe(pageId);
    pad.ws.close();
  });

  test("ink settings are broadcast and reported for persistence", async () => {
    const a = await client();
    a.send(hello("viewer"));
    await a.expect("snapshot");
    const b = await client();
    b.send(hello("pad"));
    await b.expect("snapshot");

    a.send({ type: "settings.set", ink: { pressureMax: 0.4 } });
    const expected = { ...DEFAULT_INK, pressureMax: 0.4 };
    expect((await a.expect("settings")).ink).toEqual(expected);
    expect((await b.expect("settings")).ink).toEqual(expected);
    expect(savedInk.at(-1)).toEqual(expected);
    a.send({ type: "settings.set", ink: DEFAULT_INK });
    await a.expect("settings");
    a.ws.close();
    b.ws.close();
  });

  test("strip viewport: relayed to others, kept for the next snapshot, cleared by tablet mode", async () => {
    const pad = await client();
    pad.send(hello("pad"));
    const pageId = (await pad.expect("snapshot")).page.id;
    const viewer = await client();
    viewer.send(hello("viewer"));
    await viewer.expect("snapshot");

    const rect = { x: 210, y: 220, w: 515, h: 240 };
    pad.send({ type: "viewport", pageId, rect });
    expect(await viewer.expect("viewport")).toEqual({ type: "viewport", pageId, rect });

    // Dragged on the PC → the pad hears about it.
    const moved = { ...rect, x: 600 };
    viewer.send({ type: "viewport", pageId, rect: moved });
    expect((await pad.expect("viewport")).rect).toEqual(moved);

    const late = await client();
    late.send(hello("viewer"));
    expect((await late.expect("snapshot")).viewport).toEqual({ pageId, rect: moved });

    pad.send({ type: "viewport", pageId, rect: null });
    expect((await viewer.expect("viewport")).rect).toBeNull();

    pad.send({ type: "viewport", pageId: "old-page", rect });
    expect((await pad.expect("error")).code).toBe("unknown_page");
    for (const c of [pad, viewer, late]) c.ws.close();
  });

  test("pages: new / goto from the pad reach everyone; only the viewer deletes", async () => {
    const viewer = await client();
    viewer.send(hello("viewer"));
    const first = await viewer.expect("snapshot");
    expect(first.notebook.pages).toBe(first.pages.length);
    expect((await viewer.expect("notebooks")).notebooks.map((n) => n.id)).toContain(first.notebook.id);
    const pad = await client();
    pad.send(hello("pad"));
    await pad.expect("snapshot");

    pad.send({ type: "page.new", afterPageId: first.page.id });
    const snap = await viewer.expect("snapshot");
    expect(snap.pages).toHaveLength(first.pages.length + 1);
    expect(snap.page.id).not.toBe(first.page.id);
    expect(snap.strokes).toEqual([]);
    expect((await pad.expect("snapshot")).page.id).toBe(snap.page.id);
    expect((await viewer.expect("notebooks")).notebooks.find((n) => n.id === snap.notebook.id)?.pages).toBe(snap.pages.length);

    pad.send({ type: "page.delete", pageId: snap.page.id });
    expect((await pad.expect("error")).code).toBe("forbidden");
    pad.send({ type: "page.goto", pageId: "nope" });
    expect((await pad.expect("error")).code).toBe("unknown_page");

    // A stroke for the page the pad just left still lands there.
    pad.send({ type: "page.goto", pageId: first.page.id });
    expect((await viewer.expect("snapshot")).page.id).toBe(first.page.id);
    pad.send({ type: "stroke.begin", id: "left-behind", pageId: snap.page.id, tool: "pen", color: "#000000", width: 10 });
    pad.send({ type: "stroke.points", id: "left-behind", pts: [5, 5, 0.3, 0] });
    pad.send({ type: "stroke.end", id: "left-behind", n: 1 });
    expect((await pad.expect("stroke.ack")).id).toBe("left-behind");

    // Thumbnail / export of that page.
    const res = await fetch(`${app.url}/api/export/${snap.page.id}.svg?thumb=1`);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const svg = await res.text();
    expect(svg).toStartWith("<svg");
    expect(svg.match(/<path d="M/g)?.length).toBeGreaterThanOrEqual(2); // ruling + the stroke
    expect((await fetch(`${app.url}/api/export/nope.svg`)).status).toBe(404);

    // PDF of that page and of the whole notebook, with a download name.
    const pagePdf = await fetch(`${app.url}/api/export/${snap.page.id}.pdf?download=1`);
    expect(pagePdf.headers.get("content-type")).toBe("application/pdf");
    expect(pagePdf.headers.get("content-disposition")).toMatch(/^attachment; filename=".+ - p\d+\.pdf"/);
    expect(new TextDecoder().decode((await pagePdf.bytes()).subarray(0, 8))).toBe("%PDF-1.4");
    const nbPdf = await fetch(`${app.url}/api/export/${snap.notebook.id}.pdf`);
    expect(nbPdf.status).toBe(200);
    const nbText = new TextDecoder("latin1").decode(await nbPdf.bytes());
    expect(nbText).toContain(`/Count ${snap.pages.length}`);
    expect((await fetch(`${app.url}/api/export/${snap.notebook.id}.svg`)).status).toBe(404); // SVG is per page
    expect((await fetch(`${app.url}/api/export/${snap.page.id}.png`)).status).toBe(404);

    // Undo of that stroke takes everyone to its page.
    viewer.send({ type: "undo" });
    expect((await pad.expect("snapshot")).page.id).toBe(snap.page.id);

    viewer.send({ type: "page.delete", pageId: snap.page.id });
    const after = await pad.expect("snapshot");
    expect(after.pages.map((p) => p.id)).not.toContain(snap.page.id);
    pad.ws.close();
    viewer.ws.close();
  });

  test("notebooks: create, rename / template, open, delete", async () => {
    const viewer = await client();
    viewer.send(hello("viewer"));
    const start = await viewer.expect("snapshot");
    await viewer.expect("notebooks"); // the one sent with welcome
    const pad = await client();
    pad.send(hello("pad"));
    await pad.expect("snapshot");

    pad.send({ type: "notebook.new", title: "Nope", template: "grid", kind: "a4" });
    expect((await pad.expect("error")).code).toBe("forbidden");

    viewer.send({ type: "notebook.new", title: "Physics", template: "grid", kind: "infinite" });
    const snap = await pad.expect("snapshot");
    expect(snap.notebook).toMatchObject({ title: "Physics", template: "grid", pages: 1 });
    expect(snap.page.kind).toBe("infinite");
    expect((await viewer.expect("notebooks")).notebooks[0]?.title).toBe("Physics");

    viewer.send({ type: "notebook.update", id: snap.notebook.id, title: "Physics II", template: "dotted" });
    expect((await pad.expect("notebook.state")).notebook).toMatchObject({ title: "Physics II", template: "dotted" });
    await viewer.expect("notebook.state");

    // Writing low on an endless page grows it for everyone.
    pad.send({ type: "stroke.begin", id: "deep", pageId: snap.page.id, tool: "pen", color: "#000000", width: 10 });
    pad.send({ type: "stroke.points", id: "deep", pts: [100, 2800, 0.3, 0] });
    pad.send({ type: "stroke.end", id: "deep", n: 1 });
    expect((await viewer.expect("notebook.state")).pages[0]?.height).toBe(4000);

    viewer.send({ type: "notebook.open", id: start.notebook.id });
    expect((await pad.expect("snapshot")).page.id).toBe(start.page.id);
    viewer.send({ type: "notebook.delete", id: snap.notebook.id });
    expect((await viewer.expect("notebooks")).notebooks.map((n) => n.id)).not.toContain(snap.notebook.id);
    viewer.send({ type: "notebook.open", id: snap.notebook.id });
    expect((await viewer.expect("error")).code).toBe("unknown_notebook");
    pad.ws.close();
    viewer.ws.close();
  });

  test("notes survive a server restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-taker-restart-"));
    try {
      const opts = { port: 0, token: TOKEN, adb: false, dataDir: dir, log: () => {} } as const;
      let srv = startServer(opts);
      let pad = await client("localhost", srv.port);
      pad.send(hello("pad"));
      const pageId = (await pad.expect("snapshot")).page.id;
      pad.send({ type: "stroke.begin", id: "keep", pageId, tool: "pen", color: "#000000", width: 10 });
      pad.send({ type: "stroke.points", id: "keep", pts: [7, 8, 0.3, 0] });
      pad.send({ type: "stroke.end", id: "keep", n: 1 });
      await pad.expect("stroke.ack");
      pad.ws.close();
      await srv.stop();

      srv = startServer(opts);
      pad = await client("localhost", srv.port);
      pad.send(hello("pad"));
      const snap = await pad.expect("snapshot");
      expect(snap.page.id).toBe(pageId);
      expect(snap.strokes).toMatchObject([{ id: "keep", pts: [7, 8, 0.3, 0] }]);
      expect((await pad.expect("history")).canUndo).toBe(true);
      pad.ws.close();
      await srv.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("server — M5", () => {
  test("pen hover goes to viewers only and is cleared when the pad leaves", async () => {
    const viewer = await client();
    viewer.send(hello("viewer"));
    const pageId = (await viewer.expect("snapshot")).page.id;
    const pad = await client();
    pad.send(hello("pad"));
    const padId = (await pad.expect("welcome")).clientId;
    const other = await client();
    other.send(hello("pad"));
    await other.expect("snapshot");

    const at = { pageId, x: 500, y: 640.5, tool: "pen", color: "#1d1f2b", width: 10 };
    pad.send({ type: "hover", at });
    expect(await viewer.expect("hover")).toEqual({ type: "hover", from: padId, at } as never);
    pad.send({ type: "hover", at: null });
    expect((await viewer.expect("hover")).at).toBeNull();

    // Viewers' hover is ignored (no pen there); other pads never get it.
    viewer.send({ type: "hover", at });
    pad.send({ type: "hover", at });
    expect((await viewer.expect("hover")).from).toBe(padId);
    await expect(other.expect("hover", 200)).rejects.toThrow();

    pad.ws.close();
    expect(await viewer.expect("hover")).toEqual({ type: "hover", from: padId, at: null });
    for (const c of [viewer, other]) c.ws.close();
  });

  test("live points reach viewers with the server's receive time", async () => {
    const viewer = await client();
    viewer.send(hello("viewer"));
    const pageId = (await viewer.expect("snapshot")).page.id;
    const pad = await client();
    pad.send(hello("pad"));
    await pad.expect("snapshot");

    const id = "stroke-latency";
    pad.send({ type: "stroke.begin", id, pageId, tool: "highlighter", color: "#ffe14d", width: 56 });
    expect((await viewer.expect("stroke.begin")).tool).toBe("highlighter");
    const at = performance.timeOrigin + performance.now();
    pad.send({ type: "stroke.points", id, pts: [10, 20, 0.3, 0], at, lat: 6.5 });
    const fwd = await viewer.expect("stroke.points");
    expect(fwd).toMatchObject({ at, lat: 6.5 });
    expect(fwd.rx!).toBeGreaterThanOrEqual(at);
    expect(fwd.rx! - at).toBeLessThan(1000);
    pad.send({ type: "stroke.end", id, n: 1 });
    expect((await viewer.expect("stroke.added")).stroke.tool).toBe("highlighter");
    for (const c of [pad, viewer]) c.ws.close();
  });

  test("the pad is installable: manifest linked, icons served", async () => {
    const html = await (await fetch(`${app.url}/pad`)).text();
    const href = /<link rel="manifest" href="([^"]+)"/.exec(html)?.[1];
    expect(href).toBeTruthy();
    const manifest = await (await fetch(new URL(href!, `${app.url}/pad`))).json();
    expect(manifest).toMatchObject({ start_url: "/pad", display: "fullscreen" });
    for (const icon of manifest.icons as { src: string; type: string }[]) {
      const res = await fetch(new URL(icon.src, `${app.url}/pad`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(icon.type);
    }
    expect((await fetch(`${app.url}/icons/nope.png`)).status).toBe(404);
  });
});
