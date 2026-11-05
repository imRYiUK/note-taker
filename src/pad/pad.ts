// Phone client: pen input → local ink immediately → batched points to the PC.
// Only `pen` (and `mouse`, for desktop testing) draws; `touch` never does,
// which is the palm rejection. Fingers do multi-finger taps (undo / redo) and
// pan / pinch the zoom strip.
//
// Zoom strip (default mode): the screen shows a magnified window onto the page
// that moves on by itself as you write (shared/strip.ts). Tablet mode shows the
// whole page.
//
// Pages: the server decides which page is current (pad and viewer follow the
// same one). A page switch that arrives mid-stroke waits for pen-up.
//
// M5: pen / highlighter / eraser with colour + width palette, toolbar that
// hides while writing, blank-pad mode, pen hover → PC cursor, latency stamps
// for the viewer's HUD, fullscreen + orientation lock on the first tap, PWA.
//
// Reliability: every finished stroke goes into an outbox (also kept in
// localStorage) until the server acks it; after a reconnect the outbox is
// re-sent and the server drops duplicates by stroke id.

import { Connection, uid, type ConnStatus } from "../shared/connection.ts";
import { POINT_STRIDE, TOOL_PRESETS, type InkTool, type Rect } from "../shared/ink.ts";
import {
  LIMITS,
  type HistoryState,
  type HoverPoint,
  type NotebookState,
  type PageInfo,
  type ServerMsg,
  type StrokeData,
  type StrokePointsMsg,
  type Viewport,
} from "../shared/protocol.ts";
import { Strip, ZOOM_LIMITS, lerpRect } from "../shared/strip.ts";
import { LINED } from "../shared/templates.ts";
import { PadCanvas } from "./canvas.ts";
import { Gestures } from "./gestures.ts";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const pad = new PadCanvas($<HTMLCanvasElement>("#ink"));

// ------------------------------------------------------------------ status pill

const transport = location.hostname === "localhost" || location.hostname === "127.0.0.1" ? "USB" : "Wi-Fi";
const LABELS: Record<ConnStatus, [string, string]> = {
  connecting: ["Connecting…", "warn"],
  open: [transport, "ok"],
  closed: ["Offline — retrying", "bad"],
  unauthorized: ["Not authorized", "bad"],
  outdated: ["Reload needed", "warn"],
};

/** Mirrors `conn.status`; also valid during the Connection constructor's first callback. */
let connStatus: ConnStatus = "connecting";

function renderStatus(status: ConnStatus, detail?: string) {
  const [label, cls] = LABELS[status];
  $("#status .dot").className = `dot ${cls}`;
  $("#status-text").textContent = label;
  $("#status-detail").textContent = detail ?? "";
  $("#status").classList.toggle("alert", status !== "open");
  renderPending();
}

/** "3 unsynced" while strokes wait in the outbox for longer than a moment. */
function renderPending() {
  const n = outbox.size;
  $("#status-pending").textContent = n && connStatus !== "open" ? `${n} unsynced` : "";
}

// ------------------------------------------------------------------ outbox

interface OutboxEntry {
  stroke: StrokeData;
  /** Connection generation the stroke was fully sent on (-1 = not sent). */
  sentGen: number;
  resyncs: number;
}

const OUTBOX_KEY = "note-taker.pad.outbox";
const outbox = new Map<string, OutboxEntry>();
/** Erases made while offline, sent after the outbox (they may refer to its strokes). */
const pendingErases: { pageId: string; strokeIds: string[]; group: string }[] = [];

function loadOutbox(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "[]") as StrokeData[];
    for (const stroke of saved) outbox.set(stroke.id, { stroke, sentGen: -1, resyncs: 0 });
  } catch {
    // nothing saved / storage blocked
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveOutbox(now = false): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const write = () => {
    try {
      if (outbox.size) localStorage.setItem(OUTBOX_KEY, JSON.stringify([...outbox.values()].map((e) => e.stroke)));
      else localStorage.removeItem(OUTBOX_KEY);
    } catch {
      // quota / blocked storage — the in-memory outbox still works
    }
  };
  if (now) write();
  else saveTimer = setTimeout(write, 400);
}
// The tab may be killed in the background: write pending strokes out right away.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveOutbox(true);
});
window.addEventListener("pagehide", () => saveOutbox(true));

/** Send a whole stroke: begin, points in chunks, end. */
function sendStroke(s: StrokeData): boolean {
  if (!conn.send({ type: "stroke.begin", id: s.id, pageId: s.pageId, tool: s.tool, color: s.color, width: s.width })) {
    return false;
  }
  const total = s.pts.length / POINT_STRIDE;
  for (let i = 0; i < total; i += LIMITS.pointsPerMessage) {
    const end = Math.min(total, i + LIMITS.pointsPerMessage);
    if (!conn.send({ type: "stroke.points", id: s.id, pts: s.pts.slice(i * POINT_STRIDE, end * POINT_STRIDE) })) return false;
  }
  return conn.send({ type: "stroke.end", id: s.id, n: total });
}

