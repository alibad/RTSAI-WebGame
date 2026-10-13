// Watching a saved match, like a video: a Replay badge with the match's name, a transport bar (play, back to the
// start, a timeline with elapsed and total time, speeds, exit), Space to play or pause and the arrow keys to jump.
// The engine replays the recorded orders (MatchRestore.cs); seeking restarts the world at the chosen tick, so while it
// rebuilds the last frame stays on screen, frozen, behind a progress bar. A short jump forward fast-forwards (8×)
// instead when that is quicker than rebuilding. Nothing here can give orders: the sidebar shows who is fighting.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChevronsRight, Eye, FastForward, Film, LogOut, Pause, Play, RotateCcw, Undo2 } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { Flag } from "./Flag";
import { GameButton, Kbd } from "./kit/game";
import { clock, matchSides, matchTitle, parseScenario, TICKS_PER_SECOND } from "./match-info";

const SPEEDS = [0.5, 1, 2, 4, 8];
const JUMP = 10 * TICKS_PER_SECOND;
const store = useStore;

export interface ReplayInfo { tick: number; end: number; readonly: true }
/** The replay being watched, or null in a live match. */
export function replayOf(game: Game): ReplayInfo | null {
  const r = parseScenario(game.scenarioJson).webReplay;
  return r?.readonly === true && typeof r.end === "number" ? { tick: r.tick ?? 0, end: r.end, readonly: true } : null;
}

// ---------------------------------------------------------------- playback speed (kept across seeks)

let speed = 1;
const speedSubs = new Set<() => void>();
const notifySpeed = () => speedSubs.forEach((f) => f());
function useSpeed() { return useSyncExternalStore((f) => { speedSubs.add(f); return () => { speedSubs.delete(f); }; }, () => speed); }

/** The replay's speed (the worker keeps it across seeks; a match always starts again at 1×, Game.quit). */
export function setReplaySpeed(game: Game, value: number) {
  speed = value;
  if (ff) ff.restore = value;
  else game.client.send({ type: "speed", speed: value });
  notifySpeed();
}

// ---------------------------------------------------------------- seeking

/** What seeks have cost on this device: world build (ms), ms per replayed tick, fast-forward ticks per second. */
const cost = { base: 0, perTick: 0.8, tps: 110 };
const rebuildMs = (target: number) => Math.max(600, cost.base || store.getState().startMs || 2000) + target * cost.perTick;

let ff: { target: number; restore: number; pauseAtTarget: boolean; from: number; t0: number; stop: () => void } | null = null;
const ffSubs = new Set<() => void>();
const notifyFf = () => ffSubs.forEach((f) => f());
function useFastForward() { return useSyncExternalStore((f) => { ffSubs.add(f); return () => { ffSubs.delete(f); }; }, () => ff?.target ?? null); }

function stopFastForward(game: Game, reached: boolean) {
  const run = ff;
  if (!run) return;
  ff = null;
  run.stop();
  game.client.send({ type: "speed", speed: run.restore });
  if (reached && run.pauseAtTarget) game.setPaused(true);
  notifyFf();
}

function fastForward(game: Game, target: number, end: number, pauseAtTarget: boolean) {
  stopFastForward(game, false);
  const from = store.getState().ui?.tick ?? 0;
  const stop = store.subscribe((s) => {
    if (!ff) return;
    if (s.phase !== "playing") { stopFastForward(game, false); return; }
    const tick = s.ui?.tick ?? 0;
    if (tick >= ff.target || tick >= end) {
      const seconds = (performance.now() - ff.t0) / 1000;
      if (seconds > 0.3 && tick > ff.from) cost.tps = cost.tps * 0.4 + ((tick - ff.from) / seconds) * 0.6;
      stopFastForward(game, true);
    }
  });
  ff = { target, restore: speed, pauseAtTarget, from, t0: performance.now(), stop };
  game.client.send({ type: "speed", speed: 8 });
  if (store.getState().paused) game.setPaused(false);
  notifyFf();
}

let watching = false;
/** Leaving the match (Game.quit, an error): the next replay starts at 1× without a fast-forward running. */
function watchPhase() {
  if (watching) return;
  watching = true;
  store.subscribe((s, prev) => {
    if (s.phase === prev.phase || s.phase === "playing" || s.phase === "loading") return;
    if (ff) { ff.stop(); ff = null; notifyFf(); }
    if (speed !== 1) { speed = 1; notifySpeed(); }
  });
}

/**
 * Moves the replay to `tick`. Forward and close by: fast-forward. Otherwise the world restarts there (the camera is
 * kept), playing again if it was playing (or as `play` says).
 */
