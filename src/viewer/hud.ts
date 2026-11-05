// Latency HUD (Ctrl+Shift+L, PLAN.md §9). Every live `stroke.points` batch
// carries the pad's server-clock time of its newest pen sample (`at`) and the
// pad's own event → ink time (`lat`); the server adds its receive time (`rx`).
// The viewer notes the server-clock time of the animation frame that draws the
// batch. Both clients estimate the server clock from ping/pong (lowest-RTT
// sample), so each number is good to about ±(pad RTT + viewer RTT) / 2.
//
// "frame" is the start of the requestAnimationFrame callback that paints the
// points; the pixels reach the screen on the next vsync (+ ~1 frame, more
// with a compositor). The same goes for the pad's local ink.

import type { Connection } from "../shared/connection.ts";
import { POINT_STRIDE } from "../shared/ink.ts";
import type { StrokePointsMsg } from "../shared/protocol.ts";

const WINDOW_MS = 10_000;
const SESSION_MAX = 50_000;

interface Sample {
  /** Viewer frame time, server clock. */
  t: number;
  points: number;
  local?: number;
  up?: number;
  down?: number;
  e2e?: number;
}

type Stage = "local" | "up" | "down" | "e2e";
const STAGES: [Stage, string][] = [
  ["local", "pen event → phone ink drawn"],
  ["up", "pen event → server"],
  ["down", "server → PC frame"],
  ["e2e", "pen event → PC frame (end-to-end)"],
];

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

function stats(values: number[]): { n: number; med: number; p95: number; max: number } | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, med: quantile(s, 0.5), p95: quantile(s, 0.95), max: s[s.length - 1]! };
}

const f = (v: number) => (Math.abs(v) < 100 ? v.toFixed(1) : v.toFixed(0));

export class LatencyHud {
  private readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private pending: StrokePointsMsg[] = [];
  private frame = 0;
  private window: Sample[] = [];
  private session: Sample[] = [];
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private padRtt: number | null = null;
  private transport = "";

  constructor(
    root: HTMLElement,
    private readonly conn: Connection,
  ) {
    this.el = root;
    this.body = document.createElement("div");
    const head = document.createElement("div");
    head.className = "hud-head";
    const title = document.createElement("b");
    title.textContent = "Latency";
    const copy = this.button("Copy", "Copy the session numbers as a Markdown table", () => void this.copy(copy));
    const reset = this.button("Reset", "Forget all samples", () => {
      this.window = [];
      this.session = [];
      this.render();
    });
    const close = this.button("×", "Close (Ctrl+Shift+L)", () => this.toggle(false));
    head.append(title, copy, reset, close);
    root.append(head, this.body);
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  toggle(show = !this.visible): void {
    this.el.hidden = !show;
    if (this.renderTimer) clearInterval(this.renderTimer);
    this.renderTimer = show ? setInterval(() => this.render(), 250) : null;
    if (show) this.render();
  }

  /** Pad RTT as measured by the server, and how it's connected. */
  setPad(rtt: number | null, transport: string): void {
    this.padRtt = rtt;
    this.transport = transport;
  }

  /** A live batch arrived; it gets drawn in the next animation frame (after the renderer's). */
  points(msg: StrokePointsMsg): void {
    if (!this.visible) return;
    this.pending.push(msg);
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const now = this.conn.serverTime();
      const batch = this.pending;
      this.pending = [];
      if (now === null) return; // not synced yet
      for (const m of batch) {
        const s: Sample = { t: now, points: m.pts.length / POINT_STRIDE };
        if (m.lat !== undefined) s.local = m.lat;
        if (m.at !== undefined && m.rx !== undefined) s.up = m.rx - m.at;
        if (m.rx !== undefined) s.down = now - m.rx;
        if (m.at !== undefined) s.e2e = now - m.at;
        this.window.push(s);
        this.session.push(s);
      }
      if (this.session.length > SESSION_MAX) this.session.splice(0, this.session.length - SESSION_MAX);
    });
  }

  private button(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  private clockError(): number | null {
    const mine = this.conn.clockError;
    if (mine === null || this.padRtt === null) return null;
    return mine + this.padRtt / 2;
  }

  private render(): void {
    const now = this.conn.serverTime();
    if (now !== null) {
      const cut = now - WINDOW_MS;
      let i = 0;
      while (i < this.window.length && this.window[i]!.t < cut) i++;
      if (i) this.window.splice(0, i);
    }
    const w = this.window;
    const rows = STAGES.map(([key, label]) => {
      const st = stats(w.flatMap((s) => (s[key] === undefined ? [] : [s[key]!])));
      return `<tr><td>${label}</td>${
        st ? `<td>${f(st.med)}</td><td>${f(st.p95)}</td><td>${f(st.max)}</td>` : `<td colspan="3" class="na">—</td>`
      }</tr>`;
    });
    const span = w.length > 1 ? (w[w.length - 1]!.t - w[0]!.t) / 1000 : 0;
    const pts = w.reduce((n, s) => n + s.points, 0);
    const err = this.clockError();
    const meta = [
      this.transport ? `pad ${this.transport}` : "no pad",
      this.padRtt !== null ? `pad RTT ${f(this.padRtt)} ms` : null,
      this.conn.rtt !== null ? `viewer RTT ${f(this.conn.rtt)} ms` : null,
      err !== null ? `clock ±${f(err)} ms` : "clock not synced",
      span > 0.5 ? `${Math.round(pts / span)} pts/s · ${Math.round(w.length / span)} msg/s` : null,
    ].filter(Boolean);
    this.body.innerHTML =
      `<table><thead><tr><th>last ${WINDOW_MS / 1000} s, ms</th><th>median</th><th>p95</th><th>max</th></tr></thead>` +
      `<tbody>${rows.join("")}</tbody></table>` +
      `<div class="hud-meta">${meta.join(" · ")}</div>` +
      (w.length ? "" : `<div class="hud-meta">Write on the pad to measure.</div>`);
  }

  /** The whole session (since opened / reset) as a Markdown table, for the README. */
  private async copy(btn: HTMLButtonElement): Promise<void> {
    const s = this.session;
    const lines = [
      `| Stage | median | p95 | max | n |`,
      `|---|---|---|---|---|`,
      ...STAGES.map(([key, label]) => {
        const st = stats(s.flatMap((x) => (x[key] === undefined ? [] : [x[key]!])));
        return st ? `| ${label} | ${f(st.med)} ms | ${f(st.p95)} ms | ${f(st.max)} ms | ${st.n} |` : `| ${label} | — | — | — | 0 |`;
      }),
    ];
    const err = this.clockError();
    lines.push(
      "",
      `${this.transport || "?"} · clock ±${err === null ? "?" : f(err)} ms · ${new Date().toISOString().slice(0, 10)}`,
    );
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "No clipboard";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1200);
  }
}