/** Send everything the current connection hasn't seen yet. */
function flushOutbox(): void {
  if (conn.status !== "open") return;
  for (const e of outbox.values()) {
    if (e.sentGen === generation) continue;
    if (!sendStroke(e.stroke)) return;
    e.sentGen = generation;
  }
  while (pendingErases.length) {
    if (!conn.send({ type: "erase", ...pendingErases[0]! })) return;
    pendingErases.shift();
  }
}

// ------------------------------------------------------------------ connection

/** Bumped on every (re)connect: anything sent on an older connection must be re-sent. */
let generation = 0;
let history: HistoryState = { canUndo: false, canRedo: false };

const conn: Connection = new Connection("pad", {
  onStatus: (s, d) => {
    connStatus = s;
    if (s === "open") {
      generation++;
      flushOutbox();
    }
    renderStatus(s, d);
    renderHistory();
  },
  onRtt: (rtt) => {
    $("#status-detail").textContent = `${rtt.toFixed(1)} ms`;
  },
  onMessage: (msg) => {
    if (!defer(msg)) handle(msg);
  },
});

// Page-level messages. While the pen is down, a page switch or resize waits —
// together with everything page-related after it — until the pen lifts.
const PAGE_MSGS = new Set<ServerMsg["type"]>([
  "snapshot",
  "notebook.state",
  "viewport",
  "stroke.added",
  "strokes.removed",
  "strokes.restored",
]);
let deferred: ServerMsg[] | null = null;

function defer(msg: ServerMsg): boolean {
  if (!PAGE_MSGS.has(msg.type)) return false;
  if (deferred) {
    deferred.push(msg);
    return true;
  }
  if ((msg.type === "snapshot" || msg.type === "notebook.state") && (active || erasing)) {
    deferred = [msg];
    return true;
  }
  return false;
}

function replayDeferred(): void {
  const q = deferred;
  deferred = null;
  for (const m of q ?? []) handle(m);
}

function handle(msg: ServerMsg): void {
  switch (msg.type) {
    case "snapshot": {
      // Strokes the server doesn't have yet stay visible; offline erases stay hidden.
      const known = new Set(msg.strokes.map((s) => s.id));
      const hidden = new Set(pendingErases.flatMap((e) => e.strokeIds));
      const unsynced = [...outbox.values()]
        .map((e) => e.stroke)
        .filter((s) => s.pageId === msg.page.id && !known.has(s.id));
      pad.setPage(msg.page, [...msg.strokes.filter((s) => !hidden.has(s.id)), ...unsynced], msg.notebook.template);
      setNotebook(msg);
      initStrip(msg.page, msg.viewport);
      break;
    }
    case "notebook.state": {
      setNotebook(msg);
      const page = msg.pages.find((p) => p.id === pad.page?.id);
      if (!page) break;
      pad.updatePage(page, msg.notebook.template);
      // An infinite page grew: the strip may now go further down. Its rect stays put.
      if (strip && (strip.page.width !== page.width || strip.page.height !== page.height)) {
        const r = strip.rect;
        strip = new Strip(page, { w: r.w, h: r.h });
        strip.moveTo(r.x, r.y);
      }
      break;
    }
    case "viewport":
      // Moved from the PC. A null rect is another pad in tablet mode: keep ours.
      if (msg.pageId === pad.page?.id && msg.rect) {
        remoteMove = { x: msg.rect.x, y: msg.rect.y };
        applyRemoteMove();
      }
      break;
    case "stroke.added":
      pad.addStroke(msg.stroke);
      break;
    case "stroke.ack":
      if (outbox.delete(msg.id)) {
        saveOutbox();
        renderPending();
      }
      break;
    case "stroke.resync": {
      const e = outbox.get(msg.id);
      if (!e) break;
      if (++e.resyncs > 3) {
        console.warn(`[pad] stroke ${msg.id} keeps failing to sync; will retry after reconnecting`);
        break;
      }
      e.sentGen = -1;
      flushOutbox();
      break;
    }
    case "strokes.removed":
      if (msg.pageId === pad.page?.id) pad.removeStrokes(msg.ids);
      break;
    case "strokes.restored":
      pad.restoreStrokes(msg.strokes);
      break;
    case "history":
      history = { canUndo: msg.canUndo, canRedo: msg.canRedo };
      renderHistory();
      break;
    case "settings":
      pad.setInk(msg.ink);
      break;
  }
}

loadOutbox();
renderPending();

// ------------------------------------------------------------------ pages

let notebook: NotebookState | null = null;

function setNotebook(state: NotebookState): void {
  notebook = { notebook: state.notebook, pages: state.pages };
  renderPages();
}

function pageIndex(): number {
  return notebook?.pages.findIndex((p) => p.id === pad.page?.id) ?? -1;
}

