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
async function client(host = "localhost") {
  const ws = new WebSocket(`ws://${host}:${app.port}/ws`);
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
    await viewer.expect("devices");

    const pad = await client();
    pad.send(hello("pad"));
    await pad.expect("welcome");

    let clients = (await viewer.expect("clients")).clients;
    while (!clients.some((c) => c.role === "pad")) clients = (await viewer.expect("clients")).clients;
    expect(clients.find((c) => c.role === "pad")).toMatchObject({ transport: "usb", deviceId: "pad-device" });

    pad.send({ type: "ping", t: 42 });
    expect(await pad.expect("pong")).toEqual({ type: "pong", t: 42 });

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

  const lan = lanAddresses()[0];
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

  test("pad strokes stream live to viewers and are in the next snapshot", async () => {
    const viewer = await client();
    viewer.send(hello("viewer"));
    await viewer.expect("welcome");
    expect((await viewer.expect("settings")).ink).toEqual(DEFAULT_INK);
    const snap = await viewer.expect("snapshot");
    expect(snap.page).toMatchObject({ id: "page-1", width: 2100, height: 2970 });

    const pad = await client();
    pad.send(hello("pad"));
    await pad.expect("welcome");
    const padSnap = await pad.expect("snapshot");

    const id = "stroke-live-1";
    pad.send({ type: "stroke.begin", id, pageId: padSnap.page.id, tool: "pen", color: "#112233", width: 10 });
    expect(await viewer.expect("stroke.begin")).toMatchObject({ id, color: "#112233" });
    pad.send({ type: "stroke.points", id, pts: [10, 20, 0.3, 0, 30, 40, 0.35, 4] });
    expect((await viewer.expect("stroke.points")).pts).toEqual([10, 20, 0.3, 0, 30, 40, 0.35, 4]);
    pad.send({ type: "stroke.end", id, n: 2 });
    const added = await viewer.expect("stroke.added");
    expect(added.stroke).toMatchObject({ id, pageId: "page-1", pts: [10, 20, 0.3, 0, 30, 40, 0.35, 4] });

    // A newcomer gets the committed stroke in its snapshot.
    const late = await client();
    late.send(hello("viewer"));
    expect((await late.expect("snapshot")).strokes.map((s) => s.id)).toContain(id);

    // Viewers can't draw.
    viewer.send({ type: "stroke.begin", id: "v", pageId: "page-1", tool: "pen", color: "#000000", width: 1 });
    expect((await viewer.expect("error")).code).toBe("forbidden");

    // Clear → everyone gets an empty snapshot.
    viewer.send({ type: "page.clear", pageId: "page-1" });
    expect((await pad.expect("snapshot")).strokes).toEqual([]);
    expect((await late.expect("snapshot")).strokes).toEqual([]);

    for (const c of [pad, viewer, late]) c.ws.close();
  });

  test("a pad disconnecting mid-stroke cancels it on viewers", async () => {
    const viewer = await client();
    viewer.send(hello("viewer"));
    await viewer.expect("snapshot");
    const pad = await client();
    pad.send(hello("pad"));
    await pad.expect("snapshot");
    pad.send({ type: "stroke.begin", id: "half", pageId: "page-1", tool: "pen", color: "#000000", width: 10 });
    await viewer.expect("stroke.begin");
    pad.ws.close();
    expect((await viewer.expect("stroke.cancel")).id).toBe("half");
    viewer.ws.close();
  });

  test("stale page id gets the current snapshot back", async () => {
    const pad = await client();
    pad.send(hello("pad"));
    await pad.expect("snapshot");
    pad.send({ type: "stroke.begin", id: "x", pageId: "old-page", tool: "pen", color: "#000000", width: 10 });
    expect((await pad.expect("error")).code).toBe("unknown_page");
    expect((await pad.expect("snapshot")).page.id).toBe("page-1");
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
});
