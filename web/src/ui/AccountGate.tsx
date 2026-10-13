import { useEffect, useState, type ReactNode } from "react";
import { Gamepad2, LockKeyhole, Map, Users } from "lucide-react";
import { onAccountChange, requireSignIn, signInUrl, siteOrigin } from "../net/account";

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
  return <main className="account-gate" aria-busy={state === "checking"}>
    {state === "out" && <section className="account-gate-card hud-panel">
      <span className="account-gate-icon"><LockKeyhole size={22} /></span>
      <span className="mp-eyebrow">RTS AI · FREE ACCOUNT</span>
      <h1>Sign in to play</h1>
      <p>{invite ? <>Your friend’s match <strong className="mp-code">{invite}</strong> is waiting. You’ll go straight to their lobby after signing in.</> : "One free account for the browser game, multiplayer with friends, and the Workshop."}</p>
      <ul>
        <li><Gamepad2 size={16} /> Skirmish and the Lines of Hope campaign</li>
        <li><Users size={16} /> Play with friends, directly</li>
        <li><Map size={16} /> Build battlefields in the Workshop</li>
      </ul>
      <a className="account-gate-primary" href={signInUrl()}>Sign in or create account</a>
      <a className="account-gate-secondary" href={`${siteOrigin}/download`}>Downloads stay free without an account</a>
    </section>}
  </main>;
}
