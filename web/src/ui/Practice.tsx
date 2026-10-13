import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Pause, Play, Sparkles, X } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { GameSelect, SearchSelect, type Option } from "../components/ui/fields";
import { Flag } from "./Flag";
import { GameButton } from "./kit/game";
import {
  factionUnits, interpret, loadPracticeCatalog, MAX_FORCE, nativeIssues, pickUnit, practiceScenario, probeRoster, unitClass, validatePlan, waitForArt, waitForWorld,
  type PlanField, type PlanIssue, type PracticePlan, type Rosters, type UnitOption,
} from "../ai-lab";

/** The battle's player colours (practiceScenario): you blue, the opponent red. */
const SIDE_COLOR = ["#2A6FDB", "#D83A2E"] as const;
const DEFAULT_REQUEST = "Defend with 6 tanks against 8 units for 2 minutes";
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Units the player did not pick follow their side's faction: a sensible combat unit of the same kind from its roster. */
function followFaction(p: PracticePlan, units: UnitOption[], rosters: Rosters, pinned: { unit: boolean; enemyUnit: boolean }): PracticePlan {
  let q = p;
  for (const [unit, faction] of [["unit", "faction"], ["enemyUnit", "enemy"]] as const) {
    if (pinned[unit] || factionUnits(p[faction], units, rosters).some(u => u.name === p[unit])) continue;
    q = { ...q, [unit]: pickUnit(unitClass(units.find(u => u.name === p[unit])), p[faction], units, rosters) };
  }
  return q;
}

/**
 * Scenario workshop: describe a battle, adjust both sides, start it. Every change rebuilds the battle paused on the
 * map behind the panel and has the engine check it; "Start battle" unpauses that same world and hands you command.
 */
