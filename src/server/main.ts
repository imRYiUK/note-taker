import { mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { join } from "node:path";
import padPage from "../pad/index.html";
import viewerPage from "../viewer/index.html";
import probePage from "../probe/index.html";
import { WS_PATH } from "../shared/protocol.ts";
import { DEFAULT_INK, type InkSettings } from "../shared/ink.ts";
import { loadConfig, loadTls, saveInkSettings, dataDir as defaultDataDir } from "./config.ts";
import { AdbWatcher } from "./adb.ts";
import { Hub, type WsData } from "./hub.ts";
import { Library } from "./notebook.ts";
import { attachment, exportFileName, notebookPdf, pageSvg, type PdfSource } from "./export.ts";
import { iconPng } from "./icon.ts";
import { Store } from "./store.ts";
import { authorize, isLoopback, lanAddresses, padUrls, type LanAddress } from "./net.ts";
import { qrTerminal } from "../shared/qr.ts";
import { pageSuffix } from "../shared/filename.ts";

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
  /**
   * HTTPS for Wi-Fi pads (a mkcert certificate trusted by the phone): served on
   * `tls.port` next to plain HTTP, and LAN pairing links use it.
   */
  tls?: { cert: string; key: string; port: number };
  /** How often to look for LAN address changes, ms (0 = never; default 5000). */
  lanWatchMs?: number;
  /** LAN addresses to advertise (tests); default: detected. */
  lan?: () => LanAddress[];
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
  const lanHosts = () => (hostname === "127.0.0.1" ? [] : (opts.lan ?? lanAddresses)());
  let lan = lanHosts();
  const cert = opts.tls ? new X509Certificate(opts.tls.cert) : null;
  let httpsPort: number | undefined;
  const currentPadUrls = () => padUrls(port, opts.token, lan, { httpsPort, cert });

  hub = new Hub({
    token: opts.token,
    padUrls: currentPadUrls,
    usbUrl: (page) => `http://localhost:${port}/${page}`,
    adb,
    log,
    helloTimeoutMs: opts.helloTimeoutMs,
    library,
    ink: opts.ink ?? { ...DEFAULT_INK },
    onInkChange: opts.onInkChange,
  });

  const json = (body: unknown, status = 200) => Response.json(body, { status });

  function exportResponse(file: string, q: URLSearchParams): Response {
    const m = /^(.+)\.(svg|pdf)$/.exec(file);
    if (!m) return json({ error: "unknown format" }, 404);
    const [, id, ext] = m as unknown as [string, string, "svg" | "pdf"];
    const page = store.page(id);
    const nb = store.notebook(page ? page.notebookId : id);
    if (!nb || (ext === "svg" && !page)) return json({ error: "no such page or notebook" }, 404);
    const headers: Record<string, string> = { "cache-control": "no-cache" };
    const pages = page ? [page] : store.pages(nb.id);
    const suffix = page ? pageSuffix(store.pageIndex(page.id), nb.pages) : "";
    if (q.has("download")) headers["content-disposition"] = attachment(exportFileName(nb.title, ext, suffix));

    if (ext === "svg") {
      const svg = pageSvg(page!, nb.template, library.pageStrokes(page!.id), hub.ink, { thumb: q.has("thumb") });
      return new Response(svg, { headers: { ...headers, "content-type": "image/svg+xml; charset=utf-8" } });
    }
    const sources: PdfSource[] = pages.map((p) => ({ page: p, template: nb.template, strokes: library.pageStrokes(p.id) }));
    const pdf = notebookPdf(sources, hub.ink, { title: nb.title + suffix, split: q.get("split") === "1" });
    return new Response(pdf, { headers: { ...headers, "content-type": "application/pdf" } });
  }

  const listen = (listenPort: number, tls?: { cert: string; key: string }) => Bun.serve({
    port: listenPort,
    hostname,
    tls,
    development: process.env.NOTE_TAKER_DEV ? { hmr: true, console: true } : false,
    routes: {
      "/": Response.redirect("/viewer", 302),
      "/pad": padPage,
      "/viewer": viewerPage,
      "/probe": probePage,

      // PWA icons (the manifest is bundled with /pad; its icon URLs point here).
      "/icons/:name": (req) => {
        const png = iconPng(req.params.name);
        if (!png) return new Response("not found", { status: 404 });
        return new Response(png, { headers: { "content-type": "image/png", "cache-control": "max-age=86400" } });
      },

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

      // Export: `<pageId>.svg` (`?thumb=1`: coarser, for the viewer's thumbnails),
      // `<pageId>.pdf`, `<notebookId>.pdf` (`?split=1`: endless pages cut into A4).
      // `?download=1` adds a file name (the notebook title).
      "/api/export/:file": (req, srv) => {
        const url = new URL(req.url);
        if (!authorize(isLoopback(srv.requestIP(req)?.address), url.searchParams.get("token"), opts.token)) {
          return json({ error: "bad token" }, 401);
        }
        return exportResponse(req.params.file, url.searchParams);
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

  const server = listen(port);
  port = server.port ?? port;
  const secureServer = opts.tls ? listen(opts.tls.port, { cert: opts.tls.cert, key: opts.tls.key }) : null;
  httpsPort = secureServer?.port;
  adb?.start();

  // LAN detection: re-advertise pairing links when Wi-Fi comes, goes or changes address.
  const lanWatchMs = opts.lanWatchMs ?? 5000;
  const lanTimer = lanWatchMs > 0
    ? setInterval(() => {
        const next = lanHosts();
        if (JSON.stringify(next) === JSON.stringify(lan)) return;
        lan = next;
        log(`LAN addresses: ${next.map((a) => `${a.address} (${a.iface})`).join(", ") || "none"}`);
        hub.broadcastPairing();
      }, lanWatchMs)
    : null;

  return {
    server,
    hub,
    port,
    url: `http://localhost:${port}`,
    httpsPort,
    padUrls: currentPadUrls,
    async stop() {
      if (lanTimer) clearInterval(lanTimer);
      adb?.stop();
      hub.dispose();
      await server.stop(true);
      await secureServer?.stop(true);
      store.close();
    },
  };
}

// ----------------------------------------------------------------- CLI

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    console.log(`note-taker server ${VERSION}

Usage: bun src/server/main.ts [--usb-only] [--no-adb] [--no-https] [--qr]

  --usb-only   listen on 127.0.0.1 only (phone must use USB / adb reverse)
  --no-adb     don't manage adb reverse automatically
  --no-https   ignore the mkcert certificate in <config>/tls/ (cert.pem, key.pem)
  --qr         print the Wi-Fi pairing QR code in the terminal

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
  const usbOnly = args.has("--usb-only");
  const tls = usbOnly || args.has("--no-https") ? null : await loadTls();
  let app: ReturnType<typeof startServer>;
  try {
    app = startServer({
      port: cfg.port,
      token: cfg.token,
      hostname: args.has("--usb-only") ? "127.0.0.1" : "0.0.0.0",
      adb: !args.has("--no-adb"),
      ink: cfg.ink,
      onInkChange: persistInk,
      tls: tls ? { ...tls, port: cfg.port + 1 } : undefined,
    });
  } catch (e) {
    console.error(`[note-taker] could not start (port ${cfg.port}): ${(e as Error).message}`);
    process.exit(1);
  }

  const urls = app.padUrls();
  console.log(`[note-taker] ${VERSION} listening on :${app.port}
  viewer     ${app.url}/viewer
  pad (USB)  ${urls.usb}
${urls.lan.map((l) => `  pad (LAN)  ${l.url}  [${l.iface}]${l.warning ? `  ⚠ ${l.warning}` : ""}`).join("\n")}
  probe      ${app.url}/probe`);
  if (args.has("--qr") && urls.lan[0]) console.log(`\n${qrTerminal(urls.lan[0].url)}\n  scan with the phone (${urls.lan[0].iface})`);

  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
