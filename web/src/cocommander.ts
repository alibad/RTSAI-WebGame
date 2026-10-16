// The AI co-commander on the page: talks to the local companion's HTTP API through the server's same-origin proxy
// (/companion/api/), records push-to-talk speech from the microphone, plays the companion's spoken replies, and keeps
// the feed the panel shows. The companion reaches the game through the engine relay (server/companion.mjs), so its
// confirmed orders are ordinary engine orders.

import type { CompanionEngineEvent } from "./sim/protocol";
import { store } from "./store";
import type { AudioEngine } from "./audio";
import { createAudioContext } from "./audio-context";
import { nextAdvice, assessThreat, type AdviserAdvice, type AdviserThreat, type AdviserCommand, type AdviserObservation } from "./adviser";
import { MissionMemory, missionAdvice, parseMissionMap, type MissionAdvice, type MissionMap, type MissionSpec } from "./mission-adviser";
import type { AdviserActionReceipt } from "./sim/adviser-rpc";
import adviserTree from "./adviser-tree.json";
import { track } from "./net/track";
import { companionDeveloperTools } from "./companion-policy";

export interface BrowserAdviser {
  observe(): Promise<AdviserObservation>;
  execute(id: string, commands: AdviserCommand[], tick: number): Promise<AdviserActionReceipt>;
  status(enabled: boolean, message?: string): Promise<boolean>;
  /** A campaign mission's map.yaml, for its named places (mission-adviser.ts). */
  missionMap?(mission: string): Promise<string>;
}

export type FeedKind = "you" | "ai" | "alert" | "proposal" | "done" | "rejected" | "system";

export interface FeedItem {
  id: number;
  kind: FeedKind;
  text: string;
  at: number;
  proposalId?: string;
  /** Proposals: pending until the player accepts or cancels them. */
  /** expired: the companion no longer holds it (a newer question or order replaced it); it can't be accepted. */
  state?: "pending" | "applying" | "accepted" | "cancelled" | "expired" | "failed" | "unknown";
  importance?: string;
  commands?: PreviewCommand[];
}
export interface PreviewCommand { action: string; actor_id?: number; target_actor_id?: number; target_x?: number; target_y?: number; item_type?: string; queued?: boolean }

export interface CoCommanderState {
  /** The player's choice (setup screen, Game settings), kept between visits. */
  enabled: boolean;
  /** Auto (Game settings): each recommendation is applied as it is made, through the same checks as Apply. */
  auto: boolean;
  /** Browser: the existing state-based strategy adviser; local: models/voice; mock: local test stand-in. */
  mode: "mock" | "local" | "browser";
  running: boolean;
  linked: boolean;
  listening: boolean;
  thinking: boolean;
  muted: boolean;
  open: boolean;
  feed: FeedItem[];
  error: string;
  strategies: StrategyState | null;
  strategyOpen: boolean;
  strategyBusy: boolean;
  strategyError: string;
  offerSteps: boolean;
  uncertainProposalId: string;
  browserThreat: AdviserThreat | null;
}

export interface StrategyChoice { id: string; name: string; intent: string; tradeoff: string }
export interface StrategyState {
  active: (StrategyChoice & { selected_tick: number; next: string; status: string; progress: string }) | null;
  choices: StrategyChoice[];
  all?: StrategyChoice[];
  context: string;
  reason: string;
  reserve: number;
  available?: boolean;
  tick?: number;
  execution?: string;
}

// Read while store.ts is still being evaluated (an import cycle): no module-level constants may be used here.
export function initialCoCommander(): CoCommanderState {
  let saved: Partial<CoCommanderState> & { browserVersion?: number } = {};
  try { saved = JSON.parse(localStorage.getItem("rtsai.cocommander") ?? "{}"); } catch { /* private mode */ }
  return {
    enabled: saved.enabled ?? true, mode: companionDeveloperTools && (saved.mode === "mock" || saved.mode === "local") ? saved.mode : "browser", muted: saved.muted ?? false, auto: saved.auto === true,
    running: false, linked: false, listening: false, thinking: false, open: false, feed: [], error: "",
    strategies: null, strategyOpen: false, strategyBusy: false, strategyError: "", offerSteps: true, uncertainProposalId: "", browserThreat: null,
  };
}

