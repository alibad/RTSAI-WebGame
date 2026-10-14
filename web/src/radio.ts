import { create } from "zustand";
import type { AudioEngine } from "./audio";
import { campaign, campaignAsset, radioCalls, type RadioCall } from "./campaign";
import { useStore, type Store } from "./store";

// Radio calls in campaign missions (the story's "radio" sets): a portrait, a caption and an optional voice, played one at
// a time from a queue. Triggers read the page's copy of the match state (store.ui, sent every tick by Ui.cs), so the sim
// needs nothing new: game time is the world tick (it stops while paused and follows the game speed), objectives are
// ui.mission.objectives[n].status, mission events are the ids in ui.mission.events, the outcome is ui.win.

/** World ticks per second of game time at the default speed (OpenRA's 40 ms timestep; Lua's DateTime.Seconds). */
export const TICKS_PER_SECOND = 25;

export interface OnAir extends RadioCall { key: number }

/** What the HUD shows: the call on air and how many wait behind it. */
export const useRadio = create<{ call: OnAir | null; waiting: number; voice: "none" | "loading" | "playing" | "missing" }>(() => ({ call: null, waiting: 0, voice: "none" }));

/** Long enough to read: about three words a second, never under four seconds or over fourteen. */
export const readingMs = (line: string) => Math.min(14000, Math.max(4000, 1800 + line.split(/\s+/).length * 330));

export class Radio {
  private mission = "";
  private calls: RadioCall[] = [];
  private fired = new Set<number>();
  private over = false;
  private queue: RadioCall[] = [];
  private keys = 0;
  private left = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetching: AbortController | null = null;

  constructor(private audio: AudioEngine) {
    useStore.subscribe((s) => this.watch(s));
  }

  /** Puts a call on the radio (the triggers below; also scripts and tests). */
  say(call: RadioCall) {
    this.queue.push(call);
    if (!useRadio.getState().call) this.next();
    else useRadio.setState({ waiting: this.queue.length });
  }

  /** The player dismissed the call on air: the next one, if any. */
  skip() { this.next(); }

  private watch(s: Store) {
    const mission = s.phase === "playing" ? s.ui?.mission : null;
    if (!mission || !campaign.chapters[mission.id]) {
      if (this.mission) this.reset("");
      return;
    }
    const ui = s.ui!;
    if (mission.id !== this.mission) {
      this.reset(mission.id);
      this.calls = radioCalls(mission.id);
    }
    if (this.over) return;
    const seconds = ui.tick / TICKS_PER_SECOND;
    const outcome = ui.win === "Won" ? "victory" : ui.win === "Lost" ? "defeat" : null;
    const due = this.calls.map((call, i) => ({ call, i })).filter(({ call, i }) => {
      if (this.fired.has(i)) return false;
      const when = call.when;
      if (when === "start") return true;
      if (when === "victory" || when === "defeat") return when === outcome;
      if ("time" in when) return !outcome && seconds >= when.time;
      if ("event" in when) return !outcome && !!mission.events?.includes(when.event);
      return !outcome && mission.objectives[when.objective]?.status === "complete";
    });
    if (!due.length) return;
    // Several at once (a jump in time, two objectives in one tick): earliest time first, else as written.
    due.sort((a, b) => timeOf(a.call) - timeOf(b.call) || a.i - b.i);
    for (const { i } of due) this.fired.add(i);
    if (outcome) {
      // The match is over: what was on air or waiting no longer applies; the outcome call goes out at once.
      this.over = true;
      this.queue = due.map(({ call }) => call);
      this.next();
      return;
    }
    for (const { call } of due) this.say(call);
  }

  private reset(mission: string) {
    this.mission = mission;
    this.calls = [];
    this.fired.clear();
    this.over = false;
    this.queue = [];
    this.stop();
    useRadio.setState({ call: null, waiting: 0, voice: "none" });
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.fetching?.abort();
    this.fetching = null;
    this.audio.stopRadio();
  }

  private next() {
    this.stop();
    const call = this.queue.shift();
    if (!call) { useRadio.setState({ call: null, waiting: 0, voice: "none" }); return; }
    this.left = readingMs(call.line);
    const key = ++this.keys;
    const url = call.audio ? campaignAsset(call.audio) : null;
    useRadio.setState({ call: { ...call, key }, waiting: this.queue.length, voice: url ? "loading" : "none" });
    // The caption's clock runs only while the game does (the pause also suspends the voice).
    let last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      if (!useStore.getState().paused) this.left -= now - last;
      last = now;
      if (this.left <= 0) this.next();
    }, 100);
    if (url) void this.playVoice(url, key);
  }

  /** The call's voice, when it has one; a missing or broken file leaves the caption on its own. */
  private async playVoice(url: string, key: number) {
    const fetching = (this.fetching = new AbortController());
    try {
      const res = await fetch(url, { mode: "cors", signal: fetching.signal });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.arrayBuffer();
      if (fetching.signal.aborted || useRadio.getState().call?.key !== key) return;
      const wanted = () => !fetching.signal.aborted && useRadio.getState().call?.key === key;
      const seconds = await this.audio.radio(data, wanted);
      if (!wanted()) return;
      // The caption stays up until the voice has finished.
      this.left = Math.max(this.left, seconds * 1000 + 700);
      useRadio.setState({ voice: "playing" });
    } catch {
      if (useRadio.getState().call?.key === key) useRadio.setState({ voice: "missing" });
    }
  }
}

const timeOf = (call: RadioCall) => (typeof call.when === "object" && "time" in call.when ? call.when.time : 0);