function renderPages(): void {
  const online = connStatus === "open";
  const i = pageIndex();
  const n = notebook?.pages.length ?? 0;
  const label = $("#page-label");
  label.textContent = i >= 0 ? `${i + 1}/${n}` : "–";
  label.title = notebook ? `${notebook.notebook.title} — page ${i + 1} of ${n}` : "";
  $<HTMLButtonElement>("#page-prev").disabled = !online || i <= 0;
  $<HTMLButtonElement>("#page-next").disabled = !online || i < 0 || i >= n - 1;
  $<HTMLButtonElement>("#page-new").disabled = !online || !pad.page;
}

function gotoPage(delta: number): void {
  if (active || erasing || !notebook) return;
  const p = notebook.pages[pageIndex() + delta];
  if (p) conn.send({ type: "page.goto", pageId: p.id });
}
$("#page-prev").addEventListener("click", () => gotoPage(-1));
$("#page-next").addEventListener("click", () => gotoPage(1));
$("#page-new").addEventListener("click", () => {
  if (!active && !erasing && pad.page) conn.send({ type: "page.new", afterPageId: pad.page.id });
});

// ------------------------------------------------------------------ prefs

type Mode = "strip" | "tablet";
type PadTool = InkTool | "eraser";
interface InkStyle {
  color: string;
  width: number;
}
interface Prefs {
  mode: Mode;
  /** CSS px per page unit; null = default for this screen. */
  zoom: number | null;
  tool: PadTool;
  style: Record<InkTool, InkStyle>;
  /** Custom colour per tool (the palette's fifth swatch), if one was picked. */
  custom: Record<InkTool, string | null>;
  /** Blank pad: no ink on the phone. */
  blank: boolean;
  /** Collapse the toolbar when the pen touches down. */
  autoHide: boolean;
}

const PREFS_KEY = "note-taker.pad.prefs";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return v && typeof v === "object" ? { ...fallback, ...v } : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // not remembered — fine
  }
}

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const INK_TOOLS: readonly InkTool[] = ["pen", "highlighter"];

/** Stored prefs, with anything missing or malformed replaced by defaults. */
function loadPrefs(): Prefs {
  const raw = loadJson<Record<string, any>>(PREFS_KEY, {});
  const style = {} as Record<InkTool, InkStyle>;
  const custom = {} as Record<InkTool, string | null>;
  for (const t of INK_TOOLS) {
    const p = TOOL_PRESETS[t];
    const v = raw.style?.[t];
    const w = v?.width;
    style[t] = {
      color: isHex(v?.color) ? v.color : p.colors[0]!,
      width: typeof w === "number" && w > 0 && w <= 500 ? w : p.widths[1]!,
    };
    custom[t] = isHex(raw.custom?.[t]) ? raw.custom[t] : null;
  }
  const zoom = raw.zoom;
  return {
    mode: raw.mode === "tablet" ? "tablet" : "strip",
    zoom: typeof zoom === "number" && Number.isFinite(zoom) ? zoom : null,
    tool: raw.tool === "highlighter" || raw.tool === "eraser" ? raw.tool : "pen",
    style,
    custom,
    blank: raw.blank === true,
    autoHide: raw.autoHide !== false,
  };
}

const prefs: Prefs = loadPrefs();
const savePrefs = () => saveJson(PREFS_KEY, prefs);

// ------------------------------------------------------------------ toolbar

let tool: PadTool = "pen";
/** The ink tool the palette edits and the eraser returns to. */
let inkTool: InkTool = "pen";
const TOOL_ICON: Record<PadTool, string> = { pen: "✎", highlighter: "🖍", eraser: "⌫" };
const ERASER_COLOR = "#d2413a";

function setTool(t: PadTool) {
  tool = t;
  if (t !== "eraser") inkTool = t;
  prefs.tool = t;
  savePrefs();
  for (const k of ["pen", "highlighter", "eraser"] as const) {
    $(`#tool-${k}`).setAttribute("aria-pressed", String(k === t));
  }
  renderStyle();
}

/** Tapping the active pen / highlighter again opens its palette. */
function tapTool(t: PadTool) {
  if (t === "eraser") return setTool(tool === "eraser" ? inkTool : "eraser");
  if (t === tool) return togglePalette();
  setTool(t);
  if (!palette.hidden) renderPalette();
}
$("#tool-pen").addEventListener("click", () => tapTool("pen"));
$("#tool-highlighter").addEventListener("click", () => tapTool("highlighter"));
$("#tool-eraser").addEventListener("click", () => tapTool("eraser"));

const style = (): InkStyle => prefs.style[inkTool];

// ---- palette: four colours + custom, three widths

const palette = $("#palette");
$("#style").addEventListener("click", () => {
  if (tool === "eraser") setTool(inkTool);
  togglePalette();
});

function togglePalette(open = palette.hidden): void {
  palette.hidden = !open;
  if (open) renderPalette();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Node[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = String(v);
    else if (k === "style") e.setAttribute("style", String(v));
    else (e as any)[k] = v;
  }
  e.append(...kids);
  return e;
}

