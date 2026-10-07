// Production tooltip for a sidebar cameo: name, cost, build time, power, what it is strong and weak against
// (parsed from the mod's own description), what is still missing, and the mouse hints. Shown beside the sidebar.

import type { CatalogItem } from "../sim/protocol";
import { PowerIcon } from "./icons";

const TICK_S = 0.04;

const STRONG = /\bstrong (?:vs\.?|against) ([^;.]+?)(?=[;.]|,\s*(?:weak|vulnerable)\b|$)/gi;
const WEAK = /\b(?:weak|vulnerable) (?:vs\.?|to|against) ([^;.]+?)(?=[;.]|$)/gi;

/** Role line plus strong/weak lists from a description such as "Line infantry.\nStrong vs infantry; weak vs armor." */
export function parseDescription(desc: string | undefined) {
  if (!desc) return { role: "", strong: [] as string[], weak: [] as string[] };
  const text = desc.replace(/\s+/g, " ").trim();
  const strong = [...text.matchAll(STRONG)].map((m) => m[1].trim());
  const weak = [...text.matchAll(WEAK)].map((m) => m[1].trim());
  // The first sentence that is not about strengths: what the unit is for.
  const role = desc.split("\n")
    .map((l) => l.replace(STRONG, "").replace(WEAK, "").replace(/^[\s;,.]+|[\s;,]+$/g, "").trim())
    .find((l) => l.length > 2) ?? "";
  return { role, strong, weak };
}

function Stat({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={`digits inline-flex items-center gap-1 rounded-[2px] bg-black/50 px-1.5 py-[1px] ${className ?? ""}`}>{children}</span>;
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
  const height = 150;
  const y = Math.max(8, Math.min(top, window.innerHeight - height - 8));
  return (
    <div
      className="hud-panel pointer-events-none fixed z-30 w-[248px] px-3 py-2.5 text-[12px] leading-snug shadow-[0_8px_24px_rgba(0,0,0,0.6)]"
      style={{ top: y, right: "calc(var(--sidebar-w) + 6px)" }}
      role="tooltip"
    >
      <div className="text-[14px] font-bold text-[var(--hud-gold)]">{item.label}</div>
      <div className="mt-1.5 flex flex-wrap gap-1 text-[12px]">
        <Stat className="text-[var(--hud-gold)]">${item.cost.toLocaleString("en-US")}</Stat>
        <Stat><Clock />{seconds}s</Stat>
        {item.power !== 0 && (
          <Stat className={item.power > 0 ? "text-[var(--hud-green)]" : "text-[var(--hud-red)]"}>
            <PowerIcon width={10} height={10} />{item.power > 0 ? `+${item.power}` : `−${-item.power}`}
          </Stat>
        )}
      </div>
      {role && <p className="mt-1.5 text-[var(--muted-foreground)]">{role}</p>}
      {(strong.length > 0 || weak.length > 0) && (
        <div className="mt-1.5 grid gap-[2px]">
          {strong.map((s) => (
            <div key={`s${s}`} className="flex gap-1.5"><span className="text-[var(--hud-green)]" aria-label="Strong against">▲</span><span>{s}</span></div>
          ))}
          {weak.map((s) => (
            <div key={`w${s}`} className="flex gap-1.5"><span className="text-[var(--hud-red)]" aria-label="Weak against">▼</span><span className="text-[var(--muted-foreground)]">{s}</span></div>
          ))}
        </div>
      )}
      {!item.buildable && item.requires?.length ? (
        <p className="mt-1.5 text-[var(--hud-yellow)]">Needs {item.requires.join(", ")}</p>
      ) : null}
      <div className="mt-2 flex gap-2 border-t border-white/10 pt-1.5 text-[10px] text-[var(--hud-gold-dim)]">
        <span><Kbd>LMB</Kbd> build</span>
        <span><Kbd>⇧</Kbd> ×5</span>
        <span><Kbd>RMB</Kbd> hold · cancel</span>
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="digits rounded-[2px] border border-white/15 bg-black/60 px-1 text-[9px] text-[var(--foreground)]">{children}</kbd>;
}
