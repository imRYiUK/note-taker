// Phone client: pen input → local ink immediately → batched points to the PC.
// Only `pen` (and `mouse`, for desktop testing) draws; `touch` never does,
// which is the palm rejection.

import { Connection, uid, type ConnStatus } from "../shared/connection.ts";
import { DEFAULT_PEN_COLOR, DEFAULT_PEN_WIDTH, POINT_STRIDE } from "../shared/ink.ts";
import { LIMITS, type StrokeData } from "../shared/protocol.ts";
import { PadCanvas } from "./canvas.ts";

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

function renderStatus(status: ConnStatus, detail?: string) {
  const [label, cls] = LABELS[status];
  $("#status .dot").className = `dot ${cls}`;
  $("#status-text").textContent = label;
  $("#status-detail").textContent = detail ?? "";
  $("#status").classList.toggle("alert", status !== "open");
}

// ------------------------------------------------------------------ connection

/** Bumped on every (re)connect: a stroke begun on an older connection must be re-sent. */
let generation = 0;

const conn = new Connection("pad", {
  onStatus: (s, d) => {
    if (s === "open") generation++;
    renderStatus(s, d);
  },
  onRtt: (rtt) => {
    $("#status-detail").textContent = `${rtt.toFixed(1)} ms`;
  },
  onMessage: (msg) => {
    switch (msg.type) {
      case "snapshot":
        pad.setPage(msg.page, msg.strokes);
        break;
      case "stroke.added":
        pad.addStroke(msg.stroke);
        break;
      case "settings":
        pad.setInk(msg.ink);
        break;
    }
  },
});

// ------------------------------------------------------------------ input

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

canvas.addEventListener("pointerdown", (e) => {
  if (!draws(e) || active || !pad.page) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const [x, y] = pad.toPage(e.clientX, e.clientY);
  if (!pad.inPage(x, y)) return;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // pointer already gone, or a synthetic/replayed event — draw anyway
  }
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
  });
}

function finish(): void {
  const s = active!;
  active = null;
  cancelAnimationFrame(frame);
  frame = 0;
  flush(s);
  if (s.sentGen === generation) conn.send({ type: "stroke.end", id: s.id, n: s.pts.length / POINT_STRIDE });
  // Not delivered when offline: it disappears again on the next snapshot (pad outbox comes in M2).
  const stroke: StrokeData = {
    id: s.id,
    pageId: s.pageId,
    tool: "pen",
    color: s.color,
    width: s.width,
    pts: s.pts,
    createdAt: Date.now(),
  };
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
    if (!active) return;
    flush();
    pad.drawLive(active);
  });
}

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

if (!pad.desynchronized) console.warn("[pad] desynchronized canvas not available — ink latency will be higher");