function renderPalette(): void {
  const t = inkTool;
  const cur = style();
  const presets = TOOL_PRESETS[t];
  const pick = (patch: Partial<InkStyle>) => {
    prefs.style[t] = { ...prefs.style[t], ...patch };
    savePrefs();
    renderStyle();
    renderPalette();
  };

  const colors = presets.colors.map((c) => {
    const b = el("button", { type: "button", title: c }, el("span", { class: "swatch", style: `color:${c}` }));
    b.setAttribute("aria-pressed", String(c.toLowerCase() === cur.color.toLowerCase()));
    b.addEventListener("click", () => pick({ color: c }));
    return b;
  });
  const customColor = prefs.custom[t];
  const isCustom = !presets.colors.some((c) => c.toLowerCase() === cur.color.toLowerCase());
  const input = el("input", { type: "color", value: customColor ?? cur.color });
  input.addEventListener("input", () => {
    prefs.custom[t] = input.value;
    pick({ color: input.value });
  });
  const custom = el(
    "label",
    { class: `custom${customColor ? " set" : ""}`, title: "Custom colour" },
    el("span", { class: "swatch", style: customColor ? `color:${customColor}` : "" }),
    input,
  );
  custom.setAttribute("aria-pressed", String(isCustom));
  // Tapping the custom swatch when a custom colour exists selects it; the picker still opens.
  custom.addEventListener("click", () => {
    if (customColor && !isCustom) pick({ color: customColor });
  });
  $("#pal-colors").replaceChildren(...colors, custom);

  const dots = [8, 13, 20];
  $("#pal-widths").replaceChildren(
    ...presets.widths.map((w, i) => {
      const b = el(
        "button",
        { type: "button", title: `Width ${w / 10} mm` },
        el("span", { class: "dot-w", style: `width:${dots[i]}px;height:${dots[i]}px` }),
      );
      b.setAttribute("aria-pressed", String(w === cur.width));
      b.addEventListener("click", () => pick({ width: w }));
      return b;
    }),
  );
  $<HTMLInputElement>("#autohide").checked = prefs.autoHide;
}

$<HTMLInputElement>("#autohide").addEventListener("change", (e) => {
  prefs.autoHide = (e.target as HTMLInputElement).checked;
  savePrefs();
});

function renderStyle(): void {
  const color = tool === "eraser" ? ERASER_COLOR : style().color;
  for (const sel of ["#style .swatch", "#tb-handle .swatch"]) $(sel).style.color = color;
  $("#tb-handle-tool").textContent = TOOL_ICON[tool];
}

// ---- auto-hide: the toolbar collapses to a small handle while writing

const toolbar = $("#toolbar");
const tbHandle = $<HTMLButtonElement>("#tb-handle");

function setCollapsed(collapsed: boolean): void {
  toolbar.classList.toggle("collapsed", collapsed);
  tbHandle.hidden = !collapsed;
  if (collapsed) togglePalette(false);
}
const collapsed = () => toolbar.classList.contains("collapsed");
tbHandle.addEventListener("click", () => setCollapsed(false));
$("#tb-hide").addEventListener("click", () => setCollapsed(true));

/** Pen touched the page: get the UI out of the way. */
function penStarted(): void {
  togglePalette(false);
  if (prefs.autoHide) setCollapsed(true);
}

// ---- blank pad

function setBlank(blank: boolean): void {
  prefs.blank = blank;
  savePrefs();
  pad.setBlank(blank);
  $("#blank").setAttribute("aria-pressed", String(blank));
}
$("#blank").addEventListener("click", () => setBlank(!prefs.blank));

function undo() {
  if (!active && !erasing) conn.send({ type: "undo" });
}
function redo() {
  if (!active && !erasing) conn.send({ type: "redo" });
}
$("#undo").addEventListener("click", undo);
$("#redo").addEventListener("click", redo);

// ------------------------------------------------------------------ zoom strip

const RECTS_KEY = "note-taker.pad.strip"; // { [pageId]: { x, y } }
const SHIFT_MS = 120;

const savedRects = loadJson<Record<string, { x: number; y: number }>>(RECTS_KEY, {});
let strip: Strip | null = null;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Default zoom: three ruled lines fill the short side of the screen (≈ 3× real size on the S23). */
const defaultZoom = () => Math.min(innerWidth, innerHeight) / (3 * LINED.lineHeight);
const zoom = () => clamp(prefs.zoom ?? defaultZoom(), ...ZOOM_LIMITS);
const stripSize = () => ({ w: innerWidth / zoom(), h: innerHeight / zoom() });
const stripOn = (): Strip | null => (prefs.mode === "strip" ? strip : null);

function initStrip(page: PageInfo, vp: Viewport | null): void {
  strip = new Strip(page, stripSize());
  const from = vp?.rect ?? savedRects[page.id];
  if (from) strip.moveTo(from.x, from.y);
  remoteMove = null;
  showStrip(false);
  sendViewport(); // the server may not know our size / mode yet
}

