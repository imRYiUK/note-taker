// Phone client: pen input → local ink immediately → batched points to the PC.
// Only `pen` (and `mouse`, for desktop testing) draws; `touch` never does,
// which is the palm rejection. Fingers do multi-finger taps (undo / redo).
//
// Reliability: every finished stroke goes into an outbox (also kept in
// localStorage) until the server acks it; after a reconnect the outbox is
// re-sent and the server drops duplicates by stroke id.

import { Connection, uid, type ConnStatus } from "../shared/connection.ts";
import { DEFAULT_PEN_COLOR, DEFAULT_PEN_WIDTH, POINT_STRIDE } from "../shared/ink.ts";
import { LIMITS, type HistoryState, type StrokeData } from "../shared/protocol.ts";
import { PadCanvas } from "./canvas.ts";
import { TapGestures } from "./gestures.ts";

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
    switch (msg.type) {
      case "snapshot": {
        // Strokes the server doesn't have yet stay visible; offline erases stay hidden.
        const known = new Set(msg.strokes.map((s) => s.id));
        const hidden = new Set(pendingErases.flatMap((e) => e.strokeIds));
        const unsynced = [...outbox.values()]
          .map((e) => e.stroke)
          .filter((s) => s.pageId === msg.page.id && !known.has(s.id));
        pad.setPage(msg.page, [...msg.strokes.filter((s) => !hidden.has(s.id)), ...unsynced]);
        break;
      }
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
  },
});

loadOutbox();
renderPending();

// ------------------------------------------------------------------ toolbar

type Tool = "pen" | "eraser";
let tool: Tool = "pen";

function setTool(t: Tool) {
  tool = t;
  $("#tool-pen").setAttribute("aria-pressed", String(t === "pen"));
  $("#tool-eraser").setAttribute("aria-pressed", String(t === "eraser"));
}
$("#tool-pen").addEventListener("click", () => setTool("pen"));
$("#tool-eraser").addEventListener("click", () => setTool(tool === "eraser" ? "pen" : "eraser"));

function undo() {
  if (!active && !erasing) conn.send({ type: "undo" });
}
function redo() {
  if (!active && !erasing) conn.send({ type: "redo" });
}
$("#undo").addEventListener("click", undo);
$("#redo").addEventListener("click", redo);

function renderHistory() {
  const online = connStatus === "open";
  $<HTMLButtonElement>("#undo").disabled = !online || !history.canUndo;
  $<HTMLButtonElement>("#redo").disabled = !online || !history.canRedo;
}

// ------------------------------------------------------------------ input: ink

interface ActiveStroke {
  id: string;
  pointerId: number;
  pageId: string;
  t0: number;
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
  const [x, y] = pad.toPage(e.clientX, e.clientY);
  if (tool === "eraser") {
    capture(e);
    startErase(e, x, y);
    return;
  }
  if (!pad.inPage(x, y)) return;
  capture(e);
  active = {
    id: uid(),
    pointerId: e.pointerId,
    pageId: pad.page.id,
    t0: e.timeStamp,
    pts: [],
    tail: [],
    sent: 0,
    sentGen: -1,
    color: DEFAULT_PEN_COLOR,
    width: DEFAULT_PEN_WIDTH,
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
    tool: "pen",
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
}

/** Send whatever the server hasn't seen yet for the active stroke. */
function flush(s: ActiveStroke | null = active): void {
  if (!s || conn.status !== "open") return;
  if (s.sentGen !== generation) {
    // New connection since the stroke began: start it over there.
    const ok = conn.send({ type: "stroke.begin", id: s.id, pageId: s.pageId, tool: "pen", color: s.color, width: s.width });
    if (!ok) return;
    s.sentGen = generation;
    s.sent = 0;
  }
  const total = s.pts.length / POINT_STRIDE;
  while (s.sent < total) {
    const end = Math.min(total, s.sent + LIMITS.pointsPerMessage);
    if (!conn.send({ type: "stroke.points", id: s.id, pts: s.pts.slice(s.sent * POINT_STRIDE, end * POINT_STRIDE) })) return;
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
}

// ------------------------------------------------------------------ input: fingers

let lastPenAt = -Infinity;
const penNear = () => active !== null || erasing !== null || performance.now() - lastPenAt < 500;

const taps = new TapGestures((fingers) => (fingers === 2 ? undo() : fingers === 3 ? redo() : undefined), penNear);

// Capture phase: see every pen event (incl. hover) before anything else.
canvas.addEventListener(
  "pointermove",
  (e) => {
    if (e.pointerType === "pen") lastPenAt = performance.now();
    else if (e.pointerType === "touch") taps.move(e);
  },
  true,
);
canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "pen") lastPenAt = performance.now();
  if (e.pointerType === "touch") taps.down(e);
});
canvas.addEventListener("pointerup", (e) => e.pointerType === "touch" && taps.up(e));
canvas.addEventListener("pointercancel", (e) => e.pointerType === "touch" && taps.up(e, true));

// ------------------------------------------------------------------ screen

window.addEventListener("resize", () => pad.resize());
pad.resize();

// No orientation lock yet: the whole A4 page is bigger in portrait. Strip mode (M3) locks landscape.
$("#fullscreen").addEventListener("click", async () => {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
  } catch {
    // not supported / denied — harmless
  }
});
document.addEventListener("fullscreenchange", () => {
  $("#fullscreen").hidden = Boolean(document.fullscreenElement);
});

// Keep the screen awake while the pad is open (secure contexts only: localhost over USB qualifies).
let wakeLock: WakeLockSentinel | null = null;
async function keepAwake() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
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

setTool("pen");
renderHistory();
if (!pad.desynchronized) console.warn("[pad] desynchronized canvas not available — ink latency will be higher");
