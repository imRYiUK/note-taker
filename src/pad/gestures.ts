// Finger gestures on the pad (fingers never draw):
//   • two-finger tap = undo, three-finger tap = redo
//   • one-finger drag = pan the strip
//   • two-finger drag / pinch = pan + zoom the strip
// A tap is: all fingers land within a short window, barely move and lift
// quickly. Touches while the pen is near (touching or hovering) are palm and
// ignored, as are contacts too big to be a fingertip.
//
// DOM-free (takes pointer-event-shaped objects) so it can be unit tested.

const TAP_MAX_MS = 300; // first finger down → last finger up
const LAND_WINDOW_MS = 150; // all fingers must land within this
const SLOP_PX = 12;
/** Contact wider than this (CSS px) is a palm / side of the hand, never a gesture. */
const PALM_PX = 60;

export interface TouchLike {
  pointerId: number;
  clientX: number;
  clientY: number;
  timeStamp: number;
  width?: number;
  height?: number;
}

export interface GestureHandlers {
  tap(fingers: number): void;
  /** One- or two-finger drag, CSS px since the last call. */
  pan(dx: number, dy: number): void;
  /** Two-finger pinch: scale factor since the last call, around (cx, cy) client px. */
  pinch(factor: number, cx: number, cy: number): void;
  /** A pan / pinch finished (persist, snap, …). */
  end(): void;
}

type Mode = "pending" | "pan" | "pinch" | "ignored";

interface Touch {
  x: number;
  y: number;
  x0: number;
  y0: number;
}

export class Gestures {
  private readonly touches = new Map<number, Touch>();
  private mode: Mode = "pending";
  private start = 0;
  private fingers = 0;
  private tapOk = true;
  // Pinch baseline: the two fingers tracked and their last centre / distance.
  private pair: [number, number] | null = null;
  private last = { cx: 0, cy: 0, d: 0 };

  constructor(
    private readonly on: GestureHandlers,
    /** True while the pen is touching or hovering: touches are then palm, not gestures. */
    private readonly penNear: () => boolean,
  ) {}

  get active(): boolean {
    return this.mode === "pan" || this.mode === "pinch";
  }

  down(e: TouchLike): void {
    const palm = Math.max(e.width ?? 0, e.height ?? 0) > PALM_PX;
    if (this.touches.size === 0) {
      this.start = e.timeStamp;
      this.fingers = 0;
      this.tapOk = true;
      this.pair = null;
      this.mode = this.penNear() || palm ? "ignored" : "pending";
    } else {
      if (e.timeStamp - this.start > LAND_WINDOW_MS) this.tapOk = false;
      if (palm) this.stop();
    }
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    this.fingers = Math.max(this.fingers, this.touches.size);
    // A second finger joining a drag turns it into a pinch; extra fingers ride along.
    if (this.mode === "pan" && this.touches.size === 2) this.beginPinch();
  }

  move(e: TouchLike): void {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    const px = t.x;
    const py = t.y;
    t.x = e.clientX;
    t.y = e.clientY;
    if (this.mode === "ignored") return;
    if (this.penNear()) return this.stop();

    if (this.mode === "pending") {
      if (Math.hypot(t.x - t.x0, t.y - t.y0) <= SLOP_PX) return;
      this.tapOk = false;
      if (this.touches.size === 1) this.mode = "pan";
      else if (this.touches.size === 2) this.beginPinch();
      else return this.stop(); // three-finger drags mean nothing
      return; // the slop distance itself isn't applied: no jump on start
    }
    if (this.mode === "pan") {
      this.on.pan(t.x - px, t.y - py);
      return;
    }
    if (this.mode === "pinch" && this.pair?.includes(e.pointerId)) {
      const { cx, cy, d } = this.measure();
      if (this.last.d > 0 && d > 0) this.on.pinch(d / this.last.d, this.last.cx, this.last.cy);
      this.on.pan(cx - this.last.cx, cy - this.last.cy);
      this.last = { cx, cy, d };
    }
  }

  up(e: TouchLike, cancelled = false): void {
    if (!this.touches.delete(e.pointerId)) return;
    if (cancelled || this.penNear()) this.tapOk = false;
    if (this.active) {
      // Lifting a finger ends a pan / pinch; the rest is ignored until all are up.
      this.stop();
    }
    if (this.touches.size > 0) return;
    const wasPending = this.mode === "pending";
    this.mode = "pending";
    if (wasPending && this.tapOk && this.fingers >= 2 && e.timeStamp - this.start <= TAP_MAX_MS) {
      this.on.tap(this.fingers);
    }
  }

  /** Abandon the current gesture (e.g. the pen came down). */
  cancel(): void {
    if (this.touches.size) this.stop();
  }

  private stop(): void {
    const wasActive = this.active;
    this.mode = "ignored";
    this.tapOk = false;
    this.pair = null;
    if (wasActive) this.on.end();
  }

  private beginPinch(): void {
    const ids = [...this.touches.keys()].slice(0, 2);
    if (ids.length < 2) {
      this.mode = "pan";
      return;
    }
    this.mode = "pinch";
    this.pair = [ids[0]!, ids[1]!];
    this.last = this.measure();
  }

  private measure(): { cx: number; cy: number; d: number } {
    const a = this.touches.get(this.pair![0])!;
    const b = this.touches.get(this.pair![1])!;
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  }
}