// The shift animation. Pen input always maps through the final rect: a pen-down
// mid-animation jumps to the end first (`settle`).
let anim: { from: Rect; to: Rect; t0: number; raf: number } | null = null;

function showStrip(animate: boolean): void {
  if (anim) cancelAnimationFrame(anim.raf);
  anim = null;
  const s = stripOn();
  if (!s) return pad.setView(null);
  const to = { ...s.rect };
  if (!animate) return pad.setView(to);
  const a = (anim = { from: pad.visibleRect(), to, t0: performance.now(), raf: 0 });
  const step = (now: number) => {
    if (anim !== a) return;
    const t = (now - a.t0) / SHIFT_MS;
    if (t < 1) {
      pad.moveView(lerpRect(a.from, a.to, t));
      a.raf = requestAnimationFrame(step);
    } else {
      pad.setView(a.to); // sharp final frame
      anim = null;
    }
  };
  a.raf = requestAnimationFrame(step);
}

/** Gestures move the strip many times per frame: show it at most once per frame. */
let previewFrame = 0;
function previewStrip(): void {
  if (previewFrame) return;
  previewFrame = requestAnimationFrame(() => {
    previewFrame = 0;
    const s = stripOn();
    if (s) pad.moveView(s.rect);
  });
}

function settle(): void {
  if (previewFrame) {
    cancelAnimationFrame(previewFrame);
    previewFrame = 0;
    showStrip(false);
  }
  if (!anim) return;
  cancelAnimationFrame(anim.raf);
  pad.setView(anim.to);
  anim = null;
}

function sendViewport(): void {
  if (!pad.page) return;
  conn.send({ type: "viewport", pageId: pad.page.id, rect: stripOn()?.rect ?? null });
}

/** The strip moved here: remember it and tell the server (at most once per frame). */
let vpFrame = 0;
function publishViewport(): void {
  if (vpFrame) return;
  vpFrame = requestAnimationFrame(() => {
    vpFrame = 0;
    sendViewport();
    rememberRect();
  });
}

/** Keep the strip position per page, so a reload / server restart puts it back. */
let rememberTimer: ReturnType<typeof setTimeout> | null = null;
function rememberRect(): void {
  if (!strip || !pad.page) return;
  savedRects[pad.page.id] = { x: strip.rect.x, y: strip.rect.y };
  if (rememberTimer) clearTimeout(rememberTimer);
  rememberTimer = setTimeout(() => saveJson(RECTS_KEY, savedRects), 300);
}

/** Strip position set from the PC; applied once the pen is up (never mid-stroke). */
let remoteMove: { x: number; y: number } | null = null;
function applyRemoteMove(): void {
  if (!remoteMove || !strip || active || erasing) return;
  strip.moveTo(remoteMove.x, remoteMove.y);
  remoteMove = null;
  showStrip(false);
  rememberRect();
}

/** Run a strip move from a button / timer, animated. */
function moveStrip(fn: (s: Strip) => unknown): void {
  const s = stripOn();
  if (!s || active || erasing) return;
  clearAdvance();
  fn(s);
  showStrip(true);
  publishViewport();
}

let advanceTimer: ReturnType<typeof setTimeout> | null = null;
function clearAdvance(): void {
  if (advanceTimer) clearTimeout(advanceTimer);
  advanceTimer = null;
}

/** Pen lifted after an ink stroke ending at page x: maybe arm the auto-advance. */
function armAdvance(x: number): void {
  const s = stripOn();
  if (!s) return;
  s.penUp(x, performance.now());
  if (s.dueAt === null) return;
  clearAdvance();
  advanceTimer = setTimeout(() => {
    advanceTimer = null;
    if (active || erasing) return;
    if (s === strip && s.tick(performance.now() + 1)) {
      showStrip(true);
      publishViewport();
    }
  }, s.opts.advanceDelayMs);
}

function setMode(mode: Mode): void {
  prefs.mode = mode;
  savePrefs();
  if (immersive()) lockOrientation();
  clearAdvance();
  showStrip(false);
  sendViewport();
  const isStrip = mode === "strip";
  $("#mode").textContent = isStrip ? "Strip" : "Page";
  $("#mode").title = isStrip ? "Zoom strip — tap for whole page" : "Whole page — tap for zoom strip";
  for (const id of ["#back", "#newline", "#margin"]) $(id).hidden = !isStrip;
}

$("#mode").addEventListener("click", () => setMode(prefs.mode === "strip" ? "tablet" : "strip"));
$("#back").addEventListener("click", () => moveStrip((s) => s.back()));
$("#newline").addEventListener("click", () => moveStrip((s) => s.newLine()));
// The margin handle reacts on touch-down (pen or finger): quickest way to the next line.
$("#margin").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  moveStrip((s) => s.newLine());
});

function renderHistory() {
  const online = connStatus === "open";
  $<HTMLButtonElement>("#undo").disabled = !online || !history.canUndo;
  $<HTMLButtonElement>("#redo").disabled = !online || !history.canRedo;
  renderPages();
}