export function Practice({ game, close }: { game: Game; close: () => void }) {
  const setup = useStore(s => s.setup);
  const icons = useStore(s => s.icons);
  const factions = useMemo(() => setup?.factions.filter(f => !f.random) ?? [], [setup]);
  const factionIds = useMemo(() => factions.map(f => f.id), [factions]);
  const factionNames = useMemo(() => Object.fromEntries(factions.map(f => [f.id, f.name])), [factions]);
  const [request, setRequest] = useState(() => new URLSearchParams(location.search).get("prompt") ?? DEFAULT_REQUEST);
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [rosters, setRosters] = useState<Rosters>({});
  const [plan, setPlan] = useState<PracticePlan | null>(null);
  const [pinned, setPinned] = useState({ unit: false, enemyUnit: false });
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(""); // the plan (JSON) whose paused battle is on the map and passed the engine's check
  const [engineIssues, setEngineIssues] = useState<PlanIssue[]>([]);
  const [failure, setFailure] = useState("");
  const [tags, setTags] = useState<{ side: 0 | 1; x: number; y: number }[]>([]);
  const [area, setArea] = useState<{ left: number; right: number; top: number } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const alive = useRef(true);
  const live = useRef({ units, rosters, pinned });
  live.current = { units, rosters, pinned };
  const wanted = useRef(""); // the plan (JSON) the map should show next
  const pumping = useRef(false);

  /** Camera on both forces, centred in the map area the panel leaves free; name tags above each force. */
  const frame = (p: PracticePlan, besidePanel: boolean) => {
    const info = game.info;
    const rect = game.canvas.getBoundingClientRect();
    if (!info || !rect.width) return;
    const [ox, oy] = info.cellOrigin, [tw, th] = info.tileSize, us = live.current.units;
    const boxes = practiceScenario(p, us).placements.map(a => {
      const [w, h] = us.find(u => u.name === a.id)?.size ?? [72, 60];
      const x = ox + (2 * a.u + (a.v & 1)) * tw / 2, y = oy + a.v * th / 2;
      return { side: a.side, x0: x - w / 2, x1: x + w / 2, y0: y - h, y1: y + h / 2 };
    });
    if (!boxes.length) return;
    const span = (list: typeof boxes) => ({ x0: Math.min(...list.map(b => b.x0)), x1: Math.max(...list.map(b => b.x1)), y0: Math.min(...list.map(b => b.y0)), y1: Math.max(...list.map(b => b.y1)) });
    const all = span(boxes);
    const edge = besidePanel && panel.current ? Math.min(rect.right, panel.current.getBoundingClientRect().left) : rect.right;
    const free = { left: rect.left + 24, right: Math.max(rect.left + 160, edge - 24), top: rect.top + 72, bottom: rect.bottom - 32 };
    // The camera works in CSS pixels: zoom is CSS px per world px.
    const zoom = Math.max(0.35, Math.min(1.5, (free.right - free.left) / (all.x1 - all.x0), (free.bottom - free.top) / (all.y1 - all.y0)));
    game.cam.zoom = zoom;
    game.lookAt((all.x0 + all.x1) / 2 - ((free.left + free.right) / 2 - (rect.left + rect.width / 2)) / zoom,
      (all.y0 + all.y1) / 2 - ((free.top + free.bottom) / 2 - (rect.top + rect.height / 2)) / zoom);
    const css = (wx: number, wy: number) => ({ x: rect.left + rect.width / 2 + (wx - game.cam.x) * game.cam.zoom, y: rect.top + rect.height / 2 + (wy - game.cam.y) * game.cam.zoom });
    setArea({ left: free.left, right: free.right, top: rect.top });
    setTags(([0, 1] as const).map(side => { const b = span(boxes.filter(x => x.side === side)); return { side, ...css((b.x0 + b.x1) / 2, b.y0) }; }));
  };

  /** Builds the wanted plan's battle (paused) and has the engine check it; repeats while the plan keeps changing. */
  const pump = async () => {
    if (pumping.current) return;
    pumping.current = true;
    setBusy(true);
    const isAlive = () => alive.current;
    try {
      while (alive.current && wanted.current) {
        const key = wanted.current, p: PracticePlan = JSON.parse(key);
        for (const f of [p.faction, p.enemy]) if (!(f in live.current.rosters)) {
          const roster = await probeRoster(game, f, f === p.faction ? p.enemy : p.faction, isAlive);
          live.current.rosters = { ...live.current.rosters, [f]: roster };
          setRosters(live.current.rosters);
        }
        const fixed = followFaction(p, live.current.units, live.current.rosters, live.current.pinned);
        if (JSON.stringify(fixed) !== key) { wanted.current = JSON.stringify(fixed); setPlan(fixed); continue; }
        setReady(""); setEngineIssues([]); setTags([]);
        game.start(JSON.stringify(practiceScenario(p, live.current.units)), true);
        await waitForWorld(isAlive);
        // What you can see is first worked out on a tick: one tick (40 ms of game time) shows the opponent too.
        game.client.send({ type: "step" });
        const check = await game.command<{ valid?: boolean; errors?: string[]; routes?: string }>({ cmd: "validate-practice" });
        await waitForArt();
        if (wanted.current !== key) continue;
        wanted.current = "";
        const problems = check.valid ? [] : nativeIssues(check.errors?.length ? check.errors : ["The engine rejected this battle."], p, live.current.units, check.routes === "terrain");
        if (!problems.length) { setReady(key); frame(p, true); }
        else setEngineIssues(problems);
      }
    } catch (e) {
      if (alive.current) setFailure(message(e));
    } finally {
      pumping.current = false;
      if (alive.current) setBusy(false);
    }
  };

  // The engine's unit catalog (combat units only, with their sizes) and both factions' rosters, then the request.
  useEffect(() => {
    alive.current = true;
    const first = interpret(request, [], factionIds, undefined, {}, factionNames).plan;
    loadPracticeCatalog(game, first.faction, [first.enemy], () => alive.current).then(c => {
      if (!alive.current) return;
      game.requestIcons(c.units.map(u => u.name));
      const r = interpret(request, c.units, factionIds, undefined, c.rosters, factionNames);
      setUnits(c.units); setRosters(c.rosters); setPinned(r.named); setPlan(r.plan);
    }).catch(e => { if (alive.current) { setFailure(message(e)); setBusy(false); } });
    return () => { alive.current = false; };
  }, [game]);

  // Every valid change previews automatically (after a short pause in typing).
  useEffect(() => {
    if (!plan || !units.length) return;
    const key = JSON.stringify(plan);
    if (validatePlan(plan, units, factionIds).length || key === ready) {
      wanted.current = "";
      if (!pumping.current) setBusy(false);
      return;
    }
    wanted.current = key;
    const timer = setTimeout(pump, !ready && busy ? 0 : 450);
    return () => clearTimeout(timer);
  }, [plan, units, ready]);

  useEffect(() => {
    if (!ready) return;
    const refit = () => frame(JSON.parse(ready), true);
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  }, [ready]);

  // The paused preview takes no game hotkeys (P would unpause it, arrows would scroll it). Pickers still get their keys.
  useEffect(() => {
    const stop = (e: KeyboardEvent) => e.stopPropagation();
    document.addEventListener("keydown", stop);
    return () => document.removeEventListener("keydown", stop);
  }, []);

  const patch = (p: Partial<PracticePlan>) => setPlan(old => old ? followFaction({ ...old, ...p }, live.current.units, live.current.rosters, live.current.pinned) : old);
  const reinterpret = () => {
    if (!units.length) return;
    const r = interpret(request, units, factionIds, plan ?? undefined, rosters, factionNames);
    live.current.pinned = r.named;
    setPinned(r.named); setPlan(r.plan);
  };
  const start = () => {
    if (!canStart || !plan) return;
    frame(plan, false);
    game.setPaused(false);
    close();
  };

  const issues = plan && units.length ? [...validatePlan(plan, units, factionIds), ...engineIssues] : [];
  const issue = (field: PlanField) => issues.find(i => i.field === field)?.message;
  const canStart = !!plan && !busy && ready === JSON.stringify(plan) && issues.length === 0;
  const stale = !!plan && ready !== JSON.stringify(plan);
  const nations: Option[] = factions.map(f => ({ value: f.id, label: f.name, leading: <Flag id={f.id} className="h-[12px] w-[18px] rounded-[1px]" /> }));
  const cameo = (name: string, className: string) => icons[name] ? <img src={icons[name]!} alt="" className={className} style={{ imageRendering: "pixelated" }} /> : null;
  const unitOptions = (faction: string): Option[] => {
    const roster = rosters[faction], own = roster?.length ? factionUnits(faction, units, rosters) : [];
    const ownNames = new Set(own.map(u => u.name));
    const rest = units.filter(u => u.combat !== false && !ownNames.has(u.name))
      .sort((a, b) => (Number(b.modern) - Number(a.modern)) * (roster && !roster.length ? -1 : 1) || a.label.localeCompare(b.label));
    const option = (u: UnitOption, group?: string): Option => ({ value: u.name, label: u.label, group, leading: cameo(u.name, "h-[16px] w-[20px] shrink-0 object-contain") });
    return own.length ? [...own.map(u => option(u, factionNames[faction] ?? faction)), ...rest.map(u => option(u, "Other units"))] : rest.map(u => option(u));
  };
  const FieldIssue = ({ field }: { field: PlanField }) => issue(field) ? <p id={`practice-${field}-issue`} role="alert" className="pw-issue">{issue(field)}</p> : null;
  const sides = [
    { side: 0, title: "You", faction: "faction", unit: "unit", count: "count", labels: ["Your faction", "Your unit", "Your force"] },
    { side: 1, title: "Opponent", faction: "enemy", unit: "enemyUnit", count: "enemyCount", labels: ["Opponent faction", "Opponent unit", "Opponent force"] },
  ] as const;
  const inputClass = "pw-input";

  return <>
    {/* The map behind the panel: a paused preview you look at, not a game you play (yet). */}
    <div data-practice-map className="fixed inset-0 z-40" onMouseDown={e => e.preventDefault()} onContextMenu={e => e.preventDefault()}>
      {busy || !plan ? <div className="pw-wait" style={{ paddingRight: (panel.current?.offsetWidth ?? 420) + 32 }}>
        <div className="pw-wait-card"><span className="scr-radar" aria-hidden="true"><i /><i /><i /></span><span>{units.length ? "Setting up the battle" : "Reading the arsenal"}</span></div>
      </div> : <>
        {stale && <div className="absolute inset-0 bg-black/55" />}
        {area && !stale && <span className="pw-paused absolute -translate-x-1/2" style={{ left: (area.left + area.right) / 2, top: area.top + 16 }}><Pause size={11} aria-hidden="true" />Paused preview</span>}
        {!stale && tags.map(t => <span key={t.side} data-side-tag={t.side} className="pw-tag absolute -translate-x-1/2 -translate-y-full" style={{ left: t.x, top: t.y - 8, "--side": SIDE_COLOR[t.side] } as CSSProperties}>{t.side ? "Opponent" : "You"}</span>)}
      </>}
    </div>
    <section ref={panel} data-practice data-ui-sfx className="pw-panel" onKeyDown={e => e.stopPropagation()}>
      <header className="pw-head">
        <div className="min-w-0"><span className="menu-eyebrow">Practice battle</span><h2>Scenario workshop</h2></div>
        <button type="button" className="gd-close" aria-label="Close workshop" onClick={() => { game.quit(); close(); }}><X size={18} /></button>
      </header>
      <form className="pw-request" onSubmit={e => { e.preventDefault(); reinterpret(); }}>
        <textarea aria-label="Scenario request" placeholder={DEFAULT_REQUEST} value={request} rows={2} onChange={e => setRequest(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); reinterpret(); } }} />
        <GameButton type="submit" size="sm" icon={<Sparkles size={14} />} disabled={!units.length}>Interpret request</GameButton>
      </form>
      {plan && <>
        <div className="pw-sides">
          {sides.map(s => {
            const unit = units.find(u => u.name === plan[s.unit]);
            return <section key={s.side} aria-label={s.title} className="pw-side" style={{ "--side": SIDE_COLOR[s.side] } as CSSProperties}>
              <b className="pw-side-title">{s.title}</b>
              <SearchSelect size="sm" aria-label={s.labels[0]} value={plan[s.faction]} options={nations} onValueChange={v => patch({ [s.faction]: v })} />
              <FieldIssue field={s.faction} />
              <div className="pw-cameo">{cameo(plan[s.unit], "h-full w-full object-contain") ?? <span>{unit?.label}</span>}</div>
              <SearchSelect size="sm" aria-label={s.labels[1]} value={plan[s.unit]} options={unitOptions(plan[s.faction])} placeholder="Find a unit…"
                onValueChange={v => { live.current.pinned = { ...live.current.pinned, [s.unit]: true }; setPinned(live.current.pinned); patch({ [s.unit]: v }); }} />
              <FieldIssue field={s.unit} />
              <label className="pw-count"><span aria-hidden="true">×</span>
                <input aria-label={s.labels[2]} type="number" min={1} max={MAX_FORCE} value={Number.isFinite(plan[s.count]) ? plan[s.count] : ""} aria-invalid={!!issue(s.count)} aria-describedby={issue(s.count) ? `practice-${s.count}-issue` : undefined}
                  onChange={e => patch({ [s.count]: e.target.value === "" ? NaN : Number(e.target.value) })} className={inputClass} /></label>
              <FieldIssue field={s.count} />
            </section>;
          })}
        </div>
        <div className="pw-rules">
          <label className="pw-field"><span>Goal</span><GameSelect aria-label="Practice objective" className="w-full" value={plan.objective} onChange={e => patch({ objective: e.target.value as PracticePlan["objective"] })}><option value="survive">Survive</option><option value="eliminate">Eliminate them</option></GameSelect></label>
          <label className="pw-field"><span>Orders</span><GameSelect aria-label="Opponent orders" className="w-full" value={plan.enemyOrder} onChange={e => patch({ enemyOrder: e.target.value as PracticePlan["enemyOrder"] })}><option value="engage">Engage</option><option value="hold">Hold position</option></GameSelect></label>
          <label className="pw-field"><span>Seconds</span><input aria-label="Duration seconds" type="number" min={30} max={600} value={Number.isFinite(plan.duration) ? plan.duration : ""} aria-invalid={!!issue("duration")} onChange={e => patch({ duration: e.target.value === "" ? NaN : Number(e.target.value) })} className={inputClass} /><FieldIssue field="duration" /></label>
          <label className="pw-field"><span>Seed</span><input aria-label="Seed" type="number" min={0} max={2147483647} value={Number.isFinite(plan.seed) ? plan.seed : ""} aria-invalid={!!issue("seed")} onChange={e => patch({ seed: e.target.value === "" ? NaN : Number(e.target.value) })} className={inputClass} /><FieldIssue field="seed" /></label>
        </div>
        <GameButton variant="primary" size="lg" className="pw-start" icon={<Play size={16} aria-hidden="true" />} disabled={!canStart} onClick={start}>Start battle</GameButton>
      </>}
      {[...issues.filter(i => !i.field).map(i => i.message), ...(failure ? [failure] : [])].map((m, i) => <p key={i} role="alert" className="pw-alert">{m}</p>)}
    </section>
  </>;
}
