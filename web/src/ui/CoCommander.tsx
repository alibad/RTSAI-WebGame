// The AI co-commander in the match: a comms strip over the battlefield (status, threat, the latest line, push-to-talk,
// mute), the order it proposes as a card to accept or cancel, and on demand the full feed with a text box.

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, ChevronUp, Mic, Radio, Send, Sparkles, Volume2, VolumeX, X } from "lucide-react";
import type { Game } from "../game";
import type { FeedItem } from "../cocommander";
import { useStore } from "../store";
import { GameButton, Kbd } from "./kit/game";
import { Strategies } from "./Strategies";
import { SHORT_SCREEN, useMedia } from "./use-media";

const THREAT = { calm: "var(--hud-green)", guarded: "var(--hud-yellow)", high: "#ff8a3d", critical: "var(--hud-red)" } as Record<string, string>;
const IMPORTANCE = { routine: "#8f9886", important: "var(--hud-yellow)", critical: "var(--hud-red)" } as Record<string, string>;
const STATE_COLOR = { offline: "#5b625a", ready: "var(--hud-green)", thinking: "var(--hud-accent)", listening: "var(--hud-red)", error: "var(--hud-red)" };

function Avatar({ state }: { state: keyof typeof STATE_COLOR }) {
  const color = STATE_COLOR[state];
  return (
    <span className="cc-avatar" title={state} aria-label={`Co-commander ${state}`}>
      <Radio />
      <i className={state === "thinking" || state === "listening" ? "is-busy" : undefined} style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
    </span>
  );
}

function Threat({ score, level, reason }: { score: number; level: string; reason: string }) {
  const color = THREAT[level] ?? THREAT.calm;
  const lit = Math.max(1, Math.ceil(score / 20));
  return (
    <span className="cc-threat" data-tip={`Threat: ${level}${reason ? ` · ${reason}` : ""}`} aria-label={`Threat ${level}`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} style={{ height: 6 + i * 2.5, background: i < lit ? color : "#20261f", boxShadow: i < lit ? `0 0 4px ${color}` : undefined }} />
      ))}
    </span>
  );
}

function ProposalCard({ game, item }: { game: Game; item: FeedItem }) {
  const paused = useStore(s => s.paused);
  const uncertain = useStore(s => !!s.cc.uncertainProposalId);
  const shortcut = game.cc.pending()?.id === item.id;
  return (
    <div className={`cc-offer${item.state === "expired" ? " is-expired" : ""}`}>
      <ArrowRight />
      <span className="cc-offer-text"><small>Recommended order</small><span>{item.text}</span></span>
      {item.state === "pending" ? (
        <span className="cc-offer-actions">
          <button type="button" className="cc-apply" disabled={uncertain || paused} onClick={() => game.cc.decide(item, true)} title={shortcut ? "Apply recommendation (J)" : "Apply recommendation"}
            aria-label={shortcut ? "Apply recommendation (J)" : "Apply recommendation"} aria-keyshortcuts={shortcut ? "j" : undefined}>
            <Check size={14} strokeWidth={3} />Apply{shortcut && <kbd>J</kbd>}
          </button>
          <button type="button" className="cc-cancel" onClick={() => game.cc.decide(item, false)} title="Cancel" aria-label="Cancel"><X /></button>
        </span>
      ) : (
        <span className={`cc-state${item.state === "accepted" ? " is-ok" : ""}`} title={item.state === "expired" ? "No longer offered" : undefined}>
          {item.state === "applying" ? "Applying…" : item.state === "accepted" ? "Done" : item.state === "unknown" ? "Check outcome" : item.state === "expired" ? "Expired" : "Cancelled"}
        </span>
      )}
    </div>
  );
}

/** The recommended order inside the strip (short screens): its text, Apply and Cancel on one line. */
function InlineProposal({ game, item }: { game: Game; item: FeedItem }) {
  const paused = useStore(s => s.paused);
  const uncertain = useStore(s => !!s.cc.uncertainProposalId);
  return (
    <span className="cc-inline-offer">
      <button type="button" className="cc-line" title={item.text} onClick={() => game.cc.setOpen(true)}><ArrowRight size={13} aria-hidden="true" />{item.text}</button>
      {item.state === "pending" ? <>
        <button type="button" className="cc-apply" disabled={uncertain || paused} onClick={() => game.cc.decide(item, true)} aria-label="Apply recommendation"><Check size={14} strokeWidth={3} />Apply</button>
        <button type="button" className="cc-cancel" onClick={() => game.cc.decide(item, false)} aria-label="Cancel"><X /></button>
      </> : <span className="cc-state">{item.state === "applying" ? "Applying…" : "Done"}</span>}
    </span>
  );
}

function Line({ game, item }: { game: Game; item: FeedItem }) {
  if (item.kind === "proposal") return <ProposalCard game={game} item={item} />;
  if (item.kind === "you") return <div className="cc-you">{item.text}</div>;
  if (item.kind === "system") return <div className="cc-sys">{item.text}</div>;
  if (item.kind === "done" || item.kind === "rejected") {
    const ok = item.kind === "done";
    return <div className="cc-result" style={{ color: ok ? "var(--hud-green)" : "#ff9c86" }}>{ok ? <Check /> : <X />}<span>{item.text}</span></div>;
  }
  const color = item.kind === "alert" ? IMPORTANCE[item.importance ?? "routine"] ?? IMPORTANCE.routine : "var(--hud-green)";
  return (
    <div className="cc-msg">
      <i style={{ background: color }} />
      <span style={{ color: item.kind === "alert" && item.importance === "critical" ? "#ff9c86" : undefined }}>{item.text}</span>
    </div>
  );
}

