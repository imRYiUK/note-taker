// S Pen capability probe: verifies what Chrome on the phone actually reports
// (pressure, tilt, hover, side button, sample rate, palm/touch separation)
// and posts a JSON report to the PC. Everything later milestones rely on.

import { resolveToken } from "../shared/connection.ts";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const canvas = $<HTMLCanvasElement>("#ink");
const ctx = canvas.getContext("2d", { desynchronized: true, alpha: false })!;
const desynchronized = Boolean(
  (ctx.getContextAttributes?.() as CanvasRenderingContext2DSettings & { desynchronized?: boolean })?.desynchronized,
);

type Counts = { down: number; move: number; up: number; cancel: number; hover: number };
const zero = (): Counts => ({ down: 0, move: 0, up: 0, cancel: 0, hover: 0 });

const stats = {
  types: {} as Record<string, Counts>,
  pressure: { min: Infinity, max: -Infinity, distinct: new Set<number>() },
  tilt: { seen: false, maxAbsX: 0, maxAbsY: 0 },
  altitudeSeen: false,
  twistSeen: false,
  contact: { maxWidth: 0, maxHeight: 0 },
  buttonsWhileDown: new Set<number>(),
  buttonsWhileHover: new Set<number>(),
  buttonOnDown: new Set<number>(),
  coalesced: { events: 0, samples: 0, max: 0 },
  predicted: { events: 0, samples: 0 },
  dts: [] as number[],
  rawUpdates: 0,
  contextmenu: 0,
  auxclick: 0,
  touchWhilePen: 0,
  log: [] as string[],
};

let penDown = false;
let penHovering = false;
let lastPenEventT = -Infinity;
let lastSampleT: number | null = null;
let last: { x: number; y: number } | null = null;

const env = {
  userAgent: navigator.userAgent,
  dpr: devicePixelRatio,
  screen: `${screen.width}x${screen.height}`,
  viewport: `${innerWidth}x${innerHeight}`,
  secureContext: isSecureContext,
  wakeLockApi: "wakeLock" in navigator,
  coalescedApi: "getCoalescedEvents" in PointerEvent.prototype,
  predictedApi: "getPredictedEvents" in PointerEvent.prototype,
  rawUpdateApi: "onpointerrawupdate" in window,
  desynchronizedCanvas: desynchronized,
  maxTouchPoints: navigator.maxTouchPoints,
};

function log(line: string) {
  stats.log.push(`${Math.round(performance.now())} ${line}`);
  if (stats.log.length > 80) stats.log.shift();
}

function count(type: string, key: keyof Counts) {
  (stats.types[type] ??= zero())[key]++;
}

// ------------------------------------------------------------------ drawing

function resize() {
  canvas.width = Math.round(innerWidth * devicePixelRatio);
  canvas.height = Math.round(innerHeight * devicePixelRatio);
  clearCanvas();
}

function clearCanvas() {
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#121214";
  ctx.fillRect(0, 0, innerWidth, innerHeight);
}

function segment(x: number, y: number, pressure: number, color: string) {
  if (!last) {
    last = { x, y };
    return;
  }
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineWidth = 0.6 + pressure * 5;
  ctx.beginPath();
  ctx.moveTo(last.x, last.y);
  ctx.lineTo(x, y);
  ctx.stroke();
  last = { x, y };
}

