// The co-commander's strategy: pick an approach (for this situation or from all of them), keep a credit reserve, and
// let it prepare each next step for you to accept.

import { useEffect, useState } from "react";
import { ChevronDown, Compass, Footprints, Unlink } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { GameButton } from "./kit/game";

export function Strategies({ game }: { game: Game }) {
  const cc = useStore((s) => s.cc);
  const [all, setAll] = useState(false);
  const [reserve, setReserve] = useState("0");
  const plan = cc.strategies;
  useEffect(() => { setReserve(String(plan?.reserve ?? 0)); }, [plan?.reserve]);
  const disabled = !cc.linked || cc.strategyBusy || !plan?.available;
  const validReserve = /^\d+$/.test(reserve) && Number(reserve) <= 10000;
  const name = plan?.active?.name ?? "Choose your approach";
  return (
    <section aria-label="Battlefield strategy" className="st-panel hud-card">
      <button type="button" className="st-head" aria-expanded={cc.strategyOpen} aria-label={`Strategy · ${name}`} onClick={() => game.cc.setStrategyOpen(!cc.strategyOpen)}>
        <Compass />
        <span><small>Strategy</small><b>{name}</b></span>
        <em>{cc.strategyOpen ? "Close" : plan?.active ? "Change" : "Choose"}<ChevronDown /></em>
      </button>
      {cc.strategyOpen && (
        <div className="st-body" data-strategy-panel>
          <p className="st-reason">{plan?.reason ?? "Waiting for the battlefield…"}</p>
          {plan?.active && <div className="st-active" aria-live="polite">
            <b>{plan.active.progress} · {plan.active.status}</b>
            <p>{plan.active.next}</p>
          </div>}
          <div className="st-filter">
            <span>{all ? "All approaches" : "For this situation"}</span>
            <button type="button" className="st-link" onClick={() => setAll(!all)}>{all ? "Contextual choices" : "All strategies"}</button>
          </div>
          <div className="st-choices">
            {(all ? plan?.all : plan?.choices)?.map((choice) => <button key={choice.id} type="button" className="st-choice"
              aria-pressed={choice.id === plan?.active?.id} disabled={disabled} onClick={() => game.cc.selectStrategy(choice.id)}>
              <b>{choice.name}{choice.id === plan?.active?.id ? " · Active" : ""}</b>
              <span>{choice.intent}</span>
              <small>{choice.tradeoff}</small>
            </button>)}
          </div>
          {plan?.active && <>
            <form className="st-reserve" onSubmit={(e) => { e.preventDefault(); if (validReserve) game.cc.selectStrategy(plan.active!.id, Number(reserve)); }}>
              <label>Keep credits
                <input aria-label="Credit reserve" type="number" min="0" max="10000" step="100" value={reserve} onChange={(e) => setReserve(e.target.value)} />
              </label>
              <GameButton type="submit" size="sm" disabled={disabled || !validReserve}>Apply</GameButton>
            </form>
            <label className="st-check"><input type="checkbox" checked={cc.offerSteps} onChange={(e) => game.cc.setOfferSteps(e.target.checked)} />Offer next steps automatically</label>
            <p className="st-note">You accept each action. Direct orders stay yours.</p>
            <div className="st-actions">
              <GameButton size="sm" variant="primary" icon={<Footprints size={14} />} disabled={disabled} onClick={() => game.cc.strategyStep()}>Prepare next step</GameButton>
              <GameButton size="sm" variant="ghost" icon={<Unlink size={14} />} disabled={disabled} onClick={() => game.cc.selectStrategy(null)}>Release strategy</GameButton>
            </div>
          </>}
          {cc.strategyError && <p role="alert" className="st-error">{cc.strategyError}</p>}
        </div>
      )}
    </section>
  );
}
