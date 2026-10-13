import { useState } from "react";
import { MessageSquareHeart, Star, X } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { Button } from "../components/ui/button";
import { OptionSelect, type Option } from "../components/ui/fields";
import { accountsConfigured, siteApi } from "../net/account";
import { track } from "../net/track";

// Same categories as the website's feedback (RTSAI-Web lib/feedback.ts); it files a private GitHub issue and emails
// the team. No screenshot or page content is sent, matching the website's privacy promise.
const CATEGORIES: Option<string>[] = ["Bug", "Gameplay", "UI/UX", "Feature Request", "AI Companion", "General"].map(c => ({ value: c, label: c }));

function context(game: Game) {
  const s = useStore.getState();
  let scenario: { map?: string; mission?: string; multiplayer?: boolean } = {};
  try { scenario = JSON.parse(game.scenarioJson || "{}"); } catch { /* none */ }
  const where = s.phase === "playing" ? `${scenario.multiplayer ? "multiplayer" : scenario.mission ? "campaign" : "skirmish"} on ${scenario.mission ?? scenario.map ?? "?"}, tick ${s.ui?.tick ?? "?"}` : s.phase;
  return `\n\n— Game: ${s.profile === "public-classic" ? "classic" : "isometric"} · ${where}`;
}

export function Feedback({ game, compact = false }: { game: Game; compact?: boolean }) {
  const [open, setOpen] = useState(false), [category, setCategory] = useState(useStore.getState().phase === "playing" ? "Gameplay" : "General");
  const [text, setText] = useState(""), [rating, setRating] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(""), [receipt, setReceipt] = useState("");
  if (!accountsConfigured) return null;
  async function send() {
    if (text.trim().length < 10) return setError("Add a little more detail (at least 10 characters).");
    setBusy(true); setError("");
    const response = await siteApi("/api/feedback", {
      category, title: "", description: (text.trim() + context(game)).slice(0, 4000), rating: rating || null,
      clientSubmissionId: crypto.randomUUID(), pagePath: "/play/",
      diagnostics: { metadata: { viewport: { width: innerWidth, height: innerHeight }, screen: { width: screen.width, height: screen.height }, devicePixelRatio, language: navigator.language, platform: navigator.platform, onLine: navigator.onLine } },
    });
    setBusy(false);
    const body = await response?.json().catch(() => null) as { receipt?: string; error?: string } | null;
    if (!response?.ok) return setError(body?.error || "Couldn't send your feedback. Check your connection and try again; your note is kept.");
    track("feedback_sent", { category });
    setReceipt(body?.receipt ?? "sent"); setText(""); setRating(0);
  }
  const close = () => { setOpen(false); setReceipt(""); setError(""); };
  return <>
    <Button size="sm" variant="outline" aria-label="Feedback" onClick={() => setOpen(true)}><MessageSquareHeart size={14} />{!compact && " Feedback"}</Button>
    {open && <div className="mp-overlay" onKeyDown={e => { if (e.key === "Escape") close(); e.stopPropagation(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="feedback-title" className="hud-panel feedback-dialog">
        <header className="mp-header"><div><span className="mp-eyebrow">RTS AI · FEEDBACK</span><h1 id="feedback-title">{receipt ? "Thank you" : "Tell us what you think"}</h1></div><Button variant="ghost" size="sm" aria-label="Close feedback" onClick={close}><X size={16} /></Button></header>
        {receipt ? <><p className="feedback-thanks">Your feedback reached the team. Receipt <strong className="mp-code">{receipt}</strong>.</p><div className="mp-actions"><Button onClick={close}>Back to the game</Button></div></> : <>
          <label className="mp-field">Topic<OptionSelect aria-label="Feedback topic" className="mp-picker" value={category} options={CATEGORIES} onValueChange={setCategory} /></label>
          <label className="mp-field">What happened, or what would make it better?<textarea aria-label="Your feedback" rows={6} maxLength={3800} autoFocus value={text} onChange={e => setText(e.target.value)} placeholder="The harvester got stuck behind the refinery after…" /></label>
          <div className="feedback-rating" role="radiogroup" aria-label="Rating (optional)"><span>How’s the game so far?</span>{[1, 2, 3, 4, 5].map(n => <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} of 5`} className={n <= rating ? "on" : ""} onClick={() => setRating(rating === n ? 0 : n)}><Star size={18} /></button>)}</div>
          {error && <p role="alert" className="mp-error">{error}</p>}
          <footer className="mp-actions"><Button size="lg" disabled={busy} onClick={() => void send()}>{busy ? "Sending…" : "Send feedback"}</Button><span className="mp-note" style={{ marginTop: 0 }}>Sent with your account and the game mode and map. No screenshot.</span></footer>
        </>}
      </section>
    </div>}
  </>;
}
