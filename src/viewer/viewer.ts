import { Connection, type ConnStatus } from "../shared/connection.ts";
import { DEFAULT_INK, applyPressureCurve, type InkSettings } from "../shared/ink.ts";
import type { AdbDevice, ClientInfo, HistoryState, PadUrls, ServerMsg } from "../shared/protocol.ts";
import { PageView, type FitMode } from "./renderer.ts";

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
// Declared before `conn`: its constructor reports the first status synchronously.
let online = false;
let history: HistoryState = { canUndo: false, canRedo: false };
const view = new PageView($("#stage"));

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
    online = s === "open";
    const [label, cls] = STATUS[s];
    const el = $("#server-status");
    el.replaceChildren(h("span", { class: `dot ${cls}` }), h("span", {}, label));
    renderHistory();
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
      renderPadStatus(msg.clients);
      break;
    case "snapshot":
      view.setSnapshot(msg.page, msg.strokes);
      renderObserved();
      break;
    case "stroke.begin":
      view.liveBegin(msg);
      break;
    case "stroke.points":
      view.livePoints(msg.id, msg.pts);
      break;
    case "stroke.cancel":
      view.liveCancel(msg.id);
      break;
    case "stroke.added":
      view.addStroke(msg.stroke);
      renderObserved();
      break;
    case "strokes.removed":
      if (msg.pageId === view.page?.id) view.removeStrokes(msg.ids);
      break;
    case "strokes.restored":
      view.restoreStrokes(msg.strokes);
      break;
    case "history":
      history = { canUndo: msg.canUndo, canRedo: msg.canRedo };
      renderHistory();
      break;
    case "settings":
      ink = msg.ink;
      view.setInk(ink);
      renderInk();
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

// ------------------------------------------------------------------ header controls

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
    // not remembered — fine
  }
}

const fitBtn = $<HTMLButtonElement>("#fit");
function setFit(fit: FitMode) {
  view.setFit(fit);
  fitBtn.textContent = fit === "width" ? "Fit: width" : "Fit: page";
  storageSet("note-taker.viewer.fit", fit);
}
setFit(storageGet("note-taker.viewer.fit") === "page" ? "page" : "width");
fitBtn.addEventListener("click", () => setFit(view.fit === "width" ? "page" : "width"));

const followBtn = $<HTMLButtonElement>("#follow");
followBtn.addEventListener("click", () => {
  view.follow = !view.follow;
  followBtn.setAttribute("aria-pressed", String(view.follow));
});

function renderHistory() {
  $<HTMLButtonElement>("#undo").disabled = !online || !history.canUndo;
  $<HTMLButtonElement>("#redo").disabled = !online || !history.canRedo;
}
$("#undo").addEventListener("click", () => conn.send({ type: "undo" }));
$("#redo").addEventListener("click", () => conn.send({ type: "redo" }));

// Clearing is one undo step, so no confirmation.
$("#clear").addEventListener("click", () => {
  if (!view.page || !view.strokeCount) return;
  conn.send({ type: "page.clear", pageId: view.page.id });
  toast("Page cleared — Ctrl+Z to undo", "info");
});

const panel = $("#panel");
const panelBtn = $<HTMLButtonElement>("#panel-toggle");
let panelTouched = false;
function setPanel(open: boolean) {
  panel.hidden = !open;
  panelBtn.setAttribute("aria-pressed", String(open));
}
panelBtn.addEventListener("click", () => {
  panelTouched = true;
  setPanel(Boolean(panel.hidden));
});

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && !e.altKey && (key === "z" || key === "y")) {
    e.preventDefault();
    conn.send({ type: key === "y" || e.shiftKey ? "redo" : "undo" });
    return;
  }
  if (mod || e.altKey) return;
  if (key === "f") setFit(view.fit === "width" ? "page" : "width");
});

