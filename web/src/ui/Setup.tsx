import { GameSelect } from "../components/ui/fields";
// Skirmish setup: pick a nation (flags), a map (its preview is the backdrop), opponents (nation, AI type,
// colour) and the lobby options the mod offers, then start. The chosen map is prepared in the background while
// the player decides, so starting only builds the world.

import { useEffect, useMemo, useState } from "react";
import type { Game } from "../game";
import { useStore } from "../store";
import { Button } from "../components/ui/button";
import { OptionSelect, SearchSelect, type Option } from "../components/ui/fields";
import { cn } from "../lib/utils";
import { Flag, factionIdentity } from "./Flag";

// The options most players change; the rest stay one click away.
const KEY_OPTIONS = ["startingcash", "startingunits", "fog", "explored", "crates", "techlevel"];

const COLORS = ["2A6FDB", "D83A2E", "3FAE49", "E7B42F", "E8702A", "25A6A6", "8E4FD1", "E05A9C"];

interface Opponent { faction: string; bot: string; color: string; doctrine?: string }

function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}

export function Setup({ game }: { game: Game }) {
  const setup = useStore((s) => s.setup)!;
  const previews = useStore((s) => s.previews);
  const prepared = useStore((s) => s.preparedMap);
  const privateContent = useStore((s) => s.privateContent);
  const profile = useStore((s) => s.profile);
  const publicShot = useStore((s) => s.publicShot);
  const cc = useStore((s) => s.cc);
  const ccAvailable = useStore((s) => s.ccAvailable);

  const factions = setup.factions.filter((f) => !f.random);
  const modern = new Set(["saudi", "iran", "china", "turkey", "israel", "yemen", "hezbollah"]);
  const [faction, setFaction] = useState<string>(() => load("rtsai.faction", "saudi"));
  const [mapId, setMapId] = useState<string>(() => new URLSearchParams(location.search).get("map") ?? load("rtsai.map", setup.maps.find((m) => m.id === "tournament-2A" || m.id === "twin-fords")?.id ?? setup.maps[0]?.id));
  const map = setup.maps.find((m) => m.id === mapId) ?? setup.maps[0];
  const [color, setColor] = useState<string>(() => load("rtsai.color", COLORS[0]));
  const [moreOptions, setMoreOptions] = useState(false);
  const [opponents, setOpponents] = useState<Opponent[]>(() => load("rtsai.opponents", [{ faction: "iran", bot: setup.bots[0]?.type ?? "normal", color: COLORS[1] }]));
  const [options, setOptions] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries((setup.options ?? []).map((o) => [o.id, o.default])),
    ...load<Record<string, string>>("rtsai.options", {}),
  }));

  useEffect(() => {
    try {
      localStorage.setItem("rtsai.faction", JSON.stringify(faction));
      localStorage.setItem("rtsai.map", JSON.stringify(mapId));
      localStorage.setItem("rtsai.color", JSON.stringify(color));
      localStorage.setItem("rtsai.opponents", JSON.stringify(opponents));
      localStorage.setItem("rtsai.options", JSON.stringify(options));
    } catch { /* private mode */ }
  }, [faction, mapId, color, opponents, options]);

  // Previews for the backdrop and the picker; prepare the chosen map once the choice settles.
  useEffect(() => { if (map) game.preview(map.id); }, [game, map]);
  // The sides chosen so far: their sprite sheets load while the player is still on this screen.
  useEffect(() => {
    const chosen = [faction, ...opponents.map((o) => o.faction)];
    game.wantFactions(chosen.some((f) => setup.factions.find((x) => x.id === f)?.random) ? null : chosen, faction);
  }, [game, faction, opponents, setup.factions]);
  useEffect(() => {
    if (!map) return;
    const t = setTimeout(() => game.prepare(map.id), 350);
    return () => clearTimeout(t);
  }, [game, map]);

  const maxOpponents = (map?.players ?? 2) - 1;
  useEffect(() => { if (opponents.length > maxOpponents) setOpponents(opponents.slice(0, maxOpponents)); }, [maxOpponents, opponents]);

  const factionOptions: Option[] = useMemo(() => factions.map((f) => ({
    value: f.id, label: f.name, group: modern.has(f.id) ? "Modern" : f.side,
    leading: <Flag id={f.id} className="h-[12px] w-[18px] rounded-[1px]" />,
  })), [factions]); // eslint-disable-line react-hooks/exhaustive-deps
  const botOptions: Option[] = setup.bots.map((b) => ({ value: b.type, label: b.name }));
  const mapOptions: Option[] = setup.maps.map((m) => ({ value: m.id, label: m.title, description: `${m.players} players`, group: `${m.players} players` }));

  const start = () => {
    if (!map) return;
    const slots = map.slots;
    const players = [
      { slot: slots[0], faction, color },
      ...opponents.map((o, i) => ({ slot: slots[i + 1], faction: o.faction, bot: o.bot, color: o.color, doctrine: o.doctrine ?? "standard" })),
    ];
    const scenario = { map: map.id, seed: Math.floor(Math.random() * 1e9), players, options };
    game.start(JSON.stringify(scenario));
  };

  const backdrop = map && !publicShot ? previews[map.id] : "";
  const sheets = useStore((s) => s.sheets);
  const ready = prepared === map?.id && sheets.uploaded >= sheets.total;
  const factionInfo = factions.find((f) => f.id === faction);
  const identity = factionIdentity(faction);

  return (
    <div className="absolute inset-0 overflow-hidden bg-[#070907]">
      {backdrop && <img src={backdrop} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-45 blur-[14px]" />}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_20%,transparent,rgba(5,7,5,0.85)_70%)]" />

      <div className="relative mx-auto grid h-full max-w-[1240px] grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-6 overflow-y-auto p-8 max-[900px]:grid-cols-1">
        {/* Nation */}
        <section className="flex min-w-0 flex-col gap-4">
          <header className="flex items-baseline gap-3">
            <h1 className="m-0 text-[28px] font-black tracking-wide text-[var(--hud-gold)]">RTS AI</h1>
            <span className="text-[13px] text-[var(--muted-foreground)]">Skirmish</span>
          </header>
          <div className="hud-panel flex flex-col gap-3 p-4">
            <div className="flex items-center gap-4">
              <Flag id={faction} className="h-[64px] w-[104px] rounded-[2px] shadow-[0_0_0_1px_#000,0_0_0_2px_var(--hud-gold-dim)]" />
              <div className="min-w-0">
                <div className="text-[20px] font-bold">{factionInfo?.name ?? faction}</div>
                {identity && (
                  <div className="text-[13px] text-[var(--muted-foreground)]">
                    <span className="font-semibold" style={{ color: identity.accent }}>{identity.title}</span> · {identity.tagline}
                  </div>
                )}
              </div>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-2">
              {[...factions].sort((a, b) => Number(modern.has(b.id)) - Number(modern.has(a.id))).map((f) => (
                <button key={f.id} type="button" onClick={() => setFaction(f.id)} title={f.name}
                  className={cn("group flex flex-col items-center gap-1 rounded-[3px] p-1.5 transition-colors hover:bg-white/5",
                    faction === f.id && "bg-[rgba(241,210,139,0.08)] shadow-[inset_0_0_0_1px_var(--hud-gold-dim)]")}>
                  <Flag id={f.id} className={cn("h-[34px] w-[56px] rounded-[1px] shadow-[0_0_0_1px_#000] transition", faction !== f.id && "opacity-75 saturate-[0.8] group-hover:opacity-100")} />
                  <span className={cn("max-w-full truncate text-[11px]", faction === f.id ? "text-[var(--hud-gold)]" : "text-[var(--muted-foreground)]")}>{f.name}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              {COLORS.map((c) => (
                <button key={c} type="button" aria-label={`Colour ${c}`} onClick={() => setColor(c)}
                  className={cn("size-[22px] rounded-[3px] ring-1 ring-black/60 transition", color === c ? "scale-110 shadow-[0_0_0_2px_var(--hud-gold)]" : "opacity-80 hover:opacity-100")}
                  style={{ background: `#${c}` }} />
              ))}
            </div>
          </div>

          {(setup.options?.length ?? 0) > 0 && (
            <div className="hud-panel grid grid-cols-2 gap-x-4 gap-y-2 p-4">
              {setup.options!.filter((o) => moreOptions || KEY_OPTIONS.includes(o.id)).map((o) => (
                <label key={o.id} className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-[var(--muted-foreground)]">
                  {o.name}
                  <OptionSelect size="sm" value={options[o.id] ?? o.default} onValueChange={(v) => setOptions({ ...options, [o.id]: v })}
                    options={o.values.map((v) => ({ value: v.value, label: v.label }))} />
                </label>
              ))}
              <button type="button" onClick={() => setMoreOptions(!moreOptions)}
                className="col-span-2 justify-self-start text-[11px] text-[var(--muted-foreground)] underline-offset-2 hover:text-[var(--foreground)] hover:underline">
                {moreOptions ? "Fewer options" : `More options (${setup.options!.length - KEY_OPTIONS.length})`}
              </button>
            </div>
          )}
        </section>

        {/* Battlefield and opponents */}
        <section className="flex min-w-0 flex-col gap-4 pt-[52px] max-[900px]:pt-0">
          <div className="hud-panel flex flex-col gap-3 p-4">
            <div className="hud-inset relative aspect-[16/10] w-full overflow-hidden">
              {backdrop ? <img src={backdrop} alt={map?.title} className="h-full w-full object-contain" />
                : publicShot ? <div className="grid h-full place-items-center bg-[repeating-linear-gradient(45deg,#0c0f0c_0_10px,#101410_10px_20px)] text-[12px] text-[var(--muted-foreground)]">{map?.title}</div>
                : <div className="grid h-full place-items-center"><div className="spinner" /></div>}
              <div className="absolute bottom-2 left-2 flex items-center gap-2 rounded-[3px] bg-black/70 px-2 py-1 text-[11px]">
                {ready ? <span className="size-[7px] rounded-full bg-[var(--hud-green)]" /> : <div className="spinner !size-[10px] !border" />}
                <span className="text-[var(--muted-foreground)]">
                  {prepared === map?.id && sheets.uploaded < sheets.total
                    ? `Loading art ${Math.round((100 * sheets.uploaded) / sheets.total)}%`
                    : `${map?.players} players · ${map?.tileset.toLowerCase()}`}
                </span>
              </div>
            </div>
            <SearchSelect value={mapId} onValueChange={setMapId} options={mapOptions} aria-label="Map" placeholder="Find a map…" />
          </div>

          <div className="hud-panel flex flex-col gap-2 p-4">
            {opponents.map((o, i) => (
              <div key={i} className="grid grid-cols-[22px_minmax(0,1.3fr)_minmax(0,1fr)_auto] items-center gap-2">
                <button type="button" aria-label="Colour" className="size-[20px] rounded-[3px] ring-1 ring-black/60" style={{ background: `#${o.color}` }}
                  onClick={() => setOpponents(opponents.map((x, j) => j === i ? { ...x, color: COLORS[(COLORS.indexOf(x.color) + 1) % COLORS.length] } : x))} />
                <SearchSelect size="sm" value={o.faction} onValueChange={(v) => setOpponents(opponents.map((x, j) => j === i ? { ...x, faction: v } : x))} options={factionOptions} aria-label="Opponent nation" />
                <OptionSelect size="sm" value={o.bot} onValueChange={(v) => setOpponents(opponents.map((x, j) => j === i ? { ...x, bot: v } : x))} options={botOptions} aria-label="AI" />
                <Button size="icon-sm" variant="ghost" aria-label="Remove opponent" disabled={opponents.length <= 1}
                  onClick={() => setOpponents(opponents.filter((_, j) => j !== i))}>
                  <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4L12 13.4 6.4 19 5 17.6 10.6 12 5 6.4Z" /></svg>
                </Button>
                <label className="col-span-4 flex items-center gap-2 text-[11px] text-[var(--muted-foreground)]">Tactical personality
                  <GameSelect aria-label={`Opponent ${i + 1} personality`} className="bg-black p-1 text-[var(--hud-gold)]" value={o.doctrine ?? "standard"} onChange={(e) => setOpponents(opponents.map((x, j) => j === i ? { ...x, doctrine: e.target.value } : x))}>
                    <option value="standard">Standard native AI</option><option value="raider">Raider · pressure observed contacts</option><option value="sentinel">Sentinel · intercept near home</option><option value="adaptive">Adaptive · regroup when outnumbered</option>
                  </GameSelect>
                </label>
              </div>
            ))}
            {opponents.length < maxOpponents && (
              <Button variant="ghost" size="sm" className="self-start text-[var(--muted-foreground)]"
                onClick={() => setOpponents([...opponents, { faction: factions[(opponents.length * 3 + 5) % factions.length].id, bot: setup.bots[0].type, color: COLORS[(opponents.length + 1) % COLORS.length] }])}>
                + Opponent
              </Button>
            )}
          </div>

          <p className="text-[11px] text-[var(--muted-foreground)]">Personalities direct up to eight idle combat units every five seconds using visible contacts. Difficulty and production follow the AI setting above; no bonus resources.</p>

          <div className="mt-auto flex items-center justify-end gap-3">
            {!privateContent && !profile && <span className="text-[11px] text-[var(--muted-foreground)]">Original game files not mounted</span>}
            {ccAvailable && <CoCommanderToggle game={game} enabled={cc.enabled} mode={cc.mode} error={cc.error} />}
            <Button size="lg" onClick={start} disabled={!map}
              className="h-[46px] min-w-[180px] rounded-[3px] bg-[linear-gradient(180deg,#f6dc9c,#c9a253)] text-[16px] font-bold uppercase tracking-[0.18em] text-[#1a160c] shadow-[0_0_0_1px_#000,0_6px_20px_rgba(241,210,139,0.25)] hover:brightness-110">
              Start
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

/** The AI co-commander for this match: on/off, and which brain (the local AI stack, or a scripted stand-in). */
function CoCommanderToggle({ game, enabled, mode, error }: { game: Game; enabled: boolean; mode: "mock" | "local" | "browser"; error: string }) {
  const localAvailable = useStore(s => s.ccLocalAvailable);
  return (
    <div className="hud-panel flex h-[46px] items-center gap-2 rounded-[3px] px-3" title={error || "An AI co-commander that advises, answers and proposes orders"}>
      <button type="button" role="switch" aria-checked={enabled} aria-label="AI co-commander" onClick={() => game.cc.setEnabled(!enabled)}
        className="flex items-center gap-2">
        <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke={enabled ? "var(--hud-gold)" : "var(--muted-foreground)"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3a4 4 0 0 0-4 4v1a4 4 0 0 0-2 7.5V17a4 4 0 0 0 6 3.5A4 4 0 0 0 18 17v-1.5A4 4 0 0 0 16 8V7a4 4 0 0 0-4-4Z" /><path d="M12 7v13M8 12h2M14 12h2" />
        </svg>
        <span className={cn("relative h-[18px] w-[32px] rounded-full transition-colors", enabled ? "bg-[var(--hud-gold)]" : "bg-[#262c25]")}>
          <span className={cn("absolute top-[2px] size-[14px] rounded-full bg-[#0e110e] transition-[left]", enabled ? "left-[16px]" : "left-[2px]")} />
        </span>
        <span className="text-[13px] text-[var(--foreground)]">Co-commander</span>
      </button>
      {enabled && localAvailable && (
        <span className="ml-1 flex overflow-hidden rounded-[2px] border border-white/10 text-[11px]">
          {(["browser", "local", "mock"] as const).map((m) => (
            <button key={m} type="button" onClick={() => game.cc.setMode(m)}
              className={cn("px-2 py-[3px]", mode === m ? "bg-[var(--hud-gold)] font-semibold text-[#1a160c]" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]")}>
              {m === "browser" ? "Strategy adviser" : m === "local" ? "Local AI" : "Scripted"}
            </button>
          ))}
        </span>
      )}
      {enabled && !localAvailable && <span className="text-[11px] text-[var(--hud-gold-dim)]">Strategy adviser</span>}
      {error && <span className="size-[7px] rounded-full bg-[var(--hud-red)]" aria-label={error} />}
    </div>
  );
}
