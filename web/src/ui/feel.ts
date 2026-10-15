// The menus feel like the game. The mod's own cursors replace the browser's everywhere: its arrow, and its animated
// "select" bracket over anything that can be clicked. Menu controls answer with a soft procedural tick on hover and
// a click on press, at the effects volume. The battlefield keeps its own cursors (game.ts sets the stage's cursor
// every frame from the engine's choice); this only sets the CSS variables menus and the HUD read (styles.css).
import { CURSOR_FRAME_MS, cursorFor, modCursor, modCursorsVersion } from "./cursors";
import { preferences } from "../preferences";
import { createAudioContext } from "../audio-context";

const CLICKABLE = 'button:not(:disabled), a[href], [role="button"], [role="tab"], [role="option"], [role="menuitem"], [role="switch"], select, summary, input[type="range"], input[type="checkbox"], input[type="radio"], .cameo:not([data-disabled="true"])';
/** Controls that tick when hovered: the menu's big choices. Every control inside [data-ui-sfx] clicks on press. */
const HOVER_SFX = ".menu-card, .view-tile, [data-sfx-hover]";

let audio: AudioContext | null = null;

function tone(kind: "hover" | "press") {
  const volume = preferences.master * preferences.effects;
  if (volume <= 0 || !audio || audio.state !== "running") return;
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  const [from, to, peak, length] = kind === "hover" ? [1650, 1250, 0.018, 0.045] : [520, 170, 0.07, 0.11];
  osc.type = kind === "hover" ? "sine" : "triangle";
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + length);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak * volume, t + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + length + 0.02);
}

/** Installs the cursors and sounds once for the page; returns the uninstaller. */
export function installUiFeel(): () => void {
  const root = document.documentElement;
  let applied = -1;
  const applyCursors = () => {
    const version = modCursorsVersion();
    if (version === applied || !modCursor("default")) return;
    applied = version;
    root.style.setProperty("--cursor-default", cursorFor("default"));
    root.style.setProperty("--cursor-pointer", cursorFor("select", 0));
    root.style.setProperty("--cursor-blocked", cursorFor("generic-blocked"));
    root.dataset.gameCursors = "1";
  };
  applyCursors();
  const poll = window.setInterval(applyCursors, 400);

  // The select bracket pulses over the hovered control, frame by frame as the engine animates it.
  let hovered: HTMLElement | null = null;
  let animation = 0;
  const stop = () => {
    window.clearInterval(animation);
    if (hovered) hovered.style.removeProperty("cursor");
    hovered = null;
  };
  const over = (e: PointerEvent) => {
    const target = (e.target as Element | null)?.closest<HTMLElement>(CLICKABLE) ?? null;
    if (target === hovered) return;
    stop();
    if (!target || target.closest('canvas, [draggable="true"]')) return;
    if (target.matches(HOVER_SFX)) tone("hover");
    if (!modCursor("select")) return;
    hovered = target;
    const t0 = performance.now();
    const step = () => { if (hovered) hovered.style.cursor = cursorFor("select", performance.now() - t0); };
    step();
    animation = window.setInterval(step, CURSOR_FRAME_MS);
  };
  const press = (e: PointerEvent) => {
    audio ??= createAudioContext({ latencyHint: "interactive" });
    if (!audio) return;
    if (audio.state === "suspended") void audio.resume().catch(() => {});
    const target = (e.target as Element | null)?.closest<HTMLElement>(CLICKABLE);
    if (target && target.closest("[data-ui-sfx]")) tone("press");
  };
  // iOS Safari starts audio only from the end of a touch: unlock the UI sounds there too.
  const unlock = () => { if (audio?.state === "suspended") void audio.resume().catch(() => {}); };
  document.addEventListener("pointerover", over, { passive: true });
  document.addEventListener("pointerdown", press, { passive: true, capture: true });
  document.addEventListener("touchend", unlock, { passive: true, capture: true });
  document.addEventListener("click", unlock, { passive: true, capture: true });
  return () => {
    window.clearInterval(poll);
    stop();
    document.removeEventListener("pointerover", over);
    document.removeEventListener("pointerdown", press, { capture: true });
    document.removeEventListener("touchend", unlock, { capture: true });
    document.removeEventListener("click", unlock, { capture: true });
  };
}