export async function seekReplay(game: Game, tick: number, play?: boolean) {
  const replay = replayOf(game);
  if (!replay) return;
  watchPhase();
  const s = store.getState();
  const current = s.ui?.tick ?? 0;
  const target = Math.max(0, Math.min(replay.end, Math.round(tick)));
  const finished = current >= replay.end;
  const playing = play ?? ((!s.paused || !!ff) && !finished);
  if (Math.abs(target - current) < 2 && !finished) {
    stopFastForward(game, false);
    if (s.paused === playing) game.setPaused(!playing);
    return;
  }
  if (target > current && !finished && ((target - current) / cost.tps) * 1000 < rebuildMs(target) * 0.7) {
    fastForward(game, target, replay.end, !playing);
    return;
  }
  stopFastForward(game, false);
  const cam = { ...game.cam };
  const frame = await game.captureFrame(400).then((c) => c.toDataURL("image/jpeg", 0.82)).catch(() => "");
  const now = replayOf(game);
  if (!now || store.getState().phase !== "playing") return;
  const scenario = parseScenario(game.scenarioJson);
  showCover(game, { frame, target, end: now.end, title: matchTitle(scenario, store.getState().setup), estimate: rebuildMs(target), startedAt: performance.now() }, cam);
  game.start(JSON.stringify({ ...scenario, webReplay: { ...scenario.webReplay, tick: target } }), !playing);
}

/** Leaves the replay for the menu. */
export function exitReplay(game: Game) {
  stopFastForward(game, false);
  game.quit();
}

// ---------------------------------------------------------------- the frozen frame while the world rebuilds

interface CoverProps { frame: string; target: number; end: number; title: string; estimate: number; startedAt: number }
let cover: { root: Root; el: HTMLElement; stop: () => void } | null = null;

function closeCover(fade: boolean) {
  const c = cover;
  if (!c) return;
  cover = null;
  c.stop();
  const remove = () => { c.root.unmount(); c.el.remove(); };
  if (!fade) { remove(); return; }
  c.el.firstElementChild?.classList.add("is-leaving");
  setTimeout(remove, 240);
}

function showCover(game: Game, props: CoverProps, cam: { x: number; y: number; zoom: number }) {
  closeCover(false);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  root.render(<SeekCover {...props} />);
  // Only the rebuilt world ends it: the old one still reports changes (the adviser closing, say) before it goes.
  let rebuilding = false;
  const stop = store.subscribe((s) => {
    if (s.phase === "loading") { rebuilding = true; return; }
    if (!rebuilding) return;
    if (s.phase === "playing") {
      // The rebuilt world starts at the player's base: look where the viewer was looking.
      game.cam.zoom = cam.zoom;
      game.lookAt(cam.x, cam.y);
      const ms = performance.now() - props.startedAt;
      if (props.target > 750) cost.perTick = Math.min(20, Math.max(0.05, cost.perTick * 0.4 + (Math.max(0, ms - (cost.base || ms * 0.3)) / props.target) * 0.6));
      else cost.base = cost.base ? cost.base * 0.4 + ms * 0.6 : ms;
      rebuilding = false;
      requestAnimationFrame(() => requestAnimationFrame(() => closeCover(true)));
    } else closeCover(false);
  });
  cover = { root, el, stop };
}

