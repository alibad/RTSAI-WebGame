// Production tooltip for a sidebar cameo: name, cost, build time, power, what it is strong and weak against
// (parsed from the mod's own description), what is still missing, and the mouse hints. Shown beside the sidebar.

import type { CatalogItem } from "../sim/protocol";
import { PowerIcon } from "./icons";
import { Kbd as GameKbd } from "./kit/game";

const TICK_S = 0.04;

const STRONG = /\bstrong (?:vs\.?|against) ([^;.]+?)(?=[;.]|,\s*(?:weak|vulnerable)\b|$)/gi;
const WEAK = /\b(?:weak|vulnerable) (?:vs\.?|to|against) ([^;.]+?)(?=[;.]|$)/gi;
// The same clauses in the raw text, where a line break may fall anywhere inside them.
const STRONG_ML = /\bstrong\s+(?:vs\.?|against)\s+[^;.]+?(?=[;.]|,\s*(?:weak|vulnerable)\b|$)/gi;
const WEAK_ML = /\b(?:weak|vulnerable)\s+(?:vs\.?|to|against)\s+[^;.]+?(?=[;.]|$)/gi;

/** Role line plus strong/weak lists from a description such as "Line infantry.\nStrong vs infantry; weak vs armor." */
export function parseDescription(desc: string | undefined) {
  if (!desc) return { role: "", strong: [] as string[], weak: [] as string[] };
  const text = desc.replace(/\s+/g, " ").trim();
  const strong = [...text.matchAll(STRONG)].map((m) => m[1].trim());
  const weak = [...text.matchAll(WEAK)].map((m) => m[1].trim());
  // Everything else, as the engine's localisation gives it: every line of the description (a Fluent value's
  // continuation lines included) with the line breaks the desktop tooltip shows, minus the strong/weak clauses
  // listed below it (matched across line breaks too).
  const role = desc.replace(STRONG_ML, "").replace(WEAK_ML, "").split("\n")
    .map((l) => l.replace(/^[\s;,.]+|[\s;,]+$/g, "").trim())
    .filter((l) => l.length > 2)
    .join("\n");
  return { role, strong, weak };
}

function Stat({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={`ct-stat ${className ?? ""}`}>{children}</span>;
}

function Clock() {
  return (
    <svg viewBox="0 0 16 16" width={11} height={11} fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" />
    </svg>
  );
}

export function CameoTip({ item, top }: { item: CatalogItem; top: number }) {
  const { role, strong, weak } = parseDescription(item.desc);
  const seconds = Math.round(item.time * TICK_S);
  const height = 160 + 17 * Math.max(0, role.split("\n").length - 1) + 18 * (strong.length + weak.length);
  const y = Math.max(8, Math.min(top - 6, window.innerHeight - height - 8));
  return (
    <div className="ct-tip" style={{ top: y, right: "calc(var(--sidebar-w) + 10px)" }} role="tooltip">
      <div className="ct-name">{item.label}</div>
      <div className="ct-stats">
        <Stat className="text-[var(--hud-gold)]">${item.cost.toLocaleString("en-US")}</Stat>
        <Stat><Clock />{seconds}s</Stat>
        {item.power !== 0 && (
          <Stat className={item.power > 0 ? "text-[var(--hud-green)]" : "text-[var(--hud-red)]"}>
            <PowerIcon width={10} height={10} />{item.power > 0 ? `+${item.power}` : `−${-item.power}`}
          </Stat>
        )}
      </div>
      {role && <p className="ct-role">{role}</p>}
      {(strong.length > 0 || weak.length > 0) && (
        <div className="ct-vs">
          {strong.map((s) => (
            <div key={`s${s}`}><span className="text-[var(--hud-green)]" aria-label="Strong against">▲</span><span>{s}</span></div>
          ))}
          {weak.map((s) => (
            <div key={`w${s}`}><span className="text-[var(--hud-red)]" aria-label="Weak against">▼</span><span className="text-[#a9b19f]">{s}</span></div>
          ))}
        </div>
      )}
      {!item.buildable && item.requires?.length ? (
        <p className="ct-needs">Needs {item.requires.join(", ")}</p>
      ) : null}
      <div className="ct-hints">
        <span><GameKbd>LMB</GameKbd>build</span>
        <span><GameKbd>⇧</GameKbd>×5</span>
        <span><GameKbd>RMB</GameKbd>hold · cancel</span>
      </div>
    </div>
  );
}

/** A small key hint (kept for older imports; new code uses Kbd from the kit). */
export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="digits rounded-[2px] border border-white/15 bg-black/60 px-1 text-[9px] text-[var(--foreground)]">{children}</kbd>;
}
