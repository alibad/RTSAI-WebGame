import { useEffect, useState } from "react";
import type { Game } from "../game";
import { useStore } from "../store";
import { cn } from "../lib/utils";

export function Strategies({ game }: { game: Game }) {
  const cc = useStore((s) => s.cc);
  const [all, setAll] = useState(false);
  const [reserve, setReserve] = useState("0");
  const plan = cc.strategies;
  useEffect(() => { setReserve(String(plan?.reserve ?? 0)); }, [plan?.reserve]);
  const disabled = !cc.linked || cc.strategyBusy || !plan?.available;
  const validReserve = /^\d+$/.test(reserve) && Number(reserve) <= 10000;
  return (
    <section aria-label="Battlefield strategy" className="hud-panel rounded-[3px]">
      <button type="button" aria-expanded={cc.strategyOpen} onClick={() => game.cc.setStrategyOpen(!cc.strategyOpen)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px]">
        <span className="min-w-0 truncate text-[var(--hud-gold)]">Strategy · {plan?.active?.name ?? "Choose your approach"}</span>
        <span className="shrink-0 text-[var(--muted-foreground)]">{cc.strategyOpen ? "Close ▴" : "Choose ▾"}</span>
      </button>
      {cc.strategyOpen && (
        <div className="max-h-[60vh] overflow-y-auto border-t border-white/10 px-3 pb-3 text-[12px]" data-strategy-panel>
          <p className="mt-2 text-[var(--muted-foreground)]">{plan?.reason ?? "Waiting for the battlefield…"}</p>
          {plan?.active && <div className="my-2 border-l-2 border-[var(--hud-gold)] pl-2" aria-live="polite">
            <div className="text-[var(--hud-gold)]">{plan.active.progress} · {plan.active.status}</div>
            <p className="mt-1 leading-relaxed">{plan.active.next}</p>
          </div>}
          <div className="my-2 flex items-center justify-between">
            <span className="text-[var(--muted-foreground)]">{all ? "All approaches" : "For this situation"}</span>
            <button type="button" onClick={() => setAll(!all)} className="text-[var(--hud-gold)] underline underline-offset-2">
              {all ? "Contextual choices" : "All strategies"}
            </button>
          </div>
          <div className="grid gap-2">
            {(all ? plan?.all : plan?.choices)?.map((choice) => <button key={choice.id} type="button"
              aria-pressed={choice.id === plan?.active?.id} disabled={disabled}
              onClick={() => game.cc.selectStrategy(choice.id)}
              className={cn("rounded-[3px] border px-3 py-2 text-left disabled:opacity-45 hover:border-[var(--hud-gold)]",
                choice.id === plan?.active?.id ? "border-[var(--hud-gold)] bg-[rgba(241,210,139,0.08)]" : "border-white/15 bg-black/20")}>
              <span className="block font-semibold text-[var(--hud-gold)]">{choice.name}{choice.id === plan?.active?.id ? " · Active" : ""}</span>
              <span className="mt-1 block leading-relaxed">{choice.intent}</span>
              <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">{choice.tradeoff}</span>
            </button>)}
          </div>
          {plan?.active && <>
            <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (validReserve) game.cc.selectStrategy(plan.active!.id, Number(reserve)); }}>
              <label className="flex items-center gap-2">Keep credits
                <input aria-label="Credit reserve" type="number" min="0" max="10000" step="100" value={reserve} onChange={(e) => setReserve(e.target.value)}
                  className="w-[82px] rounded-[2px] border border-white/20 bg-black/50 px-2 py-1 outline-none focus:border-[var(--hud-gold)]" />
              </label>
              <button type="submit" disabled={disabled || !validReserve} className="rounded border border-white/20 px-2 py-1 disabled:opacity-45">Apply</button>
            </form>
            <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={cc.offerSteps} onChange={(e) => game.cc.setOfferSteps(e.target.checked)} /> Offer next steps automatically</label>
            <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">You accept each action. Direct orders remain yours.</p>
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={disabled} onClick={() => game.cc.strategyStep()}
                className="rounded-[2px] bg-[var(--hud-gold)] px-3 py-1.5 font-semibold text-[#1a160c] disabled:opacity-45">Prepare next step</button>
              <button type="button" disabled={disabled} onClick={() => game.cc.selectStrategy(null)}
                className="rounded-[2px] border border-white/20 px-3 py-1.5 disabled:opacity-45">Release strategy</button>
            </div>
          </>}
          {cc.strategyError && <p role="alert" className="mt-2 text-[var(--hud-red)]">{cc.strategyError}</p>}
        </div>
      )}
    </section>
  );
}