function dot(x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// ------------------------------------------------------------------ sampling

function sample(e: PointerEvent) {
  if (e.pressure > 0) {
    stats.pressure.min = Math.min(stats.pressure.min, e.pressure);
    stats.pressure.max = Math.max(stats.pressure.max, e.pressure);
    stats.pressure.distinct.add(Math.round(e.pressure * 1000));
  }
  if (e.tiltX || e.tiltY) {
    stats.tilt.seen = true;
    stats.tilt.maxAbsX = Math.max(stats.tilt.maxAbsX, Math.abs(e.tiltX));
    stats.tilt.maxAbsY = Math.max(stats.tilt.maxAbsY, Math.abs(e.tiltY));
  }
  const alt = (e as PointerEvent & { altitudeAngle?: number }).altitudeAngle;
  if (alt !== undefined && Math.abs(alt - Math.PI / 2) > 0.01) stats.altitudeSeen = true;
  if (e.twist) stats.twistSeen = true;
  stats.contact.maxWidth = Math.max(stats.contact.maxWidth, e.width);
  stats.contact.maxHeight = Math.max(stats.contact.maxHeight, e.height);

  if (lastSampleT !== null) {
    const dt = e.timeStamp - lastSampleT;
    if (dt > 0 && dt < 50 && stats.dts.length < 4000) stats.dts.push(dt);
  }
  lastSampleT = e.timeStamp;
}

function penColor(buttons: number) {
  return buttons & 2 ? "#f0a030" : buttons & 32 ? "#e05050" : "#e8ecf5";
}

canvas.addEventListener("pointerdown", (e) => {
  count(e.pointerType, "down");
  stats.buttonOnDown.add(e.button);
  log(`down ${e.pointerType} button=${e.button} buttons=${e.buttons} p=${e.pressure.toFixed(3)}`);
  if (e.pointerType === "pen") {
    penDown = true;
    lastSampleT = null;
    last = { x: e.clientX, y: e.clientY };
    stats.buttonsWhileDown.add(e.buttons);
    canvas.setPointerCapture(e.pointerId);
  } else if (e.pointerType === "touch") {
    // Pen touching, or seen within 300 ms (hovering) — i.e. a palm, not a deliberate tap.
    if (penDown || e.timeStamp - lastPenEventT < 300) stats.touchWhilePen++;
    dot(e.clientX, e.clientY, Math.max(6, e.width / 2), "rgba(255,90,80,0.35)");
  }
  render();
});

canvas.addEventListener("pointermove", (e) => {
  const coalesced = e.getCoalescedEvents?.() ?? [];
  const samples = coalesced.length ? coalesced : [e];

  if (e.pointerType === "pen") {
    lastPenEventT = e.timeStamp;
    if (penDown && e.buttons !== 0) {
      count("pen", "move");
      stats.buttonsWhileDown.add(e.buttons);
      stats.coalesced.events++;
      stats.coalesced.samples += coalesced.length;
      stats.coalesced.max = Math.max(stats.coalesced.max, coalesced.length);
      for (const s of samples) {
        sample(s);
        segment(s.clientX, s.clientY, s.pressure, penColor(s.buttons));
      }
      const predicted = e.getPredictedEvents?.() ?? [];
      if (predicted.length) {
        stats.predicted.events++;
        stats.predicted.samples += predicted.length;
      }
    } else {
      count("pen", "hover");
      if (!penHovering) log(`hover start buttons=${e.buttons}`);
      penHovering = true;
      stats.buttonsWhileHover.add(e.buttons);
      dot(e.clientX, e.clientY, 1.2, e.buttons & 2 ? "rgba(240,160,48,0.6)" : "rgba(108,156,255,0.5)");
    }
  } else {
    count(e.pointerType, "move");
    if (e.pointerType === "touch") dot(e.clientX, e.clientY, Math.max(4, e.width / 3), "rgba(255,90,80,0.18)");
  }
  scheduleRender();
});

const end = (kind: "up" | "cancel") => (e: PointerEvent) => {
  count(e.pointerType, kind);
  if (e.pointerType === "pen") {
    penDown = false;
    last = null;
    lastSampleT = null;
  }
  log(`${kind} ${e.pointerType}`);
  render();
};
canvas.addEventListener("pointerup", end("up"));
canvas.addEventListener("pointercancel", end("cancel"));
canvas.addEventListener("pointerleave", (e) => {
  if (e.pointerType === "pen" && !penDown) {
    penHovering = false;
    log("hover end");
  }
});
canvas.addEventListener("pointerrawupdate" as "pointermove", () => {
  stats.rawUpdates++;
});
window.addEventListener("contextmenu", (e) => {
  stats.contextmenu++;
  log("contextmenu");
  e.preventDefault();
});
window.addEventListener("auxclick", () => {
  stats.auxclick++;
  log("auxclick");
});

// ------------------------------------------------------------------ report

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function report() {
  const dt = median(stats.dts);
  const pen = stats.types.pen ?? zero();
  return {
    version: 1,
    at: new Date().toISOString(),
    env,
    types: stats.types,
    pen: {
      detected: pen.down > 0,
      pressure: {
        min: Number.isFinite(stats.pressure.min) ? stats.pressure.min : null,
        max: Number.isFinite(stats.pressure.max) ? stats.pressure.max : null,
        distinctLevels: stats.pressure.distinct.size,
      },
      tilt: stats.tilt,
      altitudeSeen: stats.altitudeSeen,
      twistSeen: stats.twistSeen,
      contact: stats.contact,
      hover: pen.hover > 0,
      buttonsWhileDown: [...stats.buttonsWhileDown].sort((a, b) => a - b),
      buttonsWhileHover: [...stats.buttonsWhileHover].sort((a, b) => a - b),
      buttonOnDown: [...stats.buttonOnDown].sort((a, b) => a - b),
      sideButtonWhileDown: [...stats.buttonsWhileDown].some((b) => b & 2),
      sideButtonWhileHover: [...stats.buttonsWhileHover].some((b) => b & 2),
      sampleRateHz: dt ? Math.round(1000 / dt) : null,
      coalescedPerEvent: stats.coalesced.events ? +(stats.coalesced.samples / stats.coalesced.events).toFixed(2) : null,
      coalescedMax: stats.coalesced.max,
      predictedPerEvent: stats.predicted.events ? +(stats.predicted.samples / stats.predicted.events).toFixed(2) : null,
    },
    touch: {
      detected: (stats.types.touch?.down ?? 0) > 0,
      touchesWhilePenActive: stats.touchWhilePen,
    },
    events: { pointerrawupdate: stats.rawUpdates, contextmenu: stats.contextmenu, auxclick: stats.auxclick },
    log: stats.log,
  };
}

// ------------------------------------------------------------------ checklist UI

const checks = $("#checks");
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    render();
  }, 150);
}