interface CompanionReply {
  text: string;
  source: string;
  interrupted?: boolean;
  metadata?: { action?: { state?: string; proposal_id?: string; summary?: string; detail?: string }; degraded?: boolean; contextual_strategy?: StrategyState };
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
  private polling = false;
  private strategyRevision = 0;
  private matchRevision = 0;
  private requests = new Set<AbortController>();
  private requestRevision = 0;
  private timeoutMs = 25000;
  private interruption: Promise<void> = Promise.resolve();
  private receipts = new Map<string, { accepted: boolean; detail: string }>();
  private browserProposals = new Map<string, string>();
  private browserSuppressed = "";
  private browserLastLine = "";
  private browserDeciding = false;
  private browserReady = false;
  /** Campaign missions: the mission map's named places and the planner's memory (mission-adviser.ts), per match. */
  private mission: { id: string; map: MissionMap | null; memory: MissionMemory } | null = null;

  private interrupt() {
    if (!this.s.running || this.s.mode === "browser") return;
    this.interruption = this.interruption.then(async () => { try { await fetch(new URL(`${API}v1/interrupt`, base()), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contract_version: 1 }), signal: AbortSignal.timeout(4000) }); } catch {} });
  }

  acknowledgeOutcome() {
    const id = this.s.uncertainProposalId;
    if (!id) return;
    this.set({ uncertainProposalId: "", feed: this.s.feed.map(f => f.proposalId === id && f.state === "unknown" ? { ...f, state: "expired" } : f) });
  }

  endMatch() {
    this.matchRevision++; this.strategyRevision++; this.requestRevision++;
    this.browserProposals.clear(); this.browserSuppressed = ""; this.browserLastLine = ""; this.browserDeciding = false; this.browserReady = false;
    this.mission = null;
    this.interrupt(); this.receipts.clear();
    for (const request of this.requests) request.abort();
    this.requests.clear();
    if (this.poll) clearInterval(this.poll);
    this.poll = null; this.polling = false; this.lastAlert = "";
    const recorder = this.recorder; this.recorder = null;
    if (recorder) { recorder.node.disconnect(); recorder.stream.getTracks().forEach(t => t.stop()); void recorder.ctx.close(); }
    this.audio.stopVoice();
    this.set({ listening: false, linked: false, running: this.s.mode === "browser" ? false : this.s.running, thinking: false, strategyBusy: false, uncertainProposalId: "", feed: this.s.feed.map(f => f.state === "pending" || f.state === "applying" ? { ...f, state: "expired" } : f) });
  }

  private async request(url: URL, init: RequestInit = {}) {
    const match = this.matchRevision;
    await this.interruption;
    if (match !== this.matchRevision) throw new Error("Cancelled companion request");
    const controller = new AbortController(); this.requests.add(controller);
    const timer = setTimeout(() => { controller.abort(); if (/\/v1\/(advice|proposals)$/.test(url.pathname)) this.interrupt(); }, this.timeoutMs);
    try { const response = await fetch(url, { ...init, signal: controller.signal }); const body = await response.arrayBuffer(); return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }); }
    finally { clearTimeout(timer); this.requests.delete(controller); }
  }

  /** The card the poll last applied for Auto (once each, so a card the adviser dropped cannot stall the poll). */
  private autoRetried = -1;

  constructor(private audio: AudioEngine, private canIssue: () => boolean = () => true, private browser?: BrowserAdviser) {}

  private get s() { return store.get().cc; }

  private set(p: Partial<CoCommanderState>) {
    const cc = { ...this.s, ...p };
    store.set({ cc });
    try { localStorage.setItem("rtsai.cocommander", JSON.stringify({ enabled: cc.enabled, mode: cc.mode, muted: cc.muted, auto: cc.auto, ...(cc.mode === "browser" ? { browserVersion: 1 } : {}) })); } catch { /* private mode */ }
  }

  private push(kind: FeedKind, text: string, extra: Partial<FeedItem> = {}) {
    const item: FeedItem = { id: nextFeed++, kind, text, at: Date.now(), ...extra };
    this.set({ feed: [...this.s.feed, item].slice(-60) });
    return item;
  }

  private update(id: number, p: Partial<FeedItem>) {
    this.set({ feed: this.s.feed.map((f) => (f.id === id ? { ...f, ...p } : f)) });
  }

  /** A recommendation card. In Auto it is applied at once, as if the player pressed Apply. */
  private offer(summary: string, extra: Partial<FeedItem>) {
    const item = this.push("proposal", summary, extra);
    if (this.s.auto) queueMicrotask(() => void this.decide(item, true));
    return item;
  }

  setEnabled(enabled: boolean) { if (!enabled) this.endMatch(); this.set({ enabled }); }
  setMode(mode: "mock" | "local" | "browser") { this.set({ mode: companionDeveloperTools ? mode : "browser" }); }
  /** Auto on: the recommendation waiting now is applied too. */
  setAuto(auto: boolean) { this.set({ auto }); const p = auto ? this.pending() : undefined; if (p) void this.decide(p, true); }
  setOpen(open: boolean) { this.set({ open, ...(open ? { strategyOpen: false } : {}) }); }
  toggleMute() { this.set({ muted: !this.s.muted }); if (this.s.muted) this.audio.stopVoice(); }

  /** Starts the local companion (before a match with the co-commander). */
  async ensureRunning() {
    const match = this.matchRevision;
    await this.interruption;
    if (match !== this.matchRevision) throw new Error("Cancelled companion launch");
    const res = await this.request(new URL("api/companion/start", base()), { method: "POST", body: JSON.stringify({ mode: this.s.mode }) });
    const status = await res.json();
    if (match !== this.matchRevision) throw new Error("Cancelled companion launch");
    this.set({ running: !!status.running, error: status.error ?? "", feed: [] });
    if (!status.running) throw new Error(status.error || "The co-commander could not start.");
    if (this.s.mode === "local" && status.localAI?.ready !== true) throw new Error(status.localAI?.message || "The local models have not passed their readiness checks.");
    const contractResponse = await this.request(new URL(`${API}v1/contract`, base()));
    const contract = await contractResponse.json();
    if (match !== this.matchRevision) throw new Error("Cancelled companion launch");
    if (!contractResponse.ok || contract.contract_version !== 1 || contract.application?.requires_explicit_proposal_id !== true) throw new Error("The local companion contract is incompatible. Manual controls remain available.");
    if (!Number.isFinite(contract.client_timeout_seconds) || contract.client_timeout_seconds < 1 || contract.client_timeout_seconds > 300) throw new Error("The local companion deadline is invalid.");
    this.timeoutMs = contract.client_timeout_seconds * 1000;
  }

  /** A new match: clear the feed, greet, and watch for orders the co-commander offers on its own. */
  matchStarted() {
    this.matchRevision++;
    this.strategyRevision++;
    this.mission = null;
    this.set({ feed: [], linked: false, ...(this.s.mode === "browser" ? { running: true, error: "" } : {}), thinking: false, strategies: null, strategyError: "", strategyBusy: false, strategyOpen: false, uncertainProposalId: "", browserThreat: null });
    this.push("system", this.s.mode === "browser" ? (this.s.auto ? "Built-in adviser ready. Recommended orders will be applied automatically." : "Built-in adviser ready. Review a recommended order, then choose Apply.") : this.s.mode === "mock" ? "Co-commander online (scripted test)" : "Co-commander online");
    this.lastPoll = 0; this.pace = { tick: 0, at: 0, speed: 1 };
    // A 250 ms clock: at the usual one look a second it fires every fourth tick, as the old one-second timer did.
    if (!this.poll) this.poll = setInterval(() => { if (Date.now() - this.lastPoll >= this.pollEvery() - 125) { this.lastPoll = Date.now(); void this.offers(); } }, 250);
  }

  private lastPoll = 0;
  /** The game's speed (game seconds a second), from the observations' ticks. */
  private pace = { tick: 0, at: 0, speed: 1 };

  /** A look every second; in a campaign mission, every game second, so it keeps up when the game runs faster. */
  private pollEvery() { return this.s.mode === "browser" && store.get().ui?.mission ? 1000 / Math.max(1, Math.min(4, this.pace.speed)) : 1000; }

  /**
   * Orders the co-commander offers by itself (e.g. "the Power Plant is ready; I can place it"): the desktop game
   * accepts them with a hotkey; here they become cards like any proposal.
   */
  private async offers() {
    // Auto: a recommendation that could not be applied when made (paused, reviewing) is applied once it can be.
    const waiting = this.s.auto && this.s.enabled && !store.get().paused && this.canIssue() ? this.pending() : undefined;
    if (waiting && !this.browserDeciding && waiting.id !== this.autoRetried) { this.autoRetried = waiting.id; await this.decide(waiting, true); return; }
    if (this.s.mode === "browser") { await this.browserOffers(); return; }
    if (!this.s.enabled || !this.s.running || !this.s.linked || store.get().phase !== "playing" || this.polling) return;
    this.polling = true;
    const revision = this.strategyRevision;
    const match = this.matchRevision;
    try {
      const asked = Date.now();
      const res = await this.request(new URL(`${API}v1/state`, base()));
      if (!res.ok) return;
      type Offer = { proposal_id: string; summary: string; commands?: PreviewCommand[] };
      const state = await res.json() as { pending_action?: Offer | null; pending_actions?: Offer[]; contextual_strategy?: StrategyState };
      if (match !== this.matchRevision || store.get().phase !== "playing") return;
      if (state.contextual_strategy && revision === this.strategyRevision && !this.s.strategyBusy)
        this.set({ strategies: state.contextual_strategy });
      // Every offer the companion still holds, newest first (pending_actions; older companions send only the newest).
      const held = state.pending_actions ?? (state.pending_action ? [state.pending_action] : []);
      const ids = new Set(held.map((p) => p.proposal_id));
      // Cards the companion no longer holds (cancelled, replaced by an offer about the same thing) can't be accepted.
      for (const f of this.s.feed)
        if (f.kind === "proposal" && f.state === "pending" && f.at < asked && !ids.has(f.proposalId ?? "")) this.update(f.id, { state: "expired" });
      // New offers as cards, oldest first so the feed keeps their order.
      for (const p of [...held].reverse())
        if (!this.s.feed.some((f) => f.proposalId === p.proposal_id) && (!this.focus || this.focus.test(p.summary)))
          this.offer(p.summary, { proposalId: p.proposal_id, state: "pending", commands: p.commands });
      for (const p of held) {
        const item = this.s.feed.find(f => f.proposalId === p.proposal_id);
        if (item && !item.commands && p.commands) this.update(item.id, { commands: p.commands });
      }
      if (revision === this.strategyRevision && this.s.strategies?.active && this.s.strategies.available && this.s.offerSteps
          && !this.s.strategyBusy && !this.s.thinking && !store.get().paused && !held.length)
        await this.strategyStep(true);
    } catch { /* the companion is restarting */ }
    finally { if (match === this.matchRevision) this.polling = false; }
  }

  /**
   * The recommendation for this observation: in a campaign mission the mission planner, which reads the objectives
   * (setup.missions, ui.mission) and the map's named places; the skirmish adviser otherwise.
   */
  private browserChoice(observation: AdviserObservation): AdviserAdvice | null {
    const s = store.get(), live = s.ui?.mission;
    const spec = live ? s.setup?.missions?.find((m) => m.id === live.id) as unknown as MissionSpec | undefined : undefined;
    if (!live || !spec) return nextAdvice({ ...observation, techTree: adviserTree });
    if (this.mission?.id !== live.id) this.loadMission(live.id);
    const map = this.mission?.map;
    // The map is read once, a moment after the start; without its places the skirmish adviser still runs the base.
    if (!map) return null;
    if (!map.actors.length) return nextAdvice({ ...observation, techTree: adviserTree });
    return missionAdvice(observation, { spec, live, map, memory: this.mission!.memory, techTree: adviserTree, catalog: s.catalog });
  }

  private loadMission(id: string) {
    const match = this.matchRevision;
    const mission = this.mission = { id, map: null as MissionMap | null, memory: new MissionMemory() };
    const read = this.browser?.missionMap?.(id) ?? Promise.resolve("");
    void read.catch(() => "").then((text) => {
      if (match !== this.matchRevision || this.mission !== mission) return;
      mission.map = parseMissionMap(text);
    });
  }

  private choiceKey(advice: ReturnType<CoCommander["browserChoice"]>) {
    return advice ? `${advice.key}:${JSON.stringify(advice.commands)}` : "";
  }

  private async browserOffers(requested = false) {
    if (!this.browser || !this.s.enabled || !this.s.running || this.s.uncertainProposalId
      || store.get().phase !== "playing" || store.get().paused || !this.canIssue() || this.polling || this.browserDeciding) return;
    this.polling = true;
    const match = this.matchRevision;
    try {
      const observation = await this.browser.observe();
      if (match !== this.matchRevision || !this.s.enabled || this.browserDeciding || this.s.uncertainProposalId || store.get().paused || !this.canIssue() || store.get().phase !== "playing") return;
      this.set({ linked: true, error: "", browserThreat: assessThreat(observation) });
      const now = Date.now();
      if (observation.tick > this.pace.tick && this.pace.at && now - this.pace.at > 200)
        this.pace.speed = this.pace.speed * 0.5 + (observation.tick - this.pace.tick) / (now - this.pace.at) / 0.025 * 0.5;
      if (observation.tick !== this.pace.tick) this.pace = { ...this.pace, tick: observation.tick, at: now };
      if (!this.browserReady) {
        this.browserReady = true;
        await this.browser.status(true, "Browser strategy adviser ready");
        if (match !== this.matchRevision || this.browserDeciding || this.s.uncertainProposalId || store.get().paused || !this.s.enabled || !this.canIssue()) return;
      }
      const advice = this.browserChoice(observation), key = this.choiceKey(advice);
      for (const item of this.s.feed) {
        if (item.state === "pending" && this.browserProposals.get(item.proposalId ?? "") !== key) this.update(item.id, { state: "expired" });
      }
      if (this.browserSuppressed && this.browserSuppressed !== key) this.browserSuppressed = "";
      if (!advice) return;
      if (advice.text !== this.browserLastLine || requested) {
        this.browserLastLine = advice.text;
        this.push("ai", advice.text);
      }
      if (observation.done || !advice.commands.length || !key || this.browserSuppressed === key || this.pending()) return;
      const id = `browser-${crypto.randomUUID()}`;
      this.browserProposals.set(id, key);
      // IDs are immutable for the displayed command set. Only current-state revalidation can dispatch it.
      this.offer(advice.summary, { proposalId: id, state: "pending", commands: advice.commands });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // The engine publishes its first observation a moment after the match starts, and none when the co-commander is
      // off for the match: the adviser waits quietly then, and only real failures show.
      const waiting = /No co-commander observation yet|co-commander disabled for this match|No active browser co-commander match|No controllable single-player co-commander/i.test(text);
      if (match === this.matchRevision) this.set({ linked: false, error: waiting ? "" : `Adviser unavailable: ${text}` });
    } finally { if (match === this.matchRevision) this.polling = false; }
  }

  private async browserDecide(item: FeedItem, accept: boolean) {
    if (!this.browser || !this.s.enabled || !this.s.running || this.s.uncertainProposalId || this.browserDeciding
      || !item.proposalId || item.state !== "pending" || !this.browserProposals.has(item.proposalId)
      || !this.s.feed.some(f => f.id === item.id && f.proposalId === item.proposalId && f.state === "pending")) return;
    const key = this.browserProposals.get(item.proposalId)!;
    if (!accept) { this.browserSuppressed = key; this.update(item.id, { state: "cancelled" }); return; }
    if (!this.canIssue() || store.get().phase !== "playing" || store.get().paused) return;
    const match = this.matchRevision, id = item.proposalId;
    this.browserDeciding = true;
    this.update(item.id, { state: "applying" });
    let dispatched = false;
    try {
      const observation = await this.browser.observe();
      if (match !== this.matchRevision || !this.canIssue() || !this.s.enabled || store.get().phase !== "playing" || store.get().paused) {
        if (match === this.matchRevision) this.update(item.id, { state: "expired" });
        return;
      }
      const advice = this.browserChoice(observation);
      if (!advice?.commands.length || this.choiceKey(advice) !== key || JSON.stringify(advice.commands) !== JSON.stringify(item.commands)) {
        this.update(item.id, { state: "expired" });
        this.push("system", "The battlefield changed. That recommendation has expired; checking the next step.");
        return;
      }
      dispatched = true;
      const receipt = await this.browser.execute(id, advice.commands, observation.tick);
      if (match !== this.matchRevision) return;
      if (receipt.requestId !== id) throw Error("Mismatched native order receipt");
      // The mission planner leaves units it has sent alone until they arrive.
      if (receipt.accepted && advice.key.startsWith("mission:")) this.mission?.memory.record(advice as MissionAdvice, observation.tick);
      if (!this.receipts.has(id)) this.onEngine({ kind: "executed", id, accepted: receipt.accepted, detail: receipt.detail });
      this.browserSuppressed = key;
    } catch (error) {
      if (match !== this.matchRevision) return;
      const receipt = this.receipts.get(id);
      if (receipt) { this.update(item.id, { state: receipt.accepted ? "accepted" : "failed" }); return; }
      this.update(item.id, { state: dispatched ? "unknown" : "failed" });
      if (dispatched) this.set({ uncertainProposalId: id });
      this.push("system", `${dispatched ? "Order outcome unknown; inspect the battlefield before continuing" : "Recommendation could not be checked"}: ${error instanceof Error ? error.message : error}`);
    } finally {
      if (match === this.matchRevision) { this.browserDeciding = false; void this.browserOffers(); }
    }
  }

  setStrategyOpen(strategyOpen: boolean) { this.set({ strategyOpen, ...(strategyOpen ? { open: false } : {}) }); }
  setOfferSteps(offerSteps: boolean) { this.set({ offerSteps }); }

  async selectStrategy(strategy: string | null, reserve = this.s.strategies?.reserve ?? 0) {
    if (this.s.strategyBusy) return;
    const revision = ++this.strategyRevision;
    const match = this.matchRevision;
    this.set({ strategyBusy: true, strategyError: "" });
    try {
      const strategies = await this.post<StrategyState>("v1/strategies", { strategy, reserve });
      if (match !== this.matchRevision) return;
      this.set({ strategies });
      this.push("system", strategies.active ? `Strategy selected: ${strategies.active.name}. Steps need your acceptance.` : "Strategy released. You have direct control.");
    } catch (e) {
      if (match === this.matchRevision) this.set({ strategyError: e instanceof Error ? e.message : String(e) });
    } finally {
      if (revision === this.strategyRevision) this.set({ strategyBusy: false });
    }
  }

  async strategyStep(automatic = false) {
    if (this.s.strategyBusy || this.s.uncertainProposalId || !this.s.strategies?.active) return;
    const revision = this.strategyRevision;
    const match = this.matchRevision;
    if (!automatic) this.set({ strategyBusy: true, strategyError: "" });
    try {
      const r = await this.post<CompanionReply>("v1/strategies/step", { automatic });
      if (revision !== this.strategyRevision || match !== this.matchRevision || store.get().phase !== "playing") return;
      // Automatic steps are quiet; polling adds their cards without repeating speech every 1.5 seconds.
      if (!automatic) this.reply(r);
    } catch (e) {
      if (match === this.matchRevision && !automatic) this.set({ strategyError: e instanceof Error ? e.message : String(e) });
    } finally {
      if (!automatic && revision === this.strategyRevision) this.set({ strategyBusy: false });
    }
  }

  /** Engine events (worker): status lines become feed entries; links and executed actions update the panel. */
  onEngine(e: CompanionEngineEvent) {
    if (e.kind === "link") { this.set({ linked: e.connected }); return; }
    if (e.kind === "executed") {
      if (this.s.mode === "browser" && (!this.browserProposals.has(e.id) || this.receipts.has(e.id))) return;
      this.receipts.set(e.id, { accepted: e.accepted, detail: e.detail });
      if (e.accepted) track("ai_assist", { mode: this.s.mode });
      this.set({ uncertainProposalId: this.s.uncertainProposalId === e.id ? "" : this.s.uncertainProposalId, feed: this.s.feed.map(f => f.proposalId === e.id ? { ...f, state: e.accepted ? "accepted" : "failed" } : f) });
      this.push(e.accepted ? "done" : "rejected", e.detail || (e.accepted ? "Orders issued" : "Orders refused"));
      return;
    }
    if (e.kind !== "status") return;
    const text = e.message.replace(/^AI\s*â€¢\s*/, "").trim();
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
    if (this.s.mode === "browser") { this.browserSuppressed = ""; await this.browserOffers(true); return; }
    if (!this.canIssue()) { this.push("system", "Return live before talking to the co-commander."); return; }
    text = text.trim();
    if (!text || this.s.thinking) return;
    const request = ++this.requestRevision;
    const match = this.matchRevision;
    this.push("you", text);
    this.set({ thinking: true });
    try {
      const r = await this.post<CompanionReply>("v1/advice", { contract_version: 1, question: text });
      if (match === this.matchRevision && request === this.requestRevision) this.reply(r);
    } catch (e) {
      if (match !== this.matchRevision || request !== this.requestRevision) return;
      this.push("system", `No answer: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (match === this.matchRevision && request === this.requestRevision) this.set({ thinking: false });
    }
  }

  async propose(text: string) {
    if (this.s.mode === "browser") { await this.ask(text); return; }
    text = text.trim();
    if (!text || this.s.thinking || this.s.uncertainProposalId || !this.canIssue()) return;
    const request = ++this.requestRevision;
    const match = this.matchRevision;
    this.push("you", text); this.set({ thinking: true });
    try { const reply = await this.post<CompanionReply>("v1/proposals", { contract_version: 1, instruction: text }); if (match === this.matchRevision && request === this.requestRevision) this.reply(reply); }
    catch (error) { if (match === this.matchRevision) this.push("system", `No proposal: ${String(error)}. Manual controls remain available.`); }
    finally { if (match === this.matchRevision) this.set({ thinking: false }); }
  }

  private reply(r: CompanionReply) {
    if (r.interrupted) return;
    if (r.metadata?.contextual_strategy) this.set({ strategies: r.metadata.contextual_strategy });
    const action = r.metadata?.action;
    if (action?.state === "pending" && action.proposal_id) {
      const summary = action.summary || r.text;
      if (!this.s.feed.some((item) => item.proposalId === action.proposal_id))
        this.offer(summary, { proposalId: action.proposal_id, state: "pending" });
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
    if (this.s.mode === "browser") { await this.browserDecide(item, accept); return; }
    if (this.s.uncertainProposalId) return;
    if (accept && !this.canIssue()) { this.push("system", "Return live before accepting orders."); return; }
    if (!item.proposalId || item.state !== "pending" || !this.s.feed.some(f => f.id === item.id && f.proposalId === item.proposalId && f.state === "pending")) return;
    const match = this.matchRevision;
    this.update(item.id, { state: accept ? "accepted" : "cancelled" });
    try {
      const r = await this.post<CompanionReply>(accept ? "v1/proposals/confirm" : "v1/proposals/cancel", { contract_version: 1, proposal_id: item.proposalId });
      if (match !== this.matchRevision) return;
      if (!accept) { if (r.metadata?.action?.state !== "cancelled") { this.update(item.id, { state: "failed" }); if (r.text) this.push("rejected", r.text); } return; }
      // A queued order shows as the engine's receipt (âœ“); only a refusal needs the companion's words.
      const state = r.metadata?.action?.state;
      if (state && !["executed", "queued", "accepted"].includes(state)) {
        this.update(item.id, { state: "failed" });
        if (r.text) this.push("rejected", r.text);
      }
    } catch (e) {
      if (match !== this.matchRevision) return;
      const receipt = this.receipts.get(item.proposalId);
      if (receipt) { this.update(item.id, { state: receipt.accepted ? "accepted" : "failed" }); return; }
      this.update(item.id, { state: "unknown" });
      this.set({ uncertainProposalId: item.proposalId });
      this.push("system", `Confirmation outcome unknown: ${e instanceof Error ? e.message : e}. Check the companion state before requesting a fresh proposal; manual controls remain available.`);
      await this.offers();
    }
  }

  /** The newest proposal still waiting for the player (G applies it outside text entry). */
  pending() { if (this.s.uncertainProposalId) return; return [...this.s.feed].reverse().find((f) => f.kind === "proposal" && f.state === "pending"); }

  // ---------------------------------------------------------------- voice

  async startListening() {
    if (this.s.mode === "browser") return;
    if (!this.canIssue()) return;
    if (this.recorder || this.s.listening) return;
    this.audio.stopVoice();
    const match = this.matchRevision;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    try {
      ctx = createAudioContext();
      if (!ctx) throw new Error("Audio capture is unavailable in this browser.");
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (match !== this.matchRevision) { stream.getTracks().forEach(t => t.stop()); void ctx.close().catch(() => {}); return; }
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(ctx.destination);
      this.recorder = { ctx, stream, node, chunks, rate: ctx.sampleRate };
      this.set({ listening: true });
    } catch (e) {
      stream?.getTracks().forEach(t => t.stop());
      if (ctx) void ctx.close().catch(() => {});
      if (match !== this.matchRevision) return;
      this.push("system", `Microphone unavailable: ${e instanceof Error ? e.message : e}`);
    }
  }

  async stopListening() {
    const match = this.matchRevision;
    const r = this.recorder;
    this.recorder = null;
    this.set({ listening: false });
    if (!r) return;
    r.node.disconnect();
    r.stream.getTracks().forEach((t) => t.stop());
    await r.ctx.close();
    const seconds = r.chunks.reduce((n, c) => n + c.length, 0) / r.rate;
    if (match !== this.matchRevision || seconds < 0.3) return;
    this.set({ thinking: true });
    try {
      const wav = encodeWav(r.chunks, r.rate, 16000);
      const res = await this.request(new URL(`${API}v1/transcribe?filename=question.wav`, base()), { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
      const t = await res.json() as { text?: string; error?: string };
      if (match !== this.matchRevision) return;
      if (!res.ok || !t.text) throw new Error(t.error ?? `HTTP ${res.status}`);
      this.set({ thinking: false });
      await this.ask(t.text);
    } catch (e) {
      if (match !== this.matchRevision) return;
      this.push("system", `Not heard: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (match === this.matchRevision) this.set({ thinking: false });
    }
  }

  async speak(text: string) {
    if (this.s.mode === "browser") return;
    const match = this.matchRevision;
    if (this.s.muted) return;
    try {
      const res = await this.request(new URL(`${API}v1/speak`, base()), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("audio/")) return;
      const audio = await res.arrayBuffer();
      if (match === this.matchRevision) await this.audio.voice(audio);
    } catch { /* speech is optional */ }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request(new URL(API + path, base()), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
