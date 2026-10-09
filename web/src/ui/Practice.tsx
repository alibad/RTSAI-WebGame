import { GameSelect } from "../components/ui/fields";
import { useEffect, useState } from "react";
import type { Game } from "../game";
import { useStore } from "../store";
import { planFromText, practiceScenario, validatePlan, type PracticePlan, type UnitOption } from "../ai-lab";

export function Practice({ game, close }: { game: Game; close: () => void }) {
  const setup = useStore(s => s.setup);
  const factions = setup?.factions.filter(f => !f.random) ?? [];
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [plan, setPlan] = useState<PracticePlan | null>(null);
  const [request, setRequest] = useState(new URLSearchParams(location.search).get("prompt") ?? "Defend with 6 tanks against 8 units for 2 minutes");
  const [busy, setBusy] = useState(false);
  const [validated, setValidated] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const wait = () => new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => { const s = useStore.getState(); if (s.phase === "playing") { clearInterval(timer); resolve(); } else if (s.phase === "error" || Date.now() - started > 120000) { clearInterval(timer); reject(new Error(s.error || "Preview timed out.")); } }, 100);
  });
  useEffect(() => {
    let alive = true;
    setBusy(true);
    const empty = { map: "web-arena", seed: 42, sandbox: true, players: [{ slot: "Multi0", faction: "saudi", bot: "webidle" }, { slot: "Multi1", faction: "iran", bot: "webidle" }], options: { explored: "True", fog: "False", shortgame: "False" } };
    game.start(JSON.stringify(empty), true);
    wait().then(() => game.command<{ units: UnitOption[] }>({ cmd: "units" })).then(r => {
      if (!alive) return;
      const catalog = r.units.filter(u => !["Ship"].includes(u.queue));
      setUnits(catalog); setPlan(planFromText(request, catalog, factions.map(f => f.id)));
    }).catch(e => alive && setErrors([String(e)])).finally(() => alive && setBusy(false));
    return () => { alive = false; };
  }, [game]);
  const patch = (p: Partial<PracticePlan>) => { setPlan(old => old ? { ...old, ...p } : null); setValidated(""); setErrors([]); };
  const frame = () => {
    const info = game.info; if (!info) return;
    const [ox, oy] = info.cellOrigin, [tw, th] = info.tileSize;
    game.cam.zoom = Math.max(.35, Math.min(1.5, game.canvas.width / (31 * tw + 500), game.canvas.height / 550));
    game.lookAt(ox + 125 * tw / 2, oy + 64 * th / 2);
  };
  const preview = async () => {
    if (!plan) return;
    const problems = validatePlan(plan, units, factions.map(f => f.id)); setErrors(problems); setValidated("");
    if (problems.length) return;
    setBusy(true);
    try {
      game.start(JSON.stringify(practiceScenario(plan, false)), true); await wait();
      const check = await game.command<{ valid: boolean; errors: string[] }>({ cmd: "validate-practice" });
      if (!check.valid) setErrors(check.errors);
      else { setValidated(JSON.stringify(plan)); frame(); }
    } catch (e) { setErrors([String(e)]); } finally { setBusy(false); }
  };
  return <section data-practice className="absolute inset-y-4 right-4 z-50 w-[420px] max-w-[calc(100%-32px)] overflow-auto hud-panel p-5 text-sm" onKeyDown={e => e.stopPropagation()}>
    <div className="flex items-center justify-between"><h2 className="text-xl font-bold text-[var(--hud-gold)]">Scenario workshop</h2><button onClick={() => { game.quit(); close(); }}>✕</button></div>
    <p className="my-3 text-[var(--muted-foreground)]">Describe a short battle, refine the plan, then preview it. Uses the engine’s unit catalog and a flat practice arena. Original fictional exercises; no model connection required.</p>
    <form onSubmit={e => { e.preventDefault(); if (plan) { setPlan(planFromText(request, units, factions.map(f => f.id), plan)); setValidated(""); } }}>
      <textarea aria-label="Scenario request" value={request} onChange={e => setRequest(e.target.value)} className="w-full bg-black/60 p-2" rows={3} />
      <button disabled={busy || !plan} className="my-2 text-[var(--hud-gold)]">Interpret request</button>
    </form>
    {plan && <div className="grid grid-cols-2 gap-3">
      {([['faction', 'Your faction'], ['enemy', 'Opponent faction']] as const).map(([key, label]) => <label key={key}>{label}<GameSelect aria-label={label} value={plan[key]} onChange={e => patch({ [key]: e.target.value })} className="block w-full bg-black p-2">{factions.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</GameSelect></label>)}
      {([['unit', 'Your unit'], ['enemyUnit', 'Opponent unit']] as const).map(([key, label]) => <label key={key}>{label}<GameSelect aria-label={label} value={plan[key]} onChange={e => patch({ [key]: e.target.value })} className="block w-full bg-black p-2">{units.map(u => <option key={u.name} value={u.name}>{u.label}</option>)}</GameSelect></label>)}
      {([['count', 'Your force'], ['enemyCount', 'Opponent force'], ['duration', 'Duration seconds'], ['seed', 'Seed']] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={label} type="number" min={key === "duration" ? 30 : key === "seed" ? 0 : 1} max={key === "duration" ? 600 : key === "seed" ? 2147483647 : 24} value={plan[key]} onChange={e => patch({ [key]: Number(e.target.value) })} className="block w-full bg-black p-2" /></label>)}
      <label>Objective<GameSelect aria-label="Practice objective" className="block w-full bg-black p-2" value={plan.objective} onChange={e => patch({ objective: e.target.value as PracticePlan['objective'] })}><option value="survive">Keep one combat unit alive</option><option value="eliminate">Eliminate opposing combat units</option></GameSelect></label>
      <label>Opponent orders<GameSelect aria-label="Opponent orders" className="block w-full bg-black p-2" value={plan.enemyOrder} onChange={e => patch({ enemyOrder: e.target.value as PracticePlan['enemyOrder'] })}><option value="engage">Engage</option><option value="hold">Hold position</option></GameSelect></label>
      <p className="col-span-2 text-[var(--muted-foreground)]">{plan.count} vs {plan.enemyCount} · {plan.duration}s · seed {plan.seed}. You control your force. Victory is measured in native simulation time.</p>
      <button disabled={busy} onClick={preview} className="bg-white/10 p-2">{busy ? "Checking…" : "Preview & validate routes"}</button>
      <button disabled={busy || validated !== JSON.stringify(plan)} onClick={async () => { setBusy(true); try { game.start(JSON.stringify(practiceScenario(plan, true))); await wait(); frame(); close(); } catch (e) { setErrors([String(e)]); setBusy(false); } }} className="bg-[var(--hud-gold)] p-2 font-bold text-black disabled:opacity-30">Launch practice</button>
    </div>}
    {validated && <p className="my-3 text-[var(--hud-green)]">✓ Both forces and ground routes validated by OpenRA.</p>}
    {errors.map((e, i) => <p key={i} role="alert" className="my-2 text-[var(--hud-red)]">{e}</p>)}
  </section>;
}
