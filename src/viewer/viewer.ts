import { Connection, type ConnStatus } from "../shared/connection.ts";
import type { AdbDevice, ClientInfo, PadUrls, ServerMsg } from "../shared/protocol.ts";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  for (const c of children) if (c) el.append(c);
  return el;
}

let myId: string | null = null;

// ------------------------------------------------------------------ connection

const STATUS: Record<ConnStatus, [string, string]> = {
  connecting: ["connecting…", "warn"],
  open: ["server connected", "ok"],
  closed: ["server offline — retrying", "bad"],
  unauthorized: ["unauthorized", "bad"],
  outdated: ["server updated — reload", "warn"],
};

const conn = new Connection("viewer", {
  onStatus: (s) => {
    const [label, cls] = STATUS[s];
    const el = $("#server-status");
    el.replaceChildren(h("span", { class: `dot ${cls}` }), h("span", {}, label));
  },
  onMessage: (msg) => handle(msg),
});

function handle(msg: ServerMsg) {
  switch (msg.type) {
    case "welcome":
      myId = msg.clientId;
      renderUrls(msg.padUrls);
      void loadLatestProbe();
      break;
    case "clients":
      renderClients(msg.clients);
      break;
    case "devices":
      renderDevices(msg.devices, msg.adbAvailable);
      break;
    case "probe.report":
      renderProbe(msg.report as ProbeReport, msg.file);
      break;
    case "error":
      toast(msg.message);
      break;
  }
}

// ------------------------------------------------------------------ rendering

function urlRow(url: string) {
  const copy = h("button", { type: "button", textContent: "Copy" });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    } catch {
      toast("Clipboard not available");
    }
  });
  return h("div", { class: "url" }, h("code", { textContent: url, title: url }), copy);
}

function renderUrls(urls: PadUrls) {
  $("#usb-url").replaceChildren(urlRow(urls.usb));
  $("#lan-urls").replaceChildren(
    ...(urls.lan.length ? urls.lan.map(urlRow) : [h("div", { class: "empty", textContent: "No LAN address (USB-only mode?)" })]),
  );
}

function since(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

function describeUA(ua: string) {
  const android = ua.match(/Android [\d.]+(?:; ([^;)]+))?/);
  if (android) return `Android${android[1] ? ` · ${android[1].trim()}` : ""}`;
  if (/Linux/.test(ua)) return "Linux";
  return ua.slice(0, 40);
}

function renderClients(clients: ClientInfo[]) {
  const el = $("#clients");
  const sorted = [...clients].sort((a, b) => (a.role === b.role ? a.connectedAt - b.connectedAt : a.role === "pad" ? -1 : 1));
  if (!sorted.length) {
    el.replaceChildren(h("div", { class: "empty", textContent: "Nothing connected." }));
    return;
  }
  el.replaceChildren(
    ...sorted.map((c) => {
      const rtt = c.rtt === null ? "…" : `${c.rtt.toFixed(1)} ms`;
      const rttCls = c.rtt === null ? "" : c.rtt < 15 ? "ok" : c.rtt < 40 ? "warn" : "bad";
      return h(
        "div",
        { class: "row" },
        h("span", { class: `dot ${rttCls || "ok"}` }),
        h("b", { textContent: c.role === "pad" ? "Pad" : c.id === myId ? "Viewer (this window)" : "Viewer" }),
        h("span", { class: "badge", textContent: c.transport.toUpperCase() }),
        h("span", { class: "sub", textContent: `${describeUA(c.userAgent)} · ${c.deviceId.slice(0, 8)}` }),
        h("span", { class: "right" }, h("span", { class: "sub mono", textContent: `rtt ${rtt} · ${since(c.connectedAt)}` })),
      );
    }),
  );
}

