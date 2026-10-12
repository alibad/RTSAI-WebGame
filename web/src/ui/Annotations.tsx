import { useEffect, useRef, useState } from "react";
import type { Game } from "../game";
import { useStore } from "../store";

/** Read-only proposal overlay. Contact memory stores only positions that were actually visible. */
export function Annotations({ game }: { game: Game }) {
  const feed = useStore(s => s.cc.feed);
  const panelOpen = useStore(s => s.cc.strategyOpen || s.cc.open);
  const [dismissed, setDismissed] = useState(0);
  const [, update] = useState(0);
  const seen = useRef(new Map<number, { x: number; y: number; tick: number }>());
  const lastScenario = useRef("");
  useEffect(() => { const timer = setInterval(() => update(n => n + 1), 100); return () => clearInterval(timer); }, []);
  if (lastScenario.current !== game.scenarioJson) { seen.current.clear(); lastScenario.current = game.scenarioJson; }
  const s = game.client.cur;
  if (!s || !game.info || game.coach.review) return null;
  for (const a of s.actors) seen.current.set(a.id, { x: a.sx, y: a.sy, tick: s.header.tick });
  for (const [id, a] of seen.current) if (s.header.tick - a.tick > 750) seen.current.delete(id);
  const offer = [...feed].reverse().find(f => f.kind === "proposal" && f.state === "pending");
  if (!offer?.commands?.length || offer.id === dismissed) return null;
  const canvas = game.canvas.getBoundingClientRect();
  const scale = game.canvas.width / canvas.width;
  const project = (x: number, y: number) => ({ x: canvas.width / 2 + (x - game.cam.x) * game.cam.zoom / scale, y: canvas.height / 2 + (y - game.cam.y) * game.cam.zoom / scale });
  const paths = (offer.commands ?? []).slice(0, 24).flatMap(c => {
    const actor = c.actor_id === undefined ? undefined : s.actorById.get(c.actor_id);
    if (!actor || actor.owner !== s.header.localPlayer) return [];
    const from = { x: actor.sx, y: actor.sy };
    let to = from; let uncertain = false;
    if (c.target_actor_id) {
      const target = s.actorById.get(c.target_actor_id);
      const memory = seen.current.get(c.target_actor_id);
      if (!target && !memory) return [{ from, to: from, uncertain: false, action: c.action }];
      to = target ? { x: target.sx, y: target.sy } : memory!; uncertain = !target;
    } else if (["move", "attack_move", "attackmove", "place_building"].includes(c.action) && c.target_x !== undefined && c.target_y !== undefined) {
      // Companion observations and commands already use MPos in both game modes.
      const u = c.target_x, v = c.target_y;
      const [ox, oy] = game.info!.cellOrigin, [tw, th] = game.info!.tileSize;
      to = game.info!.gridType === "Rectangular"
        ? { x: ox + u * tw, y: oy + v * th }
        : { x: ox + (2 * u + (v & 1)) * tw / 2, y: oy + v * th / 2 };
    }
    return [{ from, to, uncertain, action: c.action }];
  });
  if (!paths.length) return null;
  return <div data-annotations data-proposal-id={offer.proposalId} className="pointer-events-none absolute left-0 top-0 overflow-hidden" style={{ width: canvas.width, height: canvas.height }}>
    <svg width="100%" height="100%" aria-label="Proposed orders preview"><defs><marker id="ai-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0L6 3L0 6" fill="none" stroke="#efd28b" /></marker></defs>{paths.map((p, i) => {
      const a = project(p.from.x, p.from.y), b = project(p.to.x, p.to.y);
      return <g key={i} opacity={p.uncertain ? .55 : .9}><circle cx={a.x} cy={a.y} r={16} fill="none" stroke="#efd28b" strokeWidth="2" /><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#efd28b" strokeWidth="2" strokeDasharray="7 5" markerEnd="url(#ai-arrow)" /><circle cx={b.x} cy={b.y} r="7" fill="none" stroke="#efd28b" strokeDasharray={p.uncertain ? "3 3" : undefined} /></g>;
    })}</svg>
    {!panelOpen && <div className="pointer-events-auto absolute left-3 top-[65px] max-w-[260px] rounded bg-black/85 p-2 text-xs">
      <button className="text-left text-[var(--hud-gold)]" onClick={() => game.lookAt(paths[0].from.x, paths[0].from.y)}>Preview · {paths[0].action.replaceAll('_', ' ')} · focus units</button>
      <p className="my-1 text-[var(--muted-foreground)]">Dashed lines show intent, not a computed route. {paths.some(p => p.uncertain) ? "Faded contact: last seen within 30s." : "Orders await your acceptance."}</p>
      <button className="underline" onClick={() => setDismissed(offer.id)}>Dismiss preview</button>
    </div>}
  </div>;
}
