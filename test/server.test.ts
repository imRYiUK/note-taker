import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/main.ts";
import { lanAddresses } from "../src/server/net.ts";
import { CloseCode, PROTOCOL_VERSION, type ServerMsg } from "../src/shared/protocol.ts";

const TOKEN = "test-token-0123456789";
let app: ReturnType<typeof startServer>;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "note-taker-test-"));
  app = startServer({ port: 0, token: TOKEN, adb: false, dataDir, log: () => {}, helloTimeoutMs: 300 });
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
});
