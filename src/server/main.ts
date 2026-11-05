import { mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import padPage from "../pad/index.html";
import viewerPage from "../viewer/index.html";
import probePage from "../probe/index.html";
import { WS_PATH } from "../shared/protocol.ts";
import { DEFAULT_INK, type InkSettings } from "../shared/ink.ts";
import { loadConfig, saveInkSettings, dataDir as defaultDataDir } from "./config.ts";
import { AdbWatcher } from "./adb.ts";
import { Hub, type WsData } from "./hub.ts";
import { Library } from "./notebook.ts";
import { pageSvg } from "./export.ts";
import { Store } from "./store.ts";
import { authorize, isLoopback, padUrls } from "./net.ts";

export const VERSION = "0.0.1";
const MAX_PROBE_BYTES = 1 << 20;

export interface ServerOptions {
  port: number;
  token: string;
  hostname?: string;
  dataDir?: string;
  adb?: boolean;
  log?: (msg: string) => void;
  helloTimeoutMs?: number;
  ink?: InkSettings;
  onInkChange?: (ink: InkSettings) => void;
}

export function startServer(opts: ServerOptions) {
  const log = opts.log ?? ((m: string) => console.log(`[note-taker] ${m}`));
  const dir = opts.dataDir ?? defaultDataDir();
  const hostname = opts.hostname ?? "0.0.0.0";
  let port = opts.port;

  mkdirSync(dir, { recursive: true });
  const dbFile = join(dir, "notes.db");
  const store = new Store(dbFile);
  const library = new Library(store);
  log(`notes: ${dbFile} (“${library.notebook.title}”, page ${library.pages.findIndex((p) => p.id === library.page.id) + 1}/${library.pages.length})`);

  // Filled in once the server is listening (port may be 0 → random).
  let hub!: Hub;
  const adb = opts.adb === false ? null : new AdbWatcher(() => port, () => hub?.broadcastDevices(), log);
  const lanHosts = () => (hostname === "127.0.0.1" ? [] : undefined);

  hub = new Hub({
    token: opts.token,
    padUrls: () => padUrls(port, opts.token, lanHosts()),
    usbUrl: (page) => `http://localhost:${port}/${page}`,
    adb,
    log,
    helloTimeoutMs: opts.helloTimeoutMs,
    library,
    ink: opts.ink ?? { ...DEFAULT_INK },
    onInkChange: opts.onInkChange,
  });

  const json = (body: unknown, status = 200) => Response.json(body, { status });

  const server = Bun.serve({
    port,
    hostname,
    development: process.env.NOTE_TAKER_DEV ? { hmr: true, console: true } : false,
    routes: {
      "/": Response.redirect("/viewer", 302),
      "/pad": padPage,
      "/viewer": viewerPage,
      "/probe": probePage,

      "/api/health": () => json({ ok: true, name: "note-taker", version: VERSION }),

      "/api/probe": {
        POST: async (req, srv) => {
          const ip = srv.requestIP(req)?.address;
          const token = new URL(req.url).searchParams.get("token");
          if (!authorize(isLoopback(ip), token, opts.token)) return json({ error: "bad token" }, 401);
          const text = await req.text();
          if (text.length > MAX_PROBE_BYTES) return json({ error: "too large" }, 413);
          let report: unknown;
          try {
            report = JSON.parse(text);
          } catch {
            return json({ error: "invalid json" }, 400);
          }
          const probesDir = join(dir, "probes");
          await mkdir(probesDir, { recursive: true });
          const file = join(probesDir, `probe-${new Date().toISOString().replaceAll(":", "-")}.json`);
          await writeFile(file, JSON.stringify(report, null, 2) + "\n");
          log(`probe report saved: ${file}`);
          hub.toViewers({ type: "probe.report", file, report });
          return json({ ok: true, file });
        },
      },

      "/api/probe/latest": {
        GET: async (req, srv) => {
          if (!isLoopback(srv.requestIP(req)?.address)) return json({ error: "forbidden" }, 403);
          const probesDir = join(dir, "probes");
          const files = (await readdir(probesDir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort();
          const last = files.at(-1);
          if (!last) return json({ error: "no reports yet" }, 404);
          const file = join(probesDir, last);
          return json({ file, report: JSON.parse(await readFile(file, "utf8")) });
        },
      },

      // A page as SVG (`?thumb=1`: coarser, for the viewer's thumbnails).
      "/api/export/:file": (req, srv) => {
        const url = new URL(req.url);
        if (!authorize(isLoopback(srv.requestIP(req)?.address), url.searchParams.get("token"), opts.token)) {
          return json({ error: "bad token" }, 401);
        }
        const m = /^(.+)\.svg$/.exec(req.params.file);
        const page = m ? store.page(m[1]!) : null;
        if (!page) return json({ error: "no such page" }, 404);
        const nb = store.notebook(page.notebookId)!;
        const svg = pageSvg(page, nb.template, library.pageStrokes(page.id), hub.ink, {
          thumb: url.searchParams.has("thumb"),
        });
        return new Response(svg, {
          headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-cache" },
        });
      },

      [WS_PATH]: (req, srv) => {
        const ip = srv.requestIP(req)?.address ?? "";
        const upgraded = srv.upgrade(req, {
          data: {
            id: crypto.randomUUID(),
            ip,
            loopback: isLoopback(ip),
            userAgent: req.headers.get("user-agent") ?? "",
            info: null,
            helloTimer: null,
          } satisfies WsData,
        });
        return upgraded ? undefined : new Response("websocket upgrade required", { status: 426 });
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
    websocket: {
      data: {} as WsData,
      open: (ws) => hub.open(ws),
      message: (ws, msg) => hub.message(ws, msg),
      close: (ws) => hub.close(ws),
      perMessageDeflate: false, // latency over bandwidth
      // Clients ping every 2 s: a silent socket is dead (e.g. Wi-Fi dropped) — free its live strokes.
      idleTimeout: 15,
    },
  });

  port = server.port ?? port;
  adb?.start();

  return {
    server,
    hub,
    port,
    url: `http://localhost:${port}`,
    padUrls: () => padUrls(port, opts.token, lanHosts()),
    async stop() {
      adb?.stop();
      hub.dispose();
      await server.stop(true);
      store.close();
    },
  };
}

// ----------------------------------------------------------------- CLI

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    console.log(`note-taker server ${VERSION}

Usage: bun src/server/main.ts [--usb-only] [--no-adb]

  --usb-only   listen on 127.0.0.1 only (phone must use USB / adb reverse)
  --no-adb     don't manage adb reverse automatically

Env: NOTE_TAKER_PORT, NOTE_TAKER_CONFIG_DIR, NOTE_TAKER_DATA_DIR, NOTE_TAKER_DEV=1`);
    process.exit(0);
  }

  const cfg = await loadConfig();
  // Slider drags send many updates — write the config once they settle.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const persistInk = (ink: InkSettings) => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveInkSettings(ink).catch((e) => console.error(`[note-taker] could not save settings: ${(e as Error).message}`));
    }, 500);
  };
  let app: ReturnType<typeof startServer>;
  try {
    app = startServer({
      port: cfg.port,
      token: cfg.token,
      hostname: args.has("--usb-only") ? "127.0.0.1" : "0.0.0.0",
      adb: !args.has("--no-adb"),
      ink: cfg.ink,
      onInkChange: persistInk,
    });
  } catch (e) {
    console.error(`[note-taker] could not start (port ${cfg.port}): ${(e as Error).message}`);
    process.exit(1);
  }

  const urls = app.padUrls();
  console.log(`[note-taker] ${VERSION} listening on :${app.port}
  viewer     ${app.url}/viewer
  pad (USB)  ${urls.usb}
${urls.lan.map((u) => `  pad (LAN)  ${u}`).join("\n")}
  probe      ${app.url}/probe`);

  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
