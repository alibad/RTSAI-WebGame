// Touch controls for the battlefield (phones and tablets), on top of the same engine commands as the mouse:
//   tap               select the own unit under the finger (twice: every unit of that type on screen); with units
//                     selected, anywhere else orders them there (move, attack, capture... as a right-click would);
//                     with a mode on (sell, repair, attack-move, guard, placing a building) applies it there
//   long-press        orders the selection to that spot even onto own units (guard, repair, enter) = right-click
//   one-finger drag   selection box
//   two fingers       pan and pinch-zoom; a quick two-finger tap clears the selection (or the active mode)

export interface TouchTarget {
  toWorld(x: number, y: number): [number, number];
  /** An own, selectable unit at this world position. */
  ownAt(wx: number, wy: number): boolean;
  hasSelection(): boolean;
  mode(): string;
  select(wx: number, wy: number): void;
  order(wx: number, wy: number): void;
  modeClick(wx: number, wy: number): void;
  boxSelect(x0: number, y0: number, x1: number, y1: number): void;
  setBox(box: [number, number, number, number] | null): void;
  clear(): void;
  pan(dx: number, dy: number): void;
  zoomAt(x: number, y: number, factor: number): void;
}

const LONG_PRESS_MS = 450;
const MOVE_SLOP = 10; // CSS px before a touch counts as a drag

interface Finger { x: number; y: number; x0: number; y0: number; t0: number }

export class TouchControls {
  private fingers = new Map<number, Finger>();
  private longPress: ReturnType<typeof setTimeout> | null = null;
  private handled = false; // the current one-finger gesture already did something (long-press)
  private boxing = false;
  private multi: { dist: number; mx: number; my: number; t0: number; moved: boolean } | null = null;

  constructor(private el: HTMLElement, private t: TouchTarget) {
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", (e) => this.down(e));
    el.addEventListener("pointermove", (e) => this.move(e));
    el.addEventListener("pointerup", (e) => this.up(e));
    el.addEventListener("pointercancel", (e) => this.cancel(e));
  }

  private down(e: PointerEvent) {
    if (e.pointerType !== "touch") return;
    e.preventDefault(); // no compatibility mouse events: the mouse handlers stay for mice
    this.el.setPointerCapture?.(e.pointerId);
    this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
    if (this.fingers.size === 1) {
      this.handled = false;
      this.boxing = false;
      this.clearLongPress();
      this.longPress = setTimeout(() => {
        const f = this.fingers.get(e.pointerId);
        if (!f || this.fingers.size !== 1 || this.boxing) return;
        this.handled = true;
        const [wx, wy] = this.t.toWorld(f.x, f.y);
        if (this.t.hasSelection()) {
          this.t.order(wx, wy);
          navigator.vibrate?.(12);
        }
      }, LONG_PRESS_MS);
    } else if (this.fingers.size === 2) {
      this.clearLongPress();
      if (this.boxing) { this.boxing = false; this.t.setBox(null); }
      this.handled = true;
      const [a, b] = [...this.fingers.values()];
      this.multi = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, t0: performance.now(), moved: false };
    }
  }

  private move(e: PointerEvent) {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    f.x = e.clientX;
    f.y = e.clientY;
    if (this.fingers.size === 1 && !this.handled) {
      if (!this.boxing && Math.hypot(f.x - f.x0, f.y - f.y0) > MOVE_SLOP) {
        this.boxing = true;
        this.clearLongPress();
      }
      if (this.boxing) {
        const [x0, y0] = this.t.toWorld(f.x0, f.y0);
        const [x1, y1] = this.t.toWorld(f.x, f.y);
        this.t.setBox([x0, y0, x1, y1]);
      }
    } else if (this.fingers.size === 2 && this.multi) {
      const [a, b] = [...this.fingers.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (Math.hypot(mx - this.multi.mx, my - this.multi.my) > 2 || Math.abs(dist - this.multi.dist) > 4) this.multi.moved = true;
      this.t.pan(mx - this.multi.mx, my - this.multi.my);
      if (this.multi.dist > 0 && dist > 0) this.t.zoomAt(mx, my, dist / this.multi.dist);
      this.multi.mx = mx;
      this.multi.my = my;
      this.multi.dist = dist;
    }
  }

  private up(e: PointerEvent) {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    this.fingers.delete(e.pointerId);
    if (this.multi) {
      if (this.fingers.size === 0) {
        // A quick two-finger tap: clear the mode or the selection.
        if (!this.multi.moved && performance.now() - this.multi.t0 < 300) this.t.clear();
        this.multi = null;
      }
      return;
    }
    this.clearLongPress();
    if (this.handled) return;
    if (this.boxing) {
      this.boxing = false;
      this.t.setBox(null);
      const [x0, y0] = this.t.toWorld(f.x0, f.y0);
      const [x1, y1] = this.t.toWorld(f.x, f.y);
      this.t.boxSelect(x0, y0, x1, y1);
      return;
    }
    const [wx, wy] = this.t.toWorld(f.x, f.y);
    if (this.t.mode()) this.t.modeClick(wx, wy);
    else if (this.t.ownAt(wx, wy) || !this.t.hasSelection()) this.t.select(wx, wy);
    else this.t.order(wx, wy);
  }

  private cancel(e: PointerEvent) {
    this.fingers.delete(e.pointerId);
    this.clearLongPress();
    if (this.boxing) { this.boxing = false; this.t.setBox(null); }
    if (this.fingers.size === 0) this.multi = null;
  }

  private clearLongPress() {
    if (this.longPress) clearTimeout(this.longPress);
    this.longPress = null;
  }
}