// ------------------------------------------------------------------ input: ink

interface ActiveStroke {
  id: string;
  pointerId: number;
  pageId: string;
  tool: InkTool;
  t0: number;
  /** `timeStamp` of the newest sample (latency stamps). */
  lastTs: number;
  /** Pen event → local ink drawn, ms, last frame (sent for the viewer's HUD). */
  lat: number | null;
  pts: number[];
  tail: number[];
  /** Points already sent on connection `sentGen`. */
  sent: number;
  sentGen: number;
  color: string;
  width: number;
}

let active: ActiveStroke | null = null;
let frame = 0;

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Raw pressure; a mouse reports a flat 0.5, so give it a mid-range value instead. */
const pressureOf = (e: PointerEvent) => (e.pointerType === "mouse" ? 0.25 : e.pressure);

function sample(e: PointerEvent, into: number[], t0: number): void {
  if (active && into === active.pts) active.lastTs = e.timeStamp;
  const [x, y] = pad.toPage(e.clientX, e.clientY);
  const p = r3(pressureOf(e));
  const n = into.length;
  // Drop exact repeats (same spot, same pressure) — they add nothing.
  if (n >= POINT_STRIDE && into[n - 4] === r1(x) && into[n - 3] === r1(y) && into[n - 2] === p) return;
  into.push(r1(x), r1(y), p, r1(e.timeStamp - t0));
}

const draws = (e: PointerEvent) => e.pointerType === "pen" || e.pointerType === "mouse";

const canvas = pad.el;

function capture(e: PointerEvent) {
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // pointer already gone, or a synthetic/replayed event — carry on
  }
}

canvas.addEventListener("pointerdown", (e) => {
  if (!draws(e) || active || erasing || !pad.page) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  // Still writing: no auto-advance, and the strip must be still before mapping the pen.
  clearAdvance();
  strip?.penDown();
  settle();
  penStarted();
  const [x, y] = pad.toPage(e.clientX, e.clientY);
  if (tool === "eraser") {
    capture(e);
    startErase(e, x, y);
    return;
  }
  if (!pad.inPage(x, y)) return;
  capture(e);
  hover(null);
  const st = style();
  active = {
    id: uid(),
    pointerId: e.pointerId,
    pageId: pad.page.id,
    tool: inkTool,
    t0: e.timeStamp,
    lastTs: e.timeStamp,
    lat: null,
    pts: [],
    tail: [],
    sent: 0,
    sentGen: -1,
    color: st.color,
    width: st.width,
  };
  sample(e, active.pts, active.t0);
  flush(); // begin goes out right away so the PC can start drawing
  scheduleFrame();
});

canvas.addEventListener("pointermove", (e) => {
  if (erasing && e.pointerId === erasing.pointerId) return moveErase(e);
  if (!active || e.pointerId !== active.pointerId) return;
  const coalesced = e.getCoalescedEvents?.() ?? [];
  for (const c of coalesced.length ? coalesced : [e]) sample(c, active.pts, active.t0);
  active.tail = [];
  for (const p of e.getPredictedEvents?.() ?? []) sample(p, active.tail, active.t0);
  scheduleFrame();
});

// A browser-initiated cancel still keeps what was written — losing ink is worse.
for (const type of ["pointerup", "pointercancel"] as const) {
  canvas.addEventListener(type, (e) => {
    if (active && e.pointerId === active.pointerId) finish();
    if (erasing && e.pointerId === erasing.pointerId) endErase();
  });
}

function finish(): void {
  const s = active!;
  active = null;
  cancelAnimationFrame(frame);
  frame = 0;
  flush(s);
  const n = s.pts.length / POINT_STRIDE;
  const stroke: StrokeData = {
    id: s.id,
    pageId: s.pageId,
    tool: s.tool,
    color: s.color,
    width: s.width,
    pts: s.pts,
    createdAt: Date.now(),
  };
  // Kept until the server acks it; if `end` didn't go out, the reconnect re-sends it whole.
  const sent = s.sentGen === generation && conn.send({ type: "stroke.end", id: s.id, n });
  outbox.set(s.id, { stroke, sentGen: sent ? generation : -1, resyncs: 0 });
  saveOutbox();
  renderPending();
  pad.addStroke(stroke);
  if (n) armAdvance(s.pts[(n - 1) * POINT_STRIDE]!);
  applyRemoteMove();
  replayDeferred();
}

