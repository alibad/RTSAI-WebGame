// The AI co-commander on the page: talks to the local companion's HTTP API through the server's same-origin proxy
// (/companion/api/), records push-to-talk speech from the microphone, plays the companion's spoken replies, and keeps
// the feed the panel shows. The companion reaches the game through the engine relay (server/companion.mjs), so its
// confirmed orders are ordinary engine orders.

import type { CompanionEngineEvent } from "./sim/protocol";
import { store } from "./store";
import type { AudioEngine } from "./audio";

export type FeedKind = "you" | "ai" | "alert" | "proposal" | "done" | "rejected" | "system";

export interface FeedItem {
  id: number;
  kind: FeedKind;
  text: string;
  at: number;
  proposalId?: string;
  /** Proposals: pending until the player accepts or cancels them. */
  /** expired: the companion no longer holds it (a newer question or order replaced it); it can't be accepted. */
  state?: "pending" | "accepted" | "cancelled" | "expired";
  importance?: string;
}

export interface CoCommanderState {
  /** The player's choice (setup screen), kept between visits. */
  enabled: boolean;
  /** "local": the player's local AI stack; "mock": a scripted stand-in (no models needed). */
  mode: "mock" | "local";
  running: boolean;
  linked: boolean;
  listening: boolean;
  thinking: boolean;
  muted: boolean;
  open: boolean;
  feed: FeedItem[];
  error: string;
}

// Read while store.ts is still being evaluated (an import cycle): no module-level constants may be used here.
export function initialCoCommander(): CoCommanderState {
  let saved: Partial<CoCommanderState> = {};
  try { saved = JSON.parse(localStorage.getItem("rtsai.cocommander") ?? "{}"); } catch { /* private mode */ }
  return {
    enabled: saved.enabled ?? false, mode: saved.mode === "local" ? "local" : "mock", muted: saved.muted ?? false,
    running: false, linked: false, listening: false, thinking: false, open: false, feed: [], error: "",
  };
}

interface CompanionReply {
  text: string;
  source: string;
  interrupted?: boolean;
  metadata?: { action?: { state?: string; proposal_id?: string; summary?: string; detail?: string }; degraded?: boolean };
}

const API = "companion/api/";
let nextFeed = 1;

export class CoCommander {
  private recorder: { ctx: AudioContext; stream: MediaStream; node: ScriptProcessorNode; chunks: Float32Array[]; rate: number } | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  /**
   * Recording (tools/film-takes.mjs): when set, the co-commander's own alerts stay out of the feed and only the
   * offers matching this pattern appear as cards, so a take shows just the exchange being filmed.
   */
  focus: RegExp | null = null;
  private lastAlert = "";

  constructor(private audio: AudioEngine) {}

  private get s() { return store.get().cc; }

  private set(p: Partial<CoCommanderState>) {
    const cc = { ...this.s, ...p };
    store.set({ cc });
    try { localStorage.setItem("rtsai.cocommander", JSON.stringify({ enabled: cc.enabled, mode: cc.mode, muted: cc.muted })); } catch { /* private mode */ }
  }

  private push(kind: FeedKind, text: string, extra: Partial<FeedItem> = {}) {
    const item: FeedItem = { id: nextFeed++, kind, text, at: Date.now(), ...extra };
    this.set({ feed: [...this.s.feed, item].slice(-60) });
    return item;
  }

  private update(id: number, p: Partial<FeedItem>) {
    this.set({ feed: this.s.feed.map((f) => (f.id === id ? { ...f, ...p } : f)) });
  }

  setEnabled(enabled: boolean) { this.set({ enabled }); }
  setMode(mode: "mock" | "local") { this.set({ mode }); }
  setOpen(open: boolean) { this.set({ open }); }
  toggleMute() { this.set({ muted: !this.s.muted }); if (this.s.muted) this.audio.stopVoice(); }

  /** Starts the local companion (before a match with the co-commander). */
  async ensureRunning() {
    const res = await fetch(new URL("api/companion/start", base()), { method: "POST", body: JSON.stringify({ mode: this.s.mode }) });
    const status = await res.json();
    this.set({ running: !!status.running, error: status.error ?? "", feed: [] });
    if (!status.running) throw new Error(status.error || "The co-commander could not start.");
  }

  /** A new match: clear the feed, greet, and watch for orders the co-commander offers on its own. */
  matchStarted() {
    this.set({ feed: [], linked: false, thinking: false });
    this.push("system", this.s.mode === "mock" ? "Co-commander online (scripted brain)" : "Co-commander online");
    if (!this.poll) this.poll = setInterval(() => { void this.offers(); }, 1500);
  }

  /**
   * Orders the co-commander offers by itself (e.g. "the Power Plant is ready; I can place it"): the desktop game
   * accepts them with a hotkey; here they become cards like any proposal.
   */
  private async offers() {
    if (!this.s.enabled || !this.s.running || !this.s.linked) return;
    try {
      const asked = Date.now();
      const res = await fetch(new URL(`${API}v1/state`, base()));
      if (!res.ok) return;
      const state = await res.json() as { pending_action?: { proposal_id: string; summary: string } | null };
      const p = state.pending_action;
      // The companion holds one proposal at a time: older cards it no longer holds can't be accepted any more.
      for (const f of this.s.feed)
        if (f.kind === "proposal" && f.state === "pending" && f.at < asked && f.proposalId !== p?.proposal_id) this.update(f.id, { state: "expired" });
      if (p && !this.s.feed.some((f) => f.proposalId === p.proposal_id) && (!this.focus || this.focus.test(p.summary)))
        this.push("proposal", p.summary, { proposalId: p.proposal_id, state: "pending" });
    } catch { /* the companion is restarting */ }
  }