function SeekCover({ frame, target, end, title, estimate, startedAt }: CoverProps) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    let raf = requestAnimationFrame(function step() { setNow(performance.now()); raf = requestAnimationFrame(step); });
    return () => cancelAnimationFrame(raf);
  }, []);
  const progress = Math.min(0.97, 1 - Math.exp((-2.3 * (now - startedAt)) / Math.max(400, estimate)));
  const at = end > 0 ? (target / end) * 100 : 0;
  return (
    <div className="rp-cover" role="status" aria-live="polite" aria-label={`Jumping to ${clock(target)}`}>
      {frame && <div className="rp-cover-frame" style={{ backgroundImage: `url("${frame}")` }} />}
      <div className="rp-cover-side hud-panel" />
      <div className="rp-cover-card">
        <div className="rp-cover-ring" />
        <b>{target === 0 ? "Back to the start" : `Jumping to ${clock(target)}`}</b>
        <div className="rp-cover-progress"><div style={{ width: `${progress * 100}%` }} /></div>
        <small>Replay · {title}</small>
      </div>
      <div className="rp-dock">
        <div className="rp-bar is-frozen" aria-hidden="true">
          <span className="rp-play is-play"><Play /></span>
          <span className="rp-time">{clock(target)}</span>
          <div className="rp-track"><div className="rp-rail"><div className="rp-fill is-pending" style={{ width: `${at}%` }} /></div><div className="rp-knob" style={{ left: `${at}%` }} /></div>
          <span className="rp-time is-total">{clock(end)}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the replay HUD

/** Badge, transport bar, poster and end card, and the keyboard, while a replay is watched. */
export function ReplayHud({ game }: { game: Game }) {
  const replay = replayOf(game);
  const tick = useStore((s) => s.ui?.tick ?? 0);
  const paused = useStore((s) => s.paused);
  const win = useStore((s) => s.ui?.win ?? "");
  const setup = useStore((s) => s.setup);
  const current = useSpeed();
  const ffTarget = useFastForward();
  const [pending, setPending] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const pendingRef = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragging = useRef(false);
  const live = useRef({ tick, paused, end: replay?.end ?? 0, ffTarget });
  live.current = { tick, paused, end: replay?.end ?? 0, ffTarget };

  useEffect(() => { watchPhase(); if (!cost.base && store.getState().startMs) cost.base = store.getState().startMs; }, [game]);

  const end = replay?.end ?? 0;
  const finished = tick >= end;
  const commit = () => {
    clearTimeout(timer.current);
    const t = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    if (t !== null) void seekReplay(game, t);
  };
  const aim = (t: number, later: boolean) => {
    const next = Math.max(0, Math.min(live.current.end, Math.round(t)));
    pendingRef.current = next;
    setPending(next);
    clearTimeout(timer.current);
    if (later) timer.current = setTimeout(commit, 450);
  };
  const nudge = (delta: number) => aim((pendingRef.current ?? live.current.ffTarget ?? live.current.tick) + delta, true);
  const toggle = () => {
    const { tick: t, end: e, paused: p } = live.current;
    if (t >= e) { void seekReplay(game, 0, true); return; }
    stopFastForward(game, false);
    game.setPaused(!p);
  };

  // Space plays and pauses, the arrows jump 10 s (Shift: 30 s), as a video player does.
  useEffect(() => {
    let spaceHandled = false;
    const typing = (el: HTMLElement | null) => !!el && ((el.tagName === "INPUT" && !el.classList.contains("rp-range")) || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target as HTMLElement | null)) return;
      const s = store.getState();
      if (s.menuOpen || s.keysOpen || document.querySelector(".gd-overlay, .pm-overlay")) return;
      if (e.code === "Space") {
        e.preventDefault(); e.stopPropagation();
        spaceHandled = true;
        if (!e.repeat) toggle();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault(); e.stopPropagation();
        nudge((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 3 : 1) * JUMP);
      }
    };
    // A focused button must not also "click" on the Space that toggled playback.
    const up = (e: KeyboardEvent) => { if (e.code === "Space" && spaceHandled) { e.preventDefault(); e.stopPropagation(); spaceHandled = false; } };
    addEventListener("keydown", down, true);
    addEventListener("keyup", up, true);
    return () => { removeEventListener("keydown", down, true); removeEventListener("keyup", up, true); clearTimeout(timer.current); };
  }, [game]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!replay) return null;
  const scenario = parseScenario(game.scenarioJson);
  const title = matchTitle(scenario, setup);
  const sides = matchSides(scenario, setup);
  const shown = pending ?? tick;
  const pct = (t: number) => (end > 0 ? Math.min(100, (t / end) * 100) : 0);
  const playing = !paused && !finished;
  const state = win === "Won" || win === "Lost" ? win === "Won" ? "Victory" : "Defeat" : finished ? "Finished" : ffTarget !== null ? "Fast-forward" : paused ? "Paused" : "";
  const poster = paused && tick < 3 && pending === null && ffTarget === null;

  return (
    <>
      <div className="rp-top">
        <div className="rp-badge" aria-label={`Replay · ${title}`}>
          <span className="rp-badge-tag"><Film />REPLAY</span>
          <span className="rp-badge-name">{title}</span>
          {sides.length > 0 && <span className="rp-badge-sides" aria-label={sides.map((s) => s.nation).join(" vs ")}>
            {sides.map((s, i) => <span key={i} style={{ display: "contents" }}>{i > 0 && <i>VS</i>}<Flag id={s.faction} /></span>)}
          </span>}
          {state && <span className={`rp-badge-state${win === "Won" ? " is-won" : win === "Lost" ? " is-lost" : ""}`}>{state}</span>}
        </div>
      </div>

      {(poster || (finished && ffTarget === null)) && (
        <div className="rp-center">
          {poster ? (
            <div className="rp-poster" aria-hidden="true" onClick={() => game.setPaused(false)}>
              <span className="rp-poster-btn"><Play /></span>
              <span>Press <Kbd>Space</Kbd> to watch</span>
            </div>
          ) : (
            <div className="rp-end hud-card" data-ui-sfx>
              <h2>Replay finished</h2>
              <p>{title} · {clock(end)}</p>
              <div>
                <GameButton variant="primary" icon={<RotateCcw size={16} />} onClick={() => void seekReplay(game, 0, true)}>Watch again</GameButton>
                <GameButton icon={<LogOut size={16} />} onClick={() => exitReplay(game)}>Back to menu</GameButton>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="rp-dock">
        <div className="rp-bar" role="group" aria-label="Replay controls" data-ui-sfx>
          {ffTarget !== null && <span className="rp-ff"><FastForward />Fast-forward to {clock(ffTarget)}</span>}
          <button type="button" className="rp-btn" aria-label="Back to start" data-tip="Back to start" data-tip-pos="top" onClick={() => void seekReplay(game, 0)} disabled={tick < 3 && pending === null}><Undo2 /></button>
          <button type="button" className={`rp-play${finished ? " is-again" : playing ? " is-pause" : " is-play"}${poster ? " is-invite" : ""}`} aria-label={finished ? "Restart replay" : playing ? "Pause" : "Play"}
            data-tip={finished ? "Watch again" : playing ? "Pause · Space" : "Play · Space"} data-tip-pos="top" onClick={toggle}>
            {finished ? <RotateCcw /> : playing ? <Pause /> : <Play />}
          </button>
          <span className="rp-time" aria-label="Elapsed">{clock(shown)}</span>
          <div className="rp-track"
            onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))); }}
            onPointerLeave={() => setHover(null)}>
            <div className="rp-rail">
              <div className={`rp-fill${pending !== null ? " is-pending" : ""}`} style={{ width: `${pct(shown)}%` }} />
            </div>
            {ffTarget !== null && <div className="rp-target" style={{ left: `${pct(ffTarget)}%` }} />}
            <input className="rp-range" type="range" aria-label="Replay position" aria-valuetext={`${clock(shown)} of ${clock(end)}`}
              min={0} max={end} step={1} value={shown}
              onPointerDown={() => {
                dragging.current = true;
                addEventListener("pointerup", () => { if (dragging.current) { dragging.current = false; commit(); } }, { once: true });
              }}
              onChange={(e) => aim(Number(e.currentTarget.value), !dragging.current)}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault(); e.stopPropagation();
                  nudge((e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 1) * (e.shiftKey ? 3 : 1) * JUMP);
                }
              }} />
            <div className="rp-knob" style={{ left: `${pct(shown)}%` }} />
            {hover !== null && <span className="rp-hover" style={{ left: `${hover * 100}%` }}>{clock(hover * end)}</span>}
          </div>
          <span className="rp-time is-total" aria-label="Length">{clock(end)}</span>
          <span className="rp-sep" />
          <div className="rp-speeds" role="radiogroup" aria-label="Playback speed">
            {SPEEDS.map((v) => <button key={v} type="button" role="radio" aria-checked={current === v} className="rp-speed" onClick={() => setReplaySpeed(game, v)}>{v}×</button>)}
          </div>
          <button type="button" className="rp-speed-cycle rp-speed" aria-label={`Playback speed ${current}×`} onClick={() => setReplaySpeed(game, SPEEDS[(SPEEDS.indexOf(current) + 1) % SPEEDS.length])}>
            <span className="inline-flex items-center gap-1">{current}×<ChevronsRight size={13} /></span>
          </button>
          <button type="button" className="rp-exit" aria-label="Exit replay" data-tip="Exit replay" data-tip-pos="top" onClick={() => exitReplay(game)}><LogOut /><span>Exit replay</span></button>
        </div>
      </div>
    </>
  );
}

/** The sidebar while watching: the sides of the match instead of the build palette (nobody can give orders). */
export function ReplaySidePanel({ game }: { game: Game }) {
  const setup = useStore((s) => s.setup);
  const scenario = parseScenario(game.scenarioJson);
  const sides = matchSides(scenario, setup);
  return (
    <div className="rp-side">
      <div className="rp-side-head"><Eye />Watching</div>
      {sides.map((s, i) => (
        <div key={i} className="rp-side-player">
          <i style={{ background: s.color }} />
          <Flag id={s.faction} />
          <div><b>{s.nation}</b><small>{s.name}</small></div>
        </div>
      ))}
      <p className="rp-side-note"><Film />Orders are off while watching.</p>
    </div>
  );
}