/** Send whatever the server hasn't seen yet for the active stroke. */
function flush(s: ActiveStroke | null = active): void {
  if (!s || conn.status !== "open") return;
  if (s.sentGen !== generation) {
    // New connection since the stroke began: start it over there.
    const ok = conn.send({ type: "stroke.begin", id: s.id, pageId: s.pageId, tool: s.tool, color: s.color, width: s.width });
    if (!ok) return;
    s.sentGen = generation;
    s.sent = 0;
  }
  const total = s.pts.length / POINT_STRIDE;
  while (s.sent < total) {
    const end = Math.min(total, s.sent + LIMITS.pointsPerMessage);
    const msg: StrokePointsMsg = { type: "stroke.points", id: s.id, pts: s.pts.slice(s.sent * POINT_STRIDE, end * POINT_STRIDE) };
    if (end === total) {
      // Latency stamps ride on the batch holding the newest sample.
      const at = conn.serverTime(s.lastTs);
      if (at !== null) msg.at = Math.round(at * 10) / 10;
      if (s.lat !== null) msg.lat = Math.round(s.lat * 10) / 10;
    }
    if (!conn.send(msg)) return;
    s.sent = end;
  }
}

function scheduleFrame(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (active) {
      flush();
      pad.drawLive(active);
      active.lat = performance.now() - active.lastTs;
    } else if (erasing) {
      flushErase();
      pad.drawEraser({ x: erasing.x, y: erasing.y, r: eraserRadius() });
    }
  });
}

// ------------------------------------------------------------------ input: eraser

/** Eraser size on screen; in page units it shrinks as the page is magnified (strip mode, M3). */
const ERASER_PX = 12;
const eraserRadius = () => pad.pxToPage(ERASER_PX);

interface Erasing {
  pointerId: number;
  pageId: string;
  /** One eraser gesture = one undo step on the server. */
  group: string;
  x: number;
  y: number;
  /** Erased locally, not sent yet (batched per frame). */
  batch: string[];
}
let erasing: Erasing | null = null;

function startErase(e: PointerEvent, x: number, y: number): void {
  erasing = { pointerId: e.pointerId, pageId: pad.page!.id, group: uid(), x, y, batch: [] };
  eraseAlong(x, y);
  scheduleFrame();
}

function moveErase(e: PointerEvent): void {
  const coalesced = e.getCoalescedEvents?.() ?? [];
  for (const c of coalesced.length ? coalesced : [e]) {
    const [x, y] = pad.toPage(c.clientX, c.clientY);
    eraseAlong(x, y);
  }
  scheduleFrame();
}

function eraseAlong(x: number, y: number): void {
  const er = erasing!;
  const hits = pad.hitTest(er.x, er.y, x, y, eraserRadius());
  er.x = x;
  er.y = y;
  if (!hits.length) return;
  pad.removeStrokes(hits);
  er.batch.push(...hits);
}

function flushErase(): void {
  const er = erasing;
  if (!er?.batch.length) return;
  const msg = { pageId: er.pageId, strokeIds: er.batch, group: er.group };
  er.batch = [];
  if (!conn.send({ type: "erase", ...msg })) pendingErases.push(msg);
}

function endErase(): void {
  cancelAnimationFrame(frame);
  frame = 0;
  flushErase();
  erasing = null;
  pad.drawEraser(null);
  applyRemoteMove();
  replayDeferred();
}

// ------------------------------------------------------------------ input: fingers

let lastPenAt = -Infinity;
const penNear = () => active !== null || erasing !== null || performance.now() - lastPenAt < 500;

const gestures = new Gestures(
  {
    tap: (fingers) => (fingers === 2 ? undo() : fingers === 3 ? redo() : undefined),
    pan: (dx, dy) => {
      const s = stripOn();
      if (!s) return;
      if (anim) settle();
      clearAdvance();
      s.panBy(-dx / zoom(), -dy / zoom());
      previewStrip();
      publishViewport();
    },
    pinch: (factor, cx, cy) => {
      const s = stripOn();
      if (!s) return;
      if (anim) settle();
      clearAdvance();
      // The page point under the fingers stays there. Use the strip's own rect, not the
      // screen transform: that lags behind by up to a frame while previewing.
      const ax = s.rect.x + (cx / innerWidth) * s.rect.w;
      const ay = s.rect.y + (cy / innerHeight) * s.rect.h;
      prefs.zoom = clamp(zoom() * factor, ...ZOOM_LIMITS);
      const { w, h } = stripSize();
      s.resize(w, h, { x: ax, y: ay });
      previewStrip();
      publishViewport();
    },
    end: () => {
      savePrefs();
      settle(); // sharp render now
    },
  },
  penNear,
);

/** A finger that landed on the top edge while the toolbar is hidden: swipe down (or tap) shows it. */
const EDGE_PX = 28;
let edge: { pointerId: number; y0: number } | null = null;