function renderDevices(devices: AdbDevice[], adbAvailable: boolean) {
  const el = $("#devices");
  if (!adbAvailable) {
    el.replaceChildren(h("div", { class: "empty", textContent: "adb not found — install android-tools for USB mode." }));
    return;
  }
  if (!devices.length) {
    el.replaceChildren(h("div", { class: "empty", textContent: "No phone on USB. Plug it in with USB debugging on." }));
    return;
  }
  el.replaceChildren(
    ...devices.map((d) => {
      const ready = d.state === "device" && d.reversed;
      const hint =
        d.state === "unauthorized"
          ? "accept the USB debugging prompt on the phone"
          : d.state !== "device"
            ? d.state
            : d.reversed
              ? "port forwarded"
              : "setting up port forward…";
      const open = (page: "pad" | "probe") => {
        const b = h("button", { type: "button", textContent: page === "pad" ? "Open pad" : "Open probe", disabled: !ready });
        b.addEventListener("click", () => conn.send({ type: "adb.open", serial: d.serial, page }));
        return b;
      };
      return h(
        "div",
        { class: "row" },
        h("span", { class: `dot ${ready ? "ok" : "warn"}` }),
        h("b", { textContent: d.model ?? d.serial }),
        h("span", { class: "sub", textContent: hint }),
        h("span", { class: "right" }, open("probe"), open("pad")),
      );
    }),
  );
}

// ------------------------------------------------------------------ probe report

interface ProbeReport {
  at: string;
  env: { secureContext: boolean; wakeLockApi: boolean; desynchronizedCanvas: boolean; screen: string; dpr: number };
  pen: {
    detected: boolean;
    pressure: { min: number | null; max: number | null; distinctLevels: number };
    tilt: { seen: boolean; maxAbsX: number; maxAbsY: number };
    altitudeSeen: boolean;
    hover: boolean;
    buttonsWhileDown: number[];
    buttonsWhileHover: number[];
    sideButtonWhileDown: boolean;
    sideButtonWhileHover: boolean;
    sampleRateHz: number | null;
    coalescedPerEvent: number | null;
    predictedPerEvent: number | null;
  };
  touch: { detected: boolean; touchesWhilePenActive: number };
  events: { contextmenu: number };
}

function renderProbe(r: ProbeReport, file: string) {
  const p = r.pen;
  const rows: [string, boolean, string][] = [
    ["Pen detected", p.detected, ""],
    [
      "Pressure",
      p.pressure.distinctLevels > 10,
      p.pressure.min !== null ? `${p.pressure.min.toFixed(2)}–${p.pressure.max?.toFixed(2)}, ${p.pressure.distinctLevels} levels` : "none",
    ],
    ["Tilt", p.tilt.seen || p.altitudeSeen, p.tilt.seen ? `±${p.tilt.maxAbsX}° / ±${p.tilt.maxAbsY}°` : "not reported"],
    ["Hover → PC cursor possible", p.hover, p.hover ? "yes" : "no hover events"],
    ["Side button while writing (eraser)", p.sideButtonWhileDown, `buttons: ${p.buttonsWhileDown.join(", ") || "—"}`],
    ["Side button while hovering", p.sideButtonWhileHover, `buttons: ${p.buttonsWhileHover.join(", ") || "—"}`],
    ["Finger/palm separated as touch", r.touch.detected, r.touch.detected ? `${r.touch.touchesWhilePenActive} touches while pen active` : "not tested"],
    ["Sample rate", (p.sampleRateHz ?? 0) >= 100, p.sampleRateHz ? `${p.sampleRateHz} Hz (${p.coalescedPerEvent} coalesced/event)` : "—"],
    ["Predicted events", (p.predictedPerEvent ?? 0) > 0, p.predictedPerEvent ? `${p.predictedPerEvent}/event` : "—"],
    ["Low-latency canvas", r.env.desynchronizedCanvas, r.env.desynchronizedCanvas ? "desynchronized" : "no"],
    ["Wake lock", r.env.secureContext && r.env.wakeLockApi, r.env.secureContext ? "secure context" : "insecure (use USB)"],
  ];
  $("#probe-body").className = "";
  $("#probe-body").replaceChildren(
    h(
      "table",
      {},
      ...rows.map(([label, pass, value]) =>
        h(
          "tr",
          {},
          h("td", { class: pass ? "pass" : "fail", textContent: pass ? "✓" : "✗" }),
          h("td", { textContent: label }),
          h("td", { class: "v", textContent: value }),
        ),
      ),
    ),
    h("div", { class: "label mono", textContent: `${new Date(r.at).toLocaleString()} · ${r.env.screen} @${r.env.dpr}x · ${file}` }),
  );
}

async function loadLatestProbe() {
  try {
    const res = await fetch("/api/probe/latest");
    if (!res.ok) return;
    const { file, report } = await res.json();
    renderProbe(report, file);
  } catch {
    // none yet
  }
}

// ------------------------------------------------------------------ toast

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string) {
  const el = $("#toast");
  el.textContent = text;
  el.style.display = "block";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.style.display = "none"), 4000);
}
