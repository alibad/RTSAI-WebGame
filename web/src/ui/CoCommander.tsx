// The AI co-commander in the match: a comms strip over the battlefield (status, threat, the latest line, push-to-talk,
// mute), the order it proposes as a card to accept or cancel, and on demand the full feed with a text box.

import { useEffect, useRef, useState } from "react";
import type { Game } from "../game";
import type { FeedItem } from "../cocommander";
import { useStore } from "../store";
import { cn } from "../lib/utils";
import { Kbd } from "./CameoTip";
import { Strategies } from "./Strategies";

const THREAT = { calm: "var(--hud-green)", guarded: "var(--hud-yellow)", high: "#ff8a3d", critical: "var(--hud-red)" } as Record<string, string>;
const IMPORTANCE = { routine: "var(--muted-foreground)", important: "var(--hud-yellow)", critical: "var(--hud-red)" } as Record<string, string>;

function MicIcon(p: React.SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>;
}
function SpeakerIcon({ muted, ...p }: React.SVGProps<SVGSVGElement> & { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4 9h4l5-4v14l-5-4H4Z" fill="currentColor" stroke="none" />
      {muted ? <path d="m16 9 5 6m0-6-5 6" /> : <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" />}
    </svg>
  );
}
function Chevron({ up, ...p }: React.SVGProps<SVGSVGElement> & { up: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" {...p}><path d={up ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>;
}

function Orb({ state }: { state: "offline" | "ready" | "thinking" | "listening" | "error" }) {
  const color = { offline: "#5b625a", ready: "var(--hud-green)", thinking: "var(--hud-gold)", listening: "var(--hud-red)", error: "var(--hud-red)" }[state];
  return (
    <span className="relative grid size-[14px] place-items-center" title={state} aria-label={`Co-commander ${state}`}>
      {(state === "thinking" || state === "listening") && <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: color }} />}
      <span className="size-[10px] rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
    </span>
  );
}

function Threat({ score, level, reason }: { score: number; level: string; reason: string }) {
  const color = THREAT[level] ?? THREAT.calm;
  const lit = Math.max(1, Math.ceil(score / 20));
  return (
    <span className="flex items-end gap-[2px]" title={`Threat ${score} · ${level}${reason ? ` · ${reason}` : ""}`} aria-label={`Threat ${level}`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className="w-[4px] rounded-[1px]" style={{ height: 6 + i * 2, background: i < lit ? color : "#20261f", boxShadow: i < lit ? `0 0 4px ${color}` : undefined }} />
      ))}
    </span>
  );
}

function ProposalCard({ game, item, compact }: { game: Game; item: FeedItem; compact?: boolean }) {
  const shortcut = game.cc.pending()?.id === item.id;
  return (
    <div className={cn("flex items-center gap-3 rounded-[3px] border border-[var(--hud-gold-dim)] bg-[rgba(30,26,14,0.92)] px-3 py-2", compact && "shadow-[0_8px_24px_rgba(0,0,0,0.55)]")}>
      <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="var(--hud-gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M4 12h12M12 6l6 6-6 6" /></svg>
      <span className={cn("min-w-0 flex-1 text-[13px] leading-snug", item.state === "expired" ? "text-[var(--muted-foreground)]" : "text-[var(--foreground)]")}>{item.text}</span>
      {item.state === "pending" ? (
        <span className="flex shrink-0 gap-1.5">
          <button type="button" onClick={() => game.cc.decide(item, true)} title={shortcut ? "Apply recommendation (G)" : "Apply recommendation"}
            aria-label={shortcut ? "Apply recommendation (G)" : "Apply recommendation"} aria-keyshortcuts={shortcut ? "g" : undefined}
            className="flex items-center gap-2 rounded-[2px] bg-[var(--hud-gold)] px-2.5 py-1 text-[12px] font-bold text-[#1a160c] hover:brightness-110"><span>✓ Apply</span>{shortcut && <kbd className="rounded border border-black/25 px-1 text-[10px] font-medium">G</kbd>}</button>
          <button type="button" onClick={() => game.cc.decide(item, false)} title="Cancel"
            className="rounded-[2px] border border-white/15 px-2.5 py-1 text-[12px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]">✕</button>
        </span>
      ) : (
        <span className={cn("text-[12px]", item.state === "accepted" ? "text-[var(--hud-green)]" : "text-[var(--muted-foreground)]")}
          title={item.state === "expired" ? "No longer offered" : undefined}>{item.state === "accepted" ? "✓" : item.state === "expired" ? "–" : "✕"}</span>
      )}
    </div>
  );
}