  /** Engine events (worker): status lines become feed entries; links and executed actions update the panel. */
  onEngine(e: CompanionEngineEvent) {
    if (e.kind === "link") { this.set({ linked: e.connected }); return; }
    if (e.kind === "executed") {
      this.push(e.accepted ? "done" : "rejected", e.detail || (e.accepted ? "Orders issued" : "Orders refused"));
      return;
    }
    if (e.kind !== "status") return;
    const text = e.message.replace(/^AI\s*•\s*/, "").trim();
    const state = e.state.split(":")[0];
    // Advice and alerts the companion volunteers; lifecycle lines (ready, thinking, capabilities) stay in the strip.
    if (!/^(speaking-)?(routine|important|critical|alert|advice)/.test(state) || !text || text === this.lastAlert || this.focus) return;
    this.lastAlert = text;
    const importance = state.replace("speaking-", "");
    this.push("alert", text, { importance });
    if (importance !== "routine") this.speak(text);
  }

  /** A typed or spoken question or order. */
  async ask(text: string) {
    text = text.trim();
    if (!text) return;
    this.push("you", text);
    this.set({ thinking: true });
    try {
      const r = await this.post<CompanionReply>("v1/ask", { question: text });
      this.reply(r);
    } catch (e) {
      this.push("system", `No answer: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.set({ thinking: false });
    }
  }

  private reply(r: CompanionReply) {
    if (r.interrupted) return;
    const action = r.metadata?.action;
    if (action?.state === "pending" && action.proposal_id) {
      const summary = action.summary || r.text;
      this.push("proposal", summary, { proposalId: action.proposal_id, state: "pending" });
      // The card carries the order and its buttons; keep only what the reply adds (e.g. a note), not the boilerplate.
      const note = r.text.replace(action.summary ?? "", "").replace(/I prepared \d+ validated orders?\.?/i, "").replace(/Say confirm to execute, or cancel\.?/i, "")
        .replace(/^[\s.]*(Note:\s*)?/i, "").trim();
      if (note.length > 3) this.push("ai", note[0].toUpperCase() + note.slice(1));
      // Spoken: the order and the note, as on screen (the card is accepted with a click or Enter, not by saying
      // "confirm", so the desktop game's voice prompt is left out).
      this.speak([summary.replace(/[.\s]+$/, ""), note.length > 3 ? note : ""].filter(Boolean).join(". "));
      return;
    }
    if (r.text) this.push(action?.state === "rejected" ? "rejected" : "ai", r.text);
    if (r.text) this.speak(r.text);
  }

  async decide(item: FeedItem, accept: boolean) {
    if (!item.proposalId || item.state !== "pending") return;
    this.update(item.id, { state: accept ? "accepted" : "cancelled" });
    try {
      const r = await this.post<CompanionReply>(accept ? "v1/actions/confirm" : "v1/actions/cancel", { proposal_id: item.proposalId });
      if (!accept) return;
      // A queued order shows as the engine's receipt (✓); only a refusal needs the companion's words.
      const state = r.metadata?.action?.state;
      if (r.text && (state === "rejected" || state === "failed" || state === "unavailable")) this.push("rejected", r.text);
    } catch (e) {
      this.push("system", `Not sent: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** The newest proposal still waiting for the player (Enter accepts, Backspace cancels while the panel has focus). */
  pending() { return [...this.s.feed].reverse().find((f) => f.kind === "proposal" && f.state === "pending"); }

  // ---------------------------------------------------------------- voice

  async startListening() {
    if (this.recorder || this.s.listening) return;
    this.audio.stopVoice();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(ctx.destination);
      this.recorder = { ctx, stream, node, chunks, rate: ctx.sampleRate };
      this.set({ listening: true });
    } catch (e) {
      this.push("system", `Microphone unavailable: ${e instanceof Error ? e.message : e}`);
    }
  }

  async stopListening() {
    const r = this.recorder;
    this.recorder = null;
    this.set({ listening: false });
    if (!r) return;
    r.node.disconnect();
    r.stream.getTracks().forEach((t) => t.stop());
    await r.ctx.close();
    const seconds = r.chunks.reduce((n, c) => n + c.length, 0) / r.rate;
    if (seconds < 0.3) return;
    this.set({ thinking: true });
    try {
      const wav = encodeWav(r.chunks, r.rate, 16000);
      const res = await fetch(new URL(`${API}v1/transcribe?filename=question.wav`, base()), { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
      const t = await res.json() as { text?: string; error?: string };
      if (!res.ok || !t.text) throw new Error(t.error ?? `HTTP ${res.status}`);
      this.set({ thinking: false });
      await this.ask(t.text);
    } catch (e) {
      this.push("system", `Not heard: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.set({ thinking: false });
    }
  }

  async speak(text: string) {
    if (this.s.muted) return;
    try {
      const res = await fetch(new URL(`${API}v1/speak`, base()), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("audio/")) return;
      await this.audio.voice(await res.arrayBuffer());
    } catch { /* speech is optional */ }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(new URL(API + path, base()), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail ?? json.error ?? `HTTP ${res.status}`);
    return json as T;
  }
}

function base() { return new URL("./", location.href); }

/** Mono 16-bit PCM WAV at `rate` (linear resampling from the capture rate). */
function encodeWav(chunks: Float32Array[], from: number, rate: number) {
  const input = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { input.set(c, o); o += c.length; }
  const n = Math.floor(input.length * rate / from);
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const str = (p: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
  str(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = i * from / rate, j = Math.floor(x), f = x - j;
    const v = (input[j] ?? 0) * (1 - f) + (input[j + 1] ?? input[j] ?? 0) * f;
    dv.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, Math.round(v * 32767))), true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
