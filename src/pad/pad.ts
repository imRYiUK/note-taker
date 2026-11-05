import { Connection, deviceId, resolveToken, type ConnStatus } from "../shared/connection.ts";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const dot = $("#status .dot");
const statusText = $("#status-text");
const detail = $("#detail");
const meta = $("#meta");

const LABELS: Record<ConnStatus, [string, string]> = {
  connecting: ["Connecting…", "warn"],
  open: ["Connected", "ok"],
  closed: ["Disconnected — retrying", "bad"],
  unauthorized: ["Not authorized", "bad"],
  outdated: ["Reload needed", "warn"],
};

const transport = location.hostname === "localhost" || location.hostname === "127.0.0.1" ? "USB" : "Wi-Fi";

function render(status: ConnStatus, extra?: string) {
  const [label, cls] = LABELS[status];
  dot.className = `dot ${cls}`;
  statusText.textContent = status === "open" ? `${label} via ${transport}` : label;
  if (extra !== undefined) detail.textContent = extra;
  else if (status !== "open") detail.textContent = "";
}

const conn = new Connection("pad", {
  onStatus: (s, d) => render(s, d),
  onRtt: (rtt) => {
    detail.textContent = `round-trip ${rtt.toFixed(1)} ms`;
  },
});
void conn;

// Keep the token on the probe link for Wi-Fi sessions.
const token = resolveToken();
if (token && transport === "Wi-Fi") $<HTMLAnchorElement>("#probe-link").href = `/probe?token=${token}`;

meta.textContent = `device ${deviceId().slice(0, 8)} · ${screen.width}×${screen.height} @${devicePixelRatio}x`;

// Fullscreen + landscape lock (lock only works while fullscreen).
$("#fullscreen").addEventListener("click", async () => {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape");
  } catch {
    // not supported / denied — harmless
  }
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