function Line({ game, item }: { game: Game; item: FeedItem }) {
  if (item.kind === "proposal") return <ProposalCard game={game} item={item} />;
  if (item.kind === "you") return <div className="ml-10 self-end rounded-[3px] bg-[rgba(241,210,139,0.12)] px-2.5 py-1.5 text-[13px] text-[var(--hud-gold)]">{item.text}</div>;
  if (item.kind === "system") return <div className="text-center text-[11px] text-[var(--muted-foreground)]">{item.text}</div>;
  if (item.kind === "done" || item.kind === "rejected") {
    const ok = item.kind === "done";
    return <div className={cn("flex gap-1.5 text-[12px]", ok ? "text-[var(--hud-green)]" : "text-[var(--hud-red)]")}><span>{ok ? "✓" : "✕"}</span><span>{item.text}</span></div>;
  }
  const color = item.kind === "alert" ? IMPORTANCE[item.importance ?? "routine"] ?? IMPORTANCE.routine : "var(--foreground)";
  return (
    <div className="mr-10 flex gap-2 text-[13px] leading-snug">
      <span className="mt-[5px] size-[6px] shrink-0 rounded-full" style={{ background: item.kind === "alert" ? color : "var(--hud-green)" }} />
      <span style={{ color: item.kind === "alert" && item.importance === "critical" ? color : undefined }}>{item.text}</span>
    </div>
  );
}

export function CoCommander({ game }: { game: Game }) {
  const cc = useStore((s) => s.cc);
  const available = useStore((s) => s.ccAvailable);
  const hud = useStore((s) => s.ui?.companion);
  const [text, setText] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => { feedRef.current?.scrollTo({ top: 1e6 }); }, [cc.feed.length, cc.open]);
  if (!cc.enabled || !available) return null;

  const state = cc.listening ? "listening" : cc.thinking || hud?.state.startsWith("thinking") ? "thinking"
    : cc.error || hud?.state === "error" ? "error" : cc.linked && cc.running ? "ready" : "offline";
  const last = [...cc.feed].reverse().find((f) => f.kind !== "proposal");
  const line = cc.listening ? "Listening…" : cc.thinking ? "Thinking…" : cc.error ? cc.error
    : last?.text ?? (hud?.message.replace(/^AI\s*•\s*/, "") || "Hold V to talk");
  const pending = game.cc.pending();
  const send = () => { const t = text; setText(""); game.cc.ask(t); };

  return (
    <div className="pointer-events-none absolute left-0 top-[10px] flex justify-center" style={{ right: "var(--sidebar-w)" }}>
      <div className="pointer-events-auto flex w-[460px] max-w-[calc(100%-16px)] flex-col gap-1.5" onMouseDown={(e) => e.stopPropagation()}>
        <div className="hud-panel flex h-[38px] items-center gap-2.5 rounded-[3px] px-2.5">
          <Orb state={state} />
          <Threat score={hud?.threat.score ?? 0} level={hud?.threat.level ?? "calm"} reason={hud?.threat.reason ?? ""} />
          <button type="button" onClick={() => game.cc.setOpen(!cc.open)} className="min-w-0 flex-1 truncate text-left text-[13px] text-[var(--foreground)]" title={line}>
            {line}
          </button>
          <button type="button" aria-label="Hold to talk (V)" title="Hold to talk (V)"
            onPointerDown={(e) => { e.preventDefault(); game.cc.startListening(); }} onPointerUp={() => game.cc.stopListening()} onPointerLeave={() => cc.listening && game.cc.stopListening()}
            className={cn("relative grid size-[28px] place-items-center rounded-[3px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]", cc.listening && "bg-[var(--hud-red)]/25 text-[var(--hud-red)]")}>
            <MicIcon width={16} height={16} />
            <span className="digits absolute bottom-[-1px] right-[1px] text-[8px] text-[var(--hud-gold-dim)]">V</span>
          </button>
          <button type="button" aria-label={cc.muted ? "Unmute" : "Mute"} title={cc.muted ? "Unmute voice" : "Mute voice"} onClick={() => game.cc.toggleMute()}
            className="grid size-[28px] place-items-center rounded-[3px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
            <SpeakerIcon muted={cc.muted} width={16} height={16} />
          </button>
          <button type="button" aria-label={cc.open ? "Hide feed" : "Show feed"} onClick={() => game.cc.setOpen(!cc.open)}
            className="grid size-[28px] place-items-center rounded-[3px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
            <Chevron up={cc.open} width={16} height={16} />
          </button>
        </div>

        <Strategies game={game} />
        {!cc.open && pending && <ProposalCard game={game} item={pending} compact />}

        {cc.open && (
          <div className="hud-panel flex max-h-[46vh] flex-col rounded-[3px]">
            <div ref={feedRef} className="no-scrollbar flex flex-col gap-2 overflow-y-auto px-3 py-3">
              {cc.feed.length === 0 && <div className="text-center text-[12px] text-[var(--muted-foreground)]">Ask a question or give an order</div>}
              {cc.feed.map((item) => <Line key={item.id} game={game} item={item} />)}
            </div>
            <form className="flex items-center gap-2 border-t border-white/10 px-2.5 py-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask or order…" aria-label="Ask the co-commander" data-cc-input
                className="min-w-0 flex-1 rounded-[2px] bg-black/50 px-2 py-1.5 text-[13px] text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus:ring-1 focus:ring-[var(--hud-gold-dim)]" />
              <button type="submit" disabled={!text.trim()} className="rounded-[2px] bg-[var(--hud-gold)] px-3 py-1.5 text-[12px] font-bold text-[#1a160c] disabled:opacity-40">Send</button>
              <span className="text-[10px] text-[var(--hud-gold-dim)]"><Kbd>V</Kbd> talk</span>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