export function CoCommander({ game }: { game: Game }) {
  const cc = useStore((s) => s.cc);
  const available = useStore((s) => s.ccAvailable);
  const hud = useStore((s) => s.ui?.companion);
  const [text, setText] = useState("");
  const paused = useStore(s => s.paused);
  // A campaign operation's objectives sit at the top left (Missions.tsx): the strip moves beside them.
  const mission = useStore((s) => !!s.ui?.mission);
  const feedRef = useRef<HTMLDivElement>(null);
  // Short screens: one line only; a recommended order takes the strip's line instead of a card under it.
  const short = useMedia(SHORT_SCREEN);
  useEffect(() => { feedRef.current?.scrollTo({ top: 1e6 }); }, [cc.feed.length, cc.open]);
  if (!cc.enabled || !available || game.sandboxMatch || game.replayMatch) return null;

  const state = cc.listening ? "listening" : cc.thinking || hud?.state.startsWith("thinking") ? "thinking"
    : cc.error || hud?.state === "error" ? "error" : cc.linked && cc.running ? "ready" : "offline";
  const last = [...cc.feed].reverse().find((f) => f.kind !== "proposal");
  const line = cc.listening ? "Listening…" : cc.thinking ? "Thinking…" : cc.error ? cc.error
    : last?.text ?? (hud?.message.replace(/^AI\s*•\s*/, "") || (cc.mode === "browser" ? "Watching the battlefield for useful tips." : "Hold V to talk"));
  const pending = game.cc.pending() ?? cc.feed.find(f => f.state === "applying");
  const threat = cc.mode === "browser" ? cc.browserThreat : hud?.threat;
  // Typed like spoken: questions are answered and orders become cards (game.cc.talk).
  const send = () => { const t = text; setText(""); void game.cc.talk(t); };

  return (
    <div aria-label={cc.mode === "browser" ? "Built-in adviser" : "AI co-commander"} className={`cc-root${mission ? " has-mission" : ""}${cc.open || cc.strategyOpen ? " is-open" : ""}`}>
      <div className="cc-col" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cc-strip">
          <Avatar state={state} />
          <Threat score={threat?.score ?? 0} level={threat?.level ?? "calm"} reason={threat?.reason ?? ""} />
          {short && !cc.open && pending ? <InlineProposal game={game} item={pending} />
            : <button type="button" onClick={() => game.cc.setOpen(!cc.open)} className="cc-line" title={line}>{line}</button>}
          {cc.mode !== "browser" && <button type="button" aria-label="Hold to talk (V)" data-tip="Hold to talk · V"
            onPointerDown={(e) => { e.preventDefault(); game.cc.startListening(); }} onPointerUp={() => game.cc.stopListening()} onPointerLeave={() => cc.listening && game.cc.stopListening()}
            className={`cc-icon${cc.listening ? " is-live" : ""}`}>
            <Mic /><span className="cc-key">V</span>
          </button>}
          {cc.mode !== "browser" && <button type="button" aria-label={cc.muted ? "Unmute" : "Mute"} data-tip={cc.muted ? "Unmute voice" : "Mute voice"} onClick={() => game.cc.toggleMute()} className="cc-icon">
            {cc.muted ? <VolumeX /> : <Volume2 />}
          </button>}
          <button type="button" aria-label={cc.open ? "Hide feed" : "Show feed"} data-tip={cc.open ? "Hide" : "Adviser feed"} onClick={() => game.cc.setOpen(!cc.open)} className="cc-icon">
            {cc.open ? <ChevronUp /> : <ChevronDown />}
          </button>
        </div>

        {cc.mode !== "browser" && <Strategies game={game} />}
        {cc.uncertainProposalId && <div className="hud-card cc-alert" role="alert">
          <span>The last order's outcome is unknown. Check the battlefield before asking for more.</span>
          <GameButton size="sm" onClick={() => game.cc.acknowledgeOutcome()}>I checked this outcome</GameButton>
        </div>}
        {!cc.open && pending && !short && <ProposalCard game={game} item={pending} />}

        {cc.open && (
          <div className="cc-feed hud-card">
            <div ref={feedRef} className="cc-feed-log">
              {cc.feed.length === 0 && <div className="cc-empty">Ask a question or give an order</div>}
              {cc.feed.map((item) => <Line key={item.id} game={game} item={item} />)}
            </div>
            {cc.mode === "browser" ? <div className="cc-foot">
              <p>Built-in adviser · {cc.auto ? "Recommended orders are applied automatically." : "Review each recommended order, then choose Apply."}</p>
              <GameButton size="sm" variant="primary" icon={<Sparkles size={14} />} onClick={() => game.cc.ask("What should I do next?")} disabled={!cc.linked || paused}>Next suggestion</GameButton>
            </div> : <form className="cc-foot" onSubmit={(e) => { e.preventDefault(); send(); }}>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask for advice or prepare orders…" aria-label="Ask the co-commander" data-cc-input className="cc-input" />
              <GameButton type="submit" size="sm" variant="primary" icon={<Send size={13} />} disabled={!text.trim() || cc.thinking}>Ask</GameButton>
              <GameButton size="sm" disabled={!text.trim() || cc.thinking || !!cc.uncertainProposalId} onClick={() => { const instruction = text; setText(""); void game.cc.propose(instruction); }}>Prepare orders</GameButton>
              <span className="hud-hint"><Kbd>V</Kbd> talk</span>
            </form>}
          </div>
        )}
      </div>
    </div>
  );
}