// Capture phase: see every pen event (incl. hover) before anything else.
canvas.addEventListener(
  "pointermove",
  (e) => {
    if (e.pointerType === "pen") lastPenAt = performance.now();
    if (draws(e)) trackHover(e);
    else if (e.pointerType === "touch") {
      if (edge?.pointerId === e.pointerId) {
        if (e.clientY - edge.y0 > 24) {
          edge = null;
          setCollapsed(false);
        }
        return;
      }
      gestures.move(e);
    }
  },
  true,
);
canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "pen") {
    lastPenAt = performance.now();
    gestures.cancel();
  }
  if (e.pointerType !== "touch") return;
  if (collapsed() && !edge && e.clientY < EDGE_PX && !penNear()) {
    edge = { pointerId: e.pointerId, y0: e.clientY };
    return;
  }
  gestures.down(e);
});
canvas.addEventListener("pointerup", (e) => {
  if (e.pointerType !== "touch") return;
  if (edge?.pointerId === e.pointerId) {
    edge = null;
    if (!penNear()) setCollapsed(false);
    return;
  }
  gestures.up(e);
});
canvas.addEventListener("pointercancel", (e) => {
  if (e.pointerType !== "touch") return;
  if (edge?.pointerId === e.pointerId) edge = null;
  else gestures.up(e, true);
});

// ------------------------------------------------------------------ hover → PC cursor

/** Pending hover update (undefined = nothing to send); sent at most once per frame. */
let hoverNext: HoverPoint | null | undefined;
let hoverSent: HoverPoint | null = null;
let hoverFrame = 0;

function hover(at: HoverPoint | null): void {
  if (at === null && hoverSent === null && hoverNext === undefined) return;
  hoverNext = at;
  if (hoverFrame) return;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    const next = hoverNext;
    hoverNext = undefined;
    if (next === undefined || (next === null && hoverSent === null)) return;
    if (conn.send({ type: "hover", at: next })) hoverSent = next;
  });
}

/** Pen moving above the screen (or erasing): show it on the PC. Ink strokes show themselves. */
function trackHover(e: PointerEvent): void {
  if (!pad.page || active) return;
  const erasingNow = erasing?.pointerId === e.pointerId;
  if (e.buttons !== 0 && !erasingNow) return;
  const [x, y] = pad.toPage(e.clientX, e.clientY);
  hover({
    pageId: pad.page.id,
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    tool,
    color: tool === "eraser" ? ERASER_COLOR : style().color,
    ...(tool === "eraser" ? {} : { width: style().width }),
  });
}
for (const type of ["pointerleave", "pointerout"] as const) {
  canvas.addEventListener(type, (e) => {
    if (draws(e) && !active && !erasing) hover(null);
  });
}

// ------------------------------------------------------------------ screen

window.addEventListener("resize", () => {
  pad.resize();
  if (!strip) return;
  const { w, h } = stripSize();
  strip.resize(w, h);
  showStrip(false);
  publishViewport();
});
pad.resize();

/** Launched from the home screen (PWA, `display: fullscreen`) — already immersive. */
const installed = () =>
  matchMedia("(display-mode: fullscreen)").matches || matchMedia("(display-mode: standalone)").matches;
const immersive = () => Boolean(document.fullscreenElement) || installed();

type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void };

/** Strip mode wants landscape (long lines); the whole page is bigger in portrait, so rotate freely. */
function lockOrientation(): void {
  const o = screen.orientation as LockableOrientation;
  try {
    if (prefs.mode === "strip") o.lock?.("landscape").catch(() => {});
    else o.unlock?.();
  } catch {
    // not supported — harmless
  }
}

async function enterFullscreen(): Promise<void> {
  try {
    if (!immersive()) await document.documentElement.requestFullscreen({ navigationUI: "hide" });
  } catch {
    // denied / not supported — keep going
  }
  if (immersive()) lockOrientation();
}

$("#fullscreen").addEventListener("click", () => void enterFullscreen());
const renderFullscreen = () => ($("#fullscreen").hidden = immersive());
document.addEventListener("fullscreenchange", renderFullscreen);
renderFullscreen();

// The first tap with the pen or a finger goes fullscreen (needs a user gesture). Done on
// pointer-up, so the resize never lands in the middle of a stroke. Only once per load:
// leaving fullscreen on purpose sticks (the button brings it back).
let autoFullscreen = true;
window.addEventListener(
  "pointerup",
  (e) => {
    if (!autoFullscreen || (e.pointerType !== "pen" && e.pointerType !== "touch")) return;
    autoFullscreen = false;
    void enterFullscreen();
  },
  true,
);

// Keep the screen awake while the pad is open (secure contexts only: localhost over USB qualifies).
let wakeLock: WakeLockSentinel | null = null;
async function keepAwake() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") {
      const lock = await navigator.wakeLock.request("screen");
      wakeLock = lock;
      // Released by the system (tab hidden, battery saver): ask again when possible.
      lock.addEventListener("release", () => {
        if (wakeLock === lock) wakeLock = null;
      });
    }
  } catch {
    wakeLock = null;
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !wakeLock) void keepAwake();
  if (document.visibilityState === "hidden") wakeLock = null;
});
void keepAwake();

inkTool = prefs.tool === "highlighter" ? "highlighter" : "pen";
setTool(prefs.tool);
setMode(prefs.mode);
setBlank(prefs.blank);
renderHistory();
if (!pad.desynchronized) console.warn("[pad] desynchronized canvas not available — ink latency will be higher");