function renderPadStatus(clients: ClientInfo[]) {
  const pads = clients.filter((c) => c.role === "pad");
  const el = $("#pad-status");
  if (!pads.length) {
    el.replaceChildren(h("span", { class: "dot bad" }), h("span", {}, "no pad"));
    return;
  }
  const p = pads[0]!;
  const rtt = p.rtt === null ? "" : ` · ${p.rtt.toFixed(1)} ms`;
  el.replaceChildren(
    h("span", { class: "dot ok" }),
    h("span", {}, `pad ${p.transport.toUpperCase()}${rtt}${pads.length > 1 ? ` (+${pads.length - 1})` : ""}`),
  );
  // First pad connection: get the setup panel out of the way, unless the user chose.
  if (!panelTouched && !panel.hidden) {
    panelTouched = true;
    setPanel(false);
  }
}

// ------------------------------------------------------------------ ink settings

let ink: InkSettings = { ...DEFAULT_INK };
const pmax = $<HTMLInputElement>("#pmax");
const gamma = $<HTMLInputElement>("#gamma");
let dragging = false;
let pendingInk: Partial<InkSettings> | null = null;

for (const input of [pmax, gamma]) {
  input.addEventListener("pointerdown", () => (dragging = true));
  input.addEventListener("pointerup", () => (dragging = false));
  input.addEventListener("change", () => (dragging = false));
  input.addEventListener("input", () => {
    ink = { pressureMax: Number(pmax.value), pressureGamma: Number(gamma.value) };
    renderInk();
    // At most one update per frame while dragging.
    if (!pendingInk) {
      requestAnimationFrame(() => {
        if (pendingInk) conn.send({ type: "settings.set", ink: pendingInk });
        pendingInk = null;
      });
    }
    pendingInk = { ...ink };
  });
}

function renderInk() {
  if (!dragging) {
    pmax.value = String(ink.pressureMax);
    gamma.value = String(ink.pressureGamma);
  }
  $("#pmax-out").textContent = ink.pressureMax.toFixed(2);
  $("#gamma-out").textContent = ink.pressureGamma.toFixed(2);
  drawCurve();
}

function observedMax(): number | null {
  const r = view.recentPressure;
  if (r.length < 3) return null;
  // 90th percentile of per-stroke maxima: firm-but-normal writing, ignoring outliers.
  const sorted = [...r].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
}

function renderObserved() {
  const obs = observedMax();
  const btn = $<HTMLButtonElement>("#use-observed");
  btn.disabled = obs === null;
  $("#observed").textContent =
    obs === null
      ? "Write a few strokes to measure your pressure."
      : `Your firm strokes reach ${obs.toFixed(2)} (last ${view.recentPressure.length} strokes).`;
  drawCurve();
}

$("#use-observed").addEventListener("click", () => {
  const obs = observedMax();
  if (obs === null) return;
  // A little headroom so ordinary strokes aren't all at full width.
  const pressureMax = Math.round(Math.min(1, Math.max(0.1, obs * 1.15)) * 100) / 100;
  conn.send({ type: "settings.set", ink: { pressureMax } });
});

function drawCurve() {
  const c = $<HTMLCanvasElement>("#curve");
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth;
  const hgt = c.clientHeight;
  if (!w || !hgt) return;
  c.width = Math.round(w * dpr);
  c.height = Math.round(hgt * dpr);
  const g = c.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const color = (v: string) => css.getPropertyValue(v).trim();
  const pad = 6;
  const X = (p: number) => pad + p * (w - 2 * pad);
  const Y = (f: number) => hgt - pad - f * (hgt - 2 * pad);

  g.strokeStyle = color("--border");
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(X(0), Y(0));
  g.lineTo(X(1), Y(1));
  g.stroke();

  const obs = observedMax();
  if (obs !== null) {
    g.strokeStyle = color("--warn");
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(X(obs), Y(0));
    g.lineTo(X(obs), Y(1));
    g.stroke();
    g.setLineDash([]);
  }

  g.strokeStyle = color("--accent");
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i <= 100; i++) {
    const p = i / 100;
    const f = applyPressureCurve(p, ink);
    if (i === 0) g.moveTo(X(p), Y(f));
    else g.lineTo(X(p), Y(f));
  }
  g.stroke();
}
renderInk();

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
function toast(text: string, kind: "error" | "info" = "error") {
  const el = $("#toast");
  el.textContent = text;
  el.classList.toggle("info", kind === "info");
  el.style.display = "block";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.style.display = "none"), 4000);
}