function render() {
  const r = report();
  const p = r.pen;
  const rows: [string, boolean, string][] = [
    ["Write with the pen", p.detected, p.detected ? "pen" : "—"],
    [
      "Pressure varies",
      p.pressure.distinctLevels > 10,
      p.pressure.min !== null ? `${p.pressure.min.toFixed(2)}–${p.pressure.max!.toFixed(2)} · ${p.pressure.distinctLevels} lvls` : "—",
    ],
    ["Tilt reported", p.tilt.seen || p.altitudeSeen, p.tilt.seen ? `±${p.tilt.maxAbsX}°/±${p.tilt.maxAbsY}°` : "—"],
    ["Hover the pen (no touch)", p.hover, p.hover ? `${r.types.pen?.hover} evts` : "—"],
    ["Side button while writing", p.sideButtonWhileDown, `buttons ${p.buttonsWhileDown.join(",") || "—"}`],
    ["Side button while hovering", p.sideButtonWhileHover, `buttons ${p.buttonsWhileHover.join(",") || "—"}`],
    ["Rest your palm / finger", r.touch.detected, r.touch.detected ? `touch · ${r.touch.touchesWhilePenActive} w/ pen` : "—"],
    ["High-rate samples", (p.sampleRateHz ?? 0) >= 100, p.sampleRateHz ? `${p.sampleRateHz} Hz · ${p.coalescedPerEvent}/evt` : "—"],
    ["Predicted events", (p.predictedPerEvent ?? 0) > 0, p.predictedPerEvent ? `${p.predictedPerEvent}/evt` : env.predictedApi ? "api ok" : "no api"],
    ["Low-latency canvas", env.desynchronizedCanvas, env.desynchronizedCanvas ? "desynchronized" : "no"],
    ["Wake lock available", env.secureContext && env.wakeLockApi, env.secureContext ? "secure" : "insecure ctx"],
  ];
  checks.replaceChildren(
    ...rows.map(([label, pass, value]) => {
      const li = document.createElement("li");
      li.className = pass ? "pass" : "";
      li.innerHTML = `<span class="mark">${pass ? "✓" : "○"}</span><span></span><span class="v"></span>`;
      li.children[1]!.textContent = label;
      li.children[2]!.textContent = value;
      return li;
    }),
  );
}

$("#send").addEventListener("click", async () => {
  const result = $("#result");
  result.textContent = "Sending…";
  const token = resolveToken();
  try {
    const res = await fetch(`/api/probe${token ? `?token=${encodeURIComponent(token)}` : ""}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report()),
    });
    const body = await res.json();
    result.textContent = res.ok ? "Sent ✓ — the PC has the report" : `Failed: ${body.error ?? res.status}`;
  } catch (e) {
    result.textContent = `Failed: ${(e as Error).message}`;
  }
});

$("#clear").addEventListener("click", clearCanvas);
$("#toggle").addEventListener("click", () => {
  const panel = $("#panel");
  panel.classList.toggle("min");
  $("#toggle").textContent = panel.classList.contains("min") ? "+" : "–";
});

const token = resolveToken();
if (token && !["localhost", "127.0.0.1"].includes(location.hostname)) {
  $<HTMLAnchorElement>("#back").href = `/pad?token=${token}`;
}

addEventListener("resize", resize);
resize();
render();
