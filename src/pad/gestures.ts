// Multi-finger taps on the pad: two fingers = undo, three = redo.
// A tap is: all fingers land within a short window, barely move and lift
// quickly. Anything longer (a resting palm) or while the pen is near is ignored.

const TAP_MAX_MS = 300; // first finger down → last finger up
const LAND_WINDOW_MS = 150; // all fingers must land within this
const SLOP_PX = 12;

export class TapGestures {
  private readonly touches = new Map<number, { x: number; y: number }>();
  private start = 0;
  private fingers = 0;
  private spoiled = false;

  constructor(
    private readonly onTap: (fingers: number) => void,
    /** True while the pen is touching or hovering: touches are then palm, not gestures. */
    private readonly penNear: () => boolean,
  ) {}

  down(e: PointerEvent): void {
    if (this.touches.size === 0) {
      this.start = e.timeStamp;
      this.fingers = 0;
      this.spoiled = this.penNear();
    } else if (e.timeStamp - this.start > LAND_WINDOW_MS) {
      this.spoiled = true;
    }
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.fingers = Math.max(this.fingers, this.touches.size);
  }

  move(e: PointerEvent): void {
    const t = this.touches.get(e.pointerId);
    if (t && Math.hypot(e.clientX - t.x, e.clientY - t.y) > SLOP_PX) this.spoiled = true;
  }

  up(e: PointerEvent, cancelled = false): void {
    if (!this.touches.delete(e.pointerId)) return;
    if (cancelled || this.penNear()) this.spoiled = true;
    if (this.touches.size > 0) return;
    if (!this.spoiled && this.fingers >= 2 && e.timeStamp - this.start <= TAP_MAX_MS) this.onTap(this.fingers);
  }
}
