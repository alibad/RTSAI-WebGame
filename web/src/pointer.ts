// Mouse lock: keeps the mouse inside the game (Pointer Lock API) so the map scrolls at the screen edges like the
// desktop game instead of the cursor leaving the window. Locks on the first click into the battlefield, draws the
// game's own cursor (the mod's cursor art, the engine's context cursor) from the movement deltas, clamped to the
// window, and re-targets every mouse event to whatever is under that drawn cursor, so the sidebar, minimap, menus
// and every HUD control keep working. The browser releases the lock on Esc (and when the window loses focus); the
// next click into the battlefield locks again. Skipped on touch screens, and off when the player turns it off.

import { cursorFrame, modCursor, type ModCursor } from "./ui/cursors";

const SETTING = "rtsai.mouseLock";
const HINT = "rtsai.mouseLockHint";

export function mouseLockSetting(): boolean {
  try { return localStorage.getItem(SETTING) !== "0"; } catch { return true; }
}

export function setMouseLockSetting(on: boolean) {
  try { localStorage.setItem(SETTING, on ? "1" : "0"); } catch { /* private window: per session only */ }
}

const MOUSE_EVENTS = ["mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "wheel", "mousemove", "pointermove", "pointerdown", "pointerup", "pointerover", "pointerout", "mouseover", "mouseout"] as const;

const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll" || overflow === "overlay";
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

export class MouseLock {
  /** The drawn cursor's position (CSS px, inside the window). */
  x = 0;
  y = 0;
  private el: HTMLDivElement;
  private hint: HTMLDivElement | null = null;
  private over: Element | null = null;
  private down: { target: Element; button: number } | null = null;
  /** A scrollbar thumb being dragged, and the range input being slid (replayed events do neither by themselves). */
  private thumb: { el: Element; y0: number; top0: number; per: number } | null = null;
  private slider: HTMLInputElement | null = null;
  private lastClick = { t: 0, x: 0, y: 0, target: null as Element | null };
  private cursorName = "default";
  private shown: { c: ModCursor | null; f: number } = { c: null, f: -1 };
  private raf = 0;
  /** When the lock last ended (Esc, focus loss): that Esc belongs to the browser, not to the game. */
  releasedAt = -1e9;
  enabled = mouseLockSetting();

  constructor(private canvas: HTMLCanvasElement, private onChange: () => void) {
    this.el = document.createElement("div");
    this.el.setAttribute("aria-hidden", "true");
    this.el.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;display:none;will-change:transform;image-rendering:pixelated";
    document.body.appendChild(this.el);
    document.addEventListener("pointerlockchange", this.onLockChange);
    for (const type of MOUSE_EVENTS) window.addEventListener(type, this.intercept, { capture: true, passive: false });
    window.addEventListener("blur", this.onBlur);
  }

  get locked() { return document.pointerLockElement === this.canvas; }

  /** A press on the battlefield: take the lock there (a user gesture), unless off, touch, or already locked. */
  maybeLock(e: MouseEvent) {
    if (!this.enabled || this.locked || !e.isTrusted || (e as PointerEvent).pointerType === "touch" || matchMedia("(pointer: coarse)").matches) return;
    this.x = e.clientX;
    this.y = e.clientY;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => { /* refused (e.g. too soon after Esc): the next click tries again */ });
    } catch { /* not supported */ }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    setMouseLockSetting(on);
    if (!on && this.locked) document.exitPointerLock();
  }

  /** The cursor the drawn pointer shows (the engine's name; "default" over the HUD). */
  setCursor(name: string) {
    this.cursorName = name;
  }

  /** The element under the drawn cursor (the cursor itself never is: it takes no pointer events). */
  elementAt() {
    return document.elementFromPoint(this.x, this.y);
  }

  dispose() {
    document.removeEventListener("pointerlockchange", this.onLockChange);
    for (const type of MOUSE_EVENTS) window.removeEventListener(type, this.intercept, { capture: true });
    window.removeEventListener("blur", this.onBlur);
    cancelAnimationFrame(this.raf);
    if (this.locked) document.exitPointerLock();
    this.el.remove();
    this.hint?.remove();
  }

  private onBlur = () => { this.releasedAt = performance.now(); };

  private onLockChange = () => {
    if (this.locked) {
      this.el.style.display = "block";
      this.over = null;
      this.draw();
      this.showHintOnce();
    } else {
      this.releasedAt = performance.now();
      this.el.style.display = "none";
      // Hand the hover state back to the real pointer.
      if (this.over) this.dispatchMouse("mouseout", this.over, 0, null);
      this.over = null;
      this.thumb = null;
      this.slider = null;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.onChange();
  };

  private showHintOnce() {
    try { if (localStorage.getItem(HINT)) return; localStorage.setItem(HINT, "1"); } catch { /* show it anyway */ }
    const h = document.createElement("div");
    h.textContent = "Esc releases the mouse";
    h.style.cssText = "position:fixed;left:50%;top:14%;transform:translateX(-50%);z-index:2147483646;pointer-events:none;padding:6px 12px;border-radius:3px;background:rgba(10,12,10,0.85);color:#f1d28b;font:600 13px system-ui,sans-serif;letter-spacing:.02em;box-shadow:0 4px 14px rgba(0,0,0,.5);transition:opacity .4s";
    document.body.appendChild(h);
    this.hint = h;
    setTimeout(() => { h.style.opacity = "0"; }, 2200);
    setTimeout(() => { h.remove(); if (this.hint === h) this.hint = null; }, 2700);
  }

  /** Real mouse events while locked: move the drawn cursor, then replay the event on the element under it. */
  private intercept = (e: Event) => {
    if (!e.isTrusted || !this.locked) return;
    const m = e as MouseEvent;
    e.stopImmediatePropagation();
    if (e.type !== "wheel") e.preventDefault();
    switch (e.type) {
      case "mousemove": {
        this.x = Math.min(window.innerWidth - 1, Math.max(0, this.x + m.movementX));
        this.y = Math.min(window.innerHeight - 1, Math.max(0, this.y + m.movementY));
        if (this.thumb) {
          const t = this.thumb;
          t.el.scrollTop = t.top0 + (this.y - t.y0) * t.per;
          this.schedule();
          break;
        }
        if (this.slider) this.slide(this.slider);
        const target = this.elementAt();
        if (target !== this.over) {
          if (this.over) this.dispatchMouse("mouseout", this.over, m.buttons, m, target);
          if (target) this.dispatchMouse("mouseover", target, m.buttons, m, this.over);
          this.enterLeave(this.over, target, m);
          this.over = target;
        }
        if (target) {
          this.dispatchPointer("pointermove", target, m);
          this.dispatchMouse("mousemove", target, m.buttons, m);
        }
        this.schedule();
        break;
      }
      case "mousedown": {
        const target = this.elementAt();
        if (!target) break;
        if (m.button === 0 && this.pressScrollbar(target)) break;
        this.down = { target, button: m.button };
        this.dispatchPointer("pointerdown", target, m);
        this.dispatchMouse("mousedown", target, m.buttons, m);
        // A synthetic press neither focuses nor opens a text box by itself.
        const focusable = (target as HTMLElement).closest?.("input, textarea, select, [tabindex], button, a[href]") as HTMLElement | null;
        if (focusable && focusable !== document.activeElement) focusable.focus({ preventScroll: true });
        // Nor does it move a slider: it follows the drawn cursor until the release.
        const range = (target as HTMLElement).closest?.('input[type="range"]') as HTMLInputElement | null;
        if (m.button === 0 && range && !range.disabled) {
          this.slider = range;
          this.slide(range);
        }
        break;
      }
      case "mouseup": {
        if (this.thumb) {
          this.thumb = null;
          break;
        }
        const slider = this.slider;
        if (slider) {
          // The release belongs to the slider wherever the cursor ended, as with a captured pointer.
          this.slider = null;
          this.down = null;
          this.dispatchPointer("pointerup", slider, m);
          this.dispatchMouse("mouseup", slider, m.buttons, m);
          slider.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }
        const target = this.elementAt();
        if (!target) break;
        this.dispatchPointer("pointerup", target, m);
        this.dispatchMouse("mouseup", target, m.buttons, m);
        const d = this.down;
        this.down = null;
        if (d && d.button === m.button && (d.target === target || d.target.contains(target) || target.contains(d.target))) {
          const node = d.target.contains(target) ? target : d.target;
          if (m.button === 0) {
            this.dispatchMouse("click", node, 0, m);
            const now = performance.now();
            if (now - this.lastClick.t < 500 && this.lastClick.target === node && Math.hypot(this.x - this.lastClick.x, this.y - this.lastClick.y) < 6) {
              this.dispatchMouse("dblclick", node, 0, m);
              this.lastClick.t = 0;
            } else this.lastClick = { t: now, x: this.x, y: this.y, target: node };
          } else {
            this.dispatchMouse("auxclick", node, 0, m);
            if (m.button === 2) this.dispatchMouse("contextmenu", node, 0, m);
          }
        }
        break;
      }
      case "wheel": {
        const w = e as WheelEvent;
        const target = this.elementAt();
        if (!target) break;
        const ok = target.dispatchEvent(new WheelEvent("wheel", { ...this.init(w, w.buttons), deltaX: w.deltaX, deltaY: w.deltaY, deltaZ: w.deltaZ, deltaMode: w.deltaMode }));
        if (!ok || this.wheelScroll(target, w)) e.preventDefault();
        break;
      }
      default:
        // click, dblclick, auxclick, contextmenu, pointer*: synthesised above from down/up/move.
        break;
    }
  };

  /** The browser scrolls only what is under the real (hidden) pointer: scroll the panel under the drawn one. */
  private wheelScroll(target: Element, w: WheelEvent) {
    const unit = w.deltaMode === 1 ? 40 : 1;
    let dx = w.deltaX * unit, dy = w.deltaY * unit;
    if (w.shiftKey && !dx) { dx = dy; dy = 0; }
    for (let el: Element | null = target; el; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const y = !!dy && scrolls(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
      const x = !!dx && scrolls(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
      if (!x && !y) continue;
      const page = w.deltaMode === 2;
      const left = el.scrollLeft, top = el.scrollTop;
      if (x) el.scrollLeft += page ? dx * el.clientWidth : dx;
      if (y) el.scrollTop += page ? dy * el.clientHeight : dy;
      if (el.scrollLeft !== left || el.scrollTop !== top) return true;
      // At its end: a panel with contained overscroll keeps the wheel, as it does natively.
      if ((y ? cs.overscrollBehaviorY : cs.overscrollBehaviorX) !== "auto") return true;
    }
    return false;
  }

  /** A press on a panel's vertical scrollbar: step at the arrows, page on the track, or drag the thumb. */
  private pressScrollbar(target: Element) {
    for (let el: Element | null = target; el; el = el.parentElement) {
      if (!(el instanceof HTMLElement)) continue;
      const cs = getComputedStyle(el);
      const bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
      const gutter = el.offsetWidth - el.clientWidth - bl - br;
      if (gutter <= 0 || !scrolls(cs.overflowY) || el.scrollHeight <= el.clientHeight + 1) continue;
      const r = el.getBoundingClientRect();
      const left = cs.direction === "rtl" ? r.left + bl : r.right - br - gutter;
      const top = r.top + (parseFloat(cs.borderTopWidth) || 0), h = el.clientHeight;
      if (this.x < left || this.x >= left + gutter || this.y < top || this.y >= top + h) continue;
      // Classic (Windows/Linux) scrollbars have square arrow buttons at both ends; the Mac's have none.
      const arrow = /Mac|iP(hone|ad)/.test(navigator.platform) ? 0 : Math.min(gutter, h / 4);
      const range = el.scrollHeight - h, track = h - 2 * arrow;
      const size = Math.max(gutter, track * h / el.scrollHeight);
      const at = top + arrow + (track - size) * el.scrollTop / range;
      if (this.y < top + arrow) el.scrollTop -= 40;
      else if (this.y >= top + h - arrow) el.scrollTop += 40;
      else if (this.y < at) el.scrollTop -= h * 0.875;
      else if (this.y >= at + size) el.scrollTop += h * 0.875;
      else this.thumb = { el, y0: this.y, top0: el.scrollTop, per: range / Math.max(1, track - size) };
      return true;
    }
    return false;
  }

  /** Sets a horizontal range input to the value under the drawn cursor and reports it as a drag would. */
  private slide(input: HTMLInputElement) {
    const r = input.getBoundingClientRect();
    if (!r.width) return;
    const min = input.min === "" ? 0 : Number(input.min), max = input.max === "" ? 100 : Number(input.max);
    const step = input.step === "any" ? 0 : Number(input.step || 1);
    let t = Math.min(1, Math.max(0, (this.x - r.left) / r.width));
    if (getComputedStyle(input).direction === "rtl") t = 1 - t;
    let v = min + t * (max - min);
    if (step > 0) v = min + Math.round((v - min) / step) * step;
    const value = String(Number(Math.min(max, Math.max(min, v)).toFixed(6)));
    if (value === input.value) return;
    // The prototype's setter, so React sees the change, then the input event a drag sends.
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private init(m: MouseEvent | null, buttons: number, related?: Element | null): MouseEventInit {
    return {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: this.x, clientY: this.y, screenX: this.x + window.screenX, screenY: this.y + window.screenY,
      movementX: m?.movementX ?? 0, movementY: m?.movementY ?? 0,
      button: m?.button ?? 0, buttons,
      ctrlKey: m?.ctrlKey ?? false, shiftKey: m?.shiftKey ?? false, altKey: m?.altKey ?? false, metaKey: m?.metaKey ?? false,
      relatedTarget: related ?? null,
    };
  }

  private dispatchMouse(type: string, target: Element, buttons: number, m: MouseEvent | null, related?: Element | null) {
    const init = this.init(m, buttons, related);
    if (type === "mouseenter" || type === "mouseleave") init.bubbles = false;
    // Pointer listeners (menus, the minimap) see the same boundary events.
    const pointer = { mouseover: "pointerover", mouseout: "pointerout", mouseenter: "pointerenter", mouseleave: "pointerleave" }[type];
    if (pointer) target.dispatchEvent(new PointerEvent(pointer, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    target.dispatchEvent(new MouseEvent(type, init));
  }

  private dispatchPointer(type: string, target: Element, m: MouseEvent) {
    target.dispatchEvent(new PointerEvent(type, { ...this.init(m, m.buttons), pointerId: 1, pointerType: "mouse", isPrimary: true }));
  }

  /** mouseenter / mouseleave for every element the drawn cursor entered or left (they do not bubble). */
  private enterLeave(from: Element | null, to: Element | null, m: MouseEvent) {
    const chain = (el: Element | null) => { const out: Element[] = []; for (let n = el; n; n = n.parentElement) out.push(n); return out; };
    const a = chain(from), b = chain(to);
    const inB = new Set(b), inA = new Set(a);
    for (const el of a) if (!inB.has(el)) this.dispatchMouse("mouseleave", el, m.buttons, m, to);
    for (const el of [...b].reverse()) if (!inA.has(el)) this.dispatchMouse("mouseenter", el, m.buttons, m, from);
  }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  /** Draws the cursor at its position: the current engine cursor and frame (animated cursors keep redrawing). */
  draw() {
    if (!this.locked) return;
    const c = modCursor(this.cursorName);
    const f = c ? cursorFrame(c, performance.now()) : 0;
    if (c !== this.shown.c || f !== this.shown.f) {
      this.el.replaceChildren();
      if (c) this.el.appendChild(c.frames[f]);
      else this.el.textContent = "";
      this.shown = { c, f };
    }
    const hx = c?.hx ?? 0, hy = c?.hy ?? 0;
    this.el.style.transform = `translate(${Math.round(this.x - hx)}px, ${Math.round(this.y - hy)}px)`;
    if (c && c.frames.length > 1) this.schedule();
  }
}
