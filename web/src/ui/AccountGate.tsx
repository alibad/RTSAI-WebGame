import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, Download, LogIn, Map, Swords, Users } from "lucide-react";
import { onAccountChange, requireSignIn, signInUrl, siteOrigin } from "../net/account";
import { ScreenBackdrop } from "./screen-parts";

/**
 * The public game starts (and downloads its ~40 MB engine, maps and first art) only for signed-in players. Sign-in happens on
 * the website, which sends the player straight back here, invite code included.
 */
export function AccountGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "out" | "in">(requireSignIn ? "checking" : "in");
  useEffect(() => {
    if (!requireSignIn) return;
    let off: (() => void) | undefined, active = true;
    // Once in, stay in: signing out in another tab never tears down a running match.
    void onAccountChange(user => setState(s => s === "in" || user ? "in" : "out")).then(f => { if (active) off = f; else f(); });
    return () => { active = false; off?.(); };
  }, []);
  if (state === "in") return <>{children}</>;
  const invite = new URLSearchParams(location.search).get("join");
  return <main className="ag-root" aria-busy={state === "checking"} data-ui-sfx>
    <ScreenBackdrop />
    <div className="ag-logo">
      <span className="menu-eyebrow">Modern real-time strategy</span>
      <div className="ag-wordmark">RTS <b>AI</b></div>
    </div>
    {state === "checking" && <span className="spinner ag-checking" role="status" aria-label="Checking your account" />}
    {state === "out" && <section className="ag-panel">
      {invite ? <div className="ag-invite">
        <span className="ag-invite-icon" aria-hidden="true"><Users size={18} /></span>
        <div><span className="menu-eyebrow">Your friend’s match is waiting</span><strong className="mp-code">{invite}</strong></div>
      </div> : null}
      <h1>Sign in to play</h1>
      <p>{invite ? "Sign in and you’ll go straight to their lobby." : "One free account for the browser game, multiplayer with friends, and the Workshop."}</p>
      <ul className="ag-features">
        <li style={{ backgroundImage: 'url("menu/skirmish.webp")' }}><Swords size={16} aria-hidden="true" /><span>Skirmish</span></li>
        <li style={{ backgroundImage: 'url("menu/campaign.webp")' }}><BookOpen size={16} aria-hidden="true" /><span>Lines of Hope</span></li>
        <li style={{ backgroundImage: 'url("menu/isometric.webp")' }}><Users size={16} aria-hidden="true" /><span>Play with friends</span></li>
        <li style={{ backgroundImage: 'url("menu/classic.webp")' }}><Map size={16} aria-hidden="true" /><span>Workshop</span></li>
      </ul>
      <a className="gbtn gbtn-primary gbtn-lg ag-primary" href={signInUrl()}><LogIn size={17} aria-hidden="true" />Sign in or create account</a>
      <a className="ag-secondary" href={`${siteOrigin}/download`}><Download size={13} aria-hidden="true" />Downloads stay free without an account</a>
    </section>}
  </main>;
}
