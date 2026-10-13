// Skirmish setup: pick a nation (flags, the nation's look and units), a map (its preview is the hero of the right
// column), opponents (nation, AI type, personality, colour) and the lobby options the mod offers, then start. The
// chosen map is prepared in the background while the player decides, so starting only builds the world.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Bot, Brain, Check, ChevronDown, Dices, Map as MapIcon, Plus, SlidersHorizontal, Swords, Users, X } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { GameSelect, OptionSelect, SearchSelect, type Option } from "../components/ui/fields";
import { EA_NOTICE } from "../legal";
import { Flag, factionIdentity } from "./Flag";
import { GameButton } from "./kit/game";
import { Brackets, ScreenBackdrop, Toggle } from "./screen-parts";

// The options most players change; the rest stay one click away.
const KEY_OPTIONS = ["startingcash", "startingunits", "fog", "explored", "crates", "techlevel"];

const COLORS = ["2A6FDB", "D83A2E", "3FAE49", "E7B42F", "E8702A", "25A6A6", "8E4FD1", "E05A9C"];

const MODERN = new Set(["saudi", "iran", "china", "turkey", "israel", "yemen", "hezbollah"]);
/** What the classic sides are called in the game's own random picks ("Random Coalition Country"). */
const SIDE_NAME: Record<string, string> = { Allies: "Coalition", Soviets: "Union" };
/** A few of each modern nation's own units (their roster files, modern-factions/<nation>*.yaml), as their portraits. */
const SIGNATURE: Record<string, string[]> = {
  saudi: ["r2m1a2s", "r2ah64sa", "r2f15sa", "r2sang"],
  iran: ["r2karrar", "r2fajr", "r2toufan", "r2basij"],
  turkey: ["r2yildirim", "r2aras", "r2turna", "r2trrifle"],
  china: ["r2qilin", "r2zbd", "r2crane", "r2cnrifle"],
  israel: ["r2merkava", "r2namer", "r2ilgunship", "r2ilrifle"],
  yemen: ["r2ymlr", "r2technical", "r2samad", "r2yrpg"],
  hezbollah: ["r2hzrockets", "r2hztechnical", "r2hzdrone", "r2hzrifle"],
};
const PERSONALITY_HINT = "Personalities direct up to eight idle combat units every five seconds using visible contacts. Difficulty and production follow the AI setting; no bonus resources.";

interface Opponent { faction: string; bot: string; color: string; doctrine?: string }
type SetupFaction = { id: string; name: string; side: string; description: string; random: boolean };

function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}

const isSwitch = (o: { values: { value: string }[] }) => o.values.length === 2 && o.values.every((v) => v.value === "True" || v.value === "False");
const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

export function Setup({ game }: { game: Game }) {
  const setup = useStore((s) => s.setup)!;
  const previews = useStore((s) => s.previews);
  const prepared = useStore((s) => s.preparedMap);
  const privateContent = useStore((s) => s.privateContent);
  const profile = useStore((s) => s.profile);
  const publicShot = useStore((s) => s.publicShot);
  const cc = useStore((s) => s.cc);
  const ccAvailable = useStore((s) => s.ccAvailable);
  const sheets = useStore((s) => s.sheets);

  const factions = setup.factions.filter((f) => !f.random);
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

  // Previews for the map picker; prepare the chosen map once the choice settles.
  useEffect(() => { if (map) game.preview(map.id); }, [game, map]);
  useEffect(() => { for (const m of setup.maps.slice(0, 12)) game.preview(m.id); }, [game, setup.maps]);
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
    value: f.id, label: f.name, group: MODERN.has(f.id) ? "Modern" : SIDE_NAME[f.side] ?? f.side,
    leading: <Flag id={f.id} className="h-[12px] w-[18px] rounded-[1px]" />,
  })), [factions]); // eslint-disable-line react-hooks/exhaustive-deps
  const botOptions: Option[] = setup.bots.map((b) => ({ value: b.type, label: b.name }));
  // Maps made here by the generator first (newest first), then saved Earth maps (net/saved-maps.ts), as the player's own.
  const orderedMaps = [...setup.maps.filter((m) => m.generated), ...setup.maps.filter((m) => m.saved), ...setup.maps.filter((m) => !m.saved && !m.generated)];
  const mapOptions: Option[] = orderedMaps.map((m) => ({ value: m.id, label: m.title,
    description: m.saved ? [m.place, `${m.players} players`].filter(Boolean).join(" · ") : `${m.players} players`,
    group: m.generated ? "Random maps" : m.saved ? "Your maps" : `${m.players} players` }));
  const mapError = useStore((s) => (map ? s.mapErrors[map.id] : undefined));
  // A new random map from the engine's own map generator, made in this browser (game.generateMap): a landscape picked
  // at random, sized for everyone in the match.
  const [making, setMaking] = useState(false);
  const [makeError, setMakeError] = useState("");
  const makeMap = () => {
    if (making) return;
    setMaking(true);
    setMakeError("");
    game.generateMap({ seed: Math.floor(Math.random() * 1e9), players: Math.max(2, opponents.length + 1), terrain: "random" })
      .then((id) => setMapId(id), (e: Error) => setMakeError(e.message))
      .finally(() => setMaking(false));
  };

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

  const preview = (id: string) => (publicShot ? "" : previews[id] ?? "");
  const ready = prepared === map?.id && sheets.uploaded >= sheets.total;
  const loadingArt = prepared === map?.id && sheets.uploaded < sheets.total;
  const modern = factions.filter((f) => MODERN.has(f.id));
  const classic = factions.filter((f) => !MODERN.has(f.id));
  const allOptions = setup.options ?? [];
  const shown = allOptions.filter((o) => moreOptions || KEY_OPTIONS.includes(o.id));
  const hidden = allOptions.filter((o) => !KEY_OPTIONS.includes(o.id)).length;
  const updateOpponent = (i: number, patch: Partial<Opponent>) => setOpponents(opponents.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const nationTile = (f: SetupFaction) => {
    const selected = f.id === faction;
    return (
      <button key={f.id} type="button" className="sk-nation" aria-pressed={selected} data-sfx-hover onClick={() => setFaction(f.id)}>
        <span className="sk-nation-flag"><Flag id={f.id} /></span>
        <span className="sk-nation-name">{f.name}</span>
        {selected && <span className="sk-nation-check" aria-hidden="true"><Check size={11} strokeWidth={3.5} /></span>}
        <Brackets />
      </button>
    );
  };

  return (
    <div className="scr-root sk-root" data-ui-sfx>
      <ScreenBackdrop image="menu/backdrop.webp" />
      <div className="scr-topbar" aria-hidden="true" />
      <main className="scr-content sk-layout">
        <header className="scr-head sk-head">
          <span className="menu-eyebrow">Battle the AI</span>
          <h1>Skirmish</h1>
        </header>

        {/* Nation */}
        <section className="sk-col" aria-label="Your nation">
          <NationHero key={faction} id={faction} info={factions.find((f) => f.id === faction)} units={profile === "public" ? SIGNATURE[faction] ?? [] : []} />
          {modern.length > 0 && <div className="sk-group">
            <h3 className="scr-label">Modern nations</h3>
            <div className="sk-nations sk-modern">{modern.map(nationTile)}</div>
          </div>}
          {classic.length > 0 && <div className="sk-group">
            <h3 className="scr-label">Classic nations</h3>
            <div className="sk-nations sk-classic">{classic.map(nationTile)}</div>
          </div>}
          <div className="sk-group sk-colours" role="group" aria-label="Your colour">
            <h3 className="scr-label">Colour</h3>
            <div className="sk-swatches">
              {COLORS.map((c) => (
                <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={color === c} className="sk-swatch" style={{ "--swatch": `#${c}` } as CSSProperties} onClick={() => setColor(c)}>
                  {color === c && <Check size={14} strokeWidth={3.5} aria-hidden="true" />}
                </button>
              ))}
            </div>
          </div>
          {allOptions.length > 0 && <div className="scr-panel sk-rules" role="group" aria-label="Rules">
            <header className="scr-panel-head">
              <h3 className="scr-label"><SlidersHorizontal size={14} aria-hidden="true" />Rules</h3>
              {hidden > 0 && <button type="button" className="scr-more" aria-expanded={moreOptions} onClick={() => setMoreOptions(!moreOptions)}>
                {moreOptions ? "Fewer options" : `More options (${hidden})`}<ChevronDown size={14} aria-hidden="true" />
              </button>}
            </header>
            <div className="sk-rule-picks">
              {shown.filter((o) => !isSwitch(o)).map((o) => (
                <label key={o.id} className="sk-rule">
                  <span>{o.name}</span>
                  <OptionSelect size="sm" aria-label={o.name} value={options[o.id] ?? o.default} onValueChange={(v) => setOptions({ ...options, [o.id]: v })}
                    options={o.values.map((v) => ({ value: v.value, label: v.label }))} />
                </label>
              ))}
            </div>
            <div className="sk-rule-switches">
              {shown.filter(isSwitch).map((o) => (
                <Toggle key={o.id} label={o.name} checked={(options[o.id] ?? o.default) === "True"} onChange={(on) => setOptions({ ...options, [o.id]: on ? "True" : "False" })} />
              ))}
            </div>
          </div>}
        </section>

        {/* Battlefield and opponents */}
        <section className="sk-col" aria-label="Battle">
          {map && <div className="scr-panel sk-map">
            <div className="sk-map-view">
              {preview(map.id) ? <><img className="sk-map-fill" src={preview(map.id)} alt="" aria-hidden="true" draggable={false} /><img key={map.id} src={preview(map.id)} alt={`${map.title} map`} draggable={false} /></>
                : <div className="sk-map-blank"><MapIcon size={44} strokeWidth={1.2} aria-hidden="true" /></div>}
              <Brackets className="always" />
              <div className="sk-map-caption">
                <span className="menu-eyebrow">Battlefield</span>
                <h2>{map.title}</h2>
                <div className="scr-chips">
                  <span className="scr-chip"><Users size={12} aria-hidden="true" />{map.players} players</span>
                  {map.saved ? <>{map.place && <span className="scr-chip">{map.place}</span>}<span className="scr-chip">Your map</span></>
                    : map.generated ? <><span className="scr-chip">{map.landscape}</span><span className="scr-chip"><Dices size={12} aria-hidden="true" />Random</span></>
                    : <span className="scr-chip">{titleCase(map.tileset)}</span>}
                </div>
              </div>
              <span className="sk-map-status" data-ready={ready} data-error={!!mapError} role="status">
                {mapError ? <><i className="scr-dot" /> {mapError}</> : ready ? <><i className="scr-dot" /> Ready</> : <><span className="spinner" />{loadingArt ? `Loading art ${Math.round((100 * sheets.uploaded) / Math.max(1, sheets.total))}%` : "Preparing"}</>}
              </span>
            </div>
            <div className="sk-maps" role="group" aria-label="Maps">
              <button type="button" className="sk-map-thumb sk-map-random" data-sfx-hover onClick={makeMap} aria-busy={making} data-testid="random-map">
                <span className="sk-map-thumb-art">{making ? <span className="spinner" /> : <Dices size={24} strokeWidth={1.4} aria-hidden="true" />}</span>
                <span className="sk-map-thumb-name">{making ? "Making a map…" : "New random map"}</span>
                <small>{makeError || "Lakes, hills, cliffs"}</small>
              </button>
              {orderedMaps.map((m) => (
                <button key={m.id} type="button" className="sk-map-thumb" aria-pressed={m.id === map.id} data-sfx-hover onClick={() => setMapId(m.id)}>
                  <span className="sk-map-thumb-art">{preview(m.id) ? <img src={preview(m.id)} alt="" draggable={false} /> : <MapIcon size={22} strokeWidth={1.4} aria-hidden="true" />}</span>
                  <span className="sk-map-thumb-name">{m.title}</span>
                  <small>{m.players} players</small>
                </button>
              ))}
            </div>
            {setup.maps.length > 8 && <SearchSelect value={mapId} onValueChange={setMapId} options={mapOptions} aria-label="Map" placeholder="Find a map…" className="sk-map-search" />}
          </div>}

          <div className="scr-panel sk-opponents" role="group" aria-label="Opponents">
            <header className="scr-panel-head"><h3 className="scr-label"><Bot size={14} aria-hidden="true" />Opponents</h3><span className="scr-count">{opponents.length} / {maxOpponents}</span></header>
            {opponents.map((o, i) => (
              <div key={i} className="sk-opp" style={{ "--team": `#${o.color}` } as CSSProperties}>
                <button type="button" className="sk-opp-flag" aria-label={`Opponent ${i + 1} colour`} title="Change colour"
                  onClick={() => updateOpponent(i, { color: COLORS[(COLORS.indexOf(o.color) + 1) % COLORS.length] })}>
                  <Flag id={o.faction} /><i className="sk-opp-colour" />
                </button>
                <div className="sk-opp-fields">
                  <SearchSelect size="sm" value={o.faction} onValueChange={(v) => updateOpponent(i, { faction: v })} options={factionOptions} aria-label={`Opponent ${i + 1} nation`} />
                  <div className="sk-opp-row">
                    <OptionSelect size="sm" value={o.bot} onValueChange={(v) => updateOpponent(i, { bot: v })} options={botOptions} aria-label={`Opponent ${i + 1} AI`} />
                    <span className="sk-opp-personality" title={PERSONALITY_HINT}>
                      <GameSelect aria-label={`Opponent ${i + 1} personality`} value={o.doctrine ?? "standard"} onChange={(e) => updateOpponent(i, { doctrine: e.target.value })}>
                        <option value="standard">Standard native AI</option><option value="raider">Raider · pressure observed contacts</option><option value="sentinel">Sentinel · intercept near home</option><option value="adaptive">Adaptive · regroup when outnumbered</option>
                      </GameSelect>
                    </span>
                  </div>
                </div>
                {opponents.length > 1 && <button type="button" className="sk-opp-remove" aria-label="Remove opponent" onClick={() => setOpponents(opponents.filter((_, j) => j !== i))}><X size={15} /></button>}
              </div>
            ))}
            {opponents.length < maxOpponents && (
              <button type="button" className="sk-opp-add" onClick={() => setOpponents([...opponents, { faction: factions[(opponents.length * 3 + 5) % factions.length].id, bot: setup.bots[0].type, color: COLORS[(opponents.length + 1) % COLORS.length] }])}>
                <Plus size={16} aria-hidden="true" />Add opponent
              </button>
            )}
          </div>

        </section>

        <p data-testid="ea-notice" className="scr-notice sk-notice">{EA_NOTICE}</p>

        <div className="scr-command sk-command">
          {!privateContent && !profile && <span className="scr-hint">Original game files not mounted</span>}
          {ccAvailable && <CoCommanderToggle game={game} enabled={cc.enabled} mode={cc.mode} error={cc.error} />}
          <GameButton variant="primary" size="lg" className="scr-cta" icon={<Swords size={18} aria-hidden="true" />} onClick={start} disabled={!map}>Start</GameButton>
        </div>
      </main>
      <div className="scr-footbar" aria-hidden="true" />
    </div>
  );
}

/** The chosen nation, big: its flag, name, identity and a few of its own units. */
function NationHero({ id, info, units }: { id: string; info?: SetupFaction; units: string[] }) {
  const identity = factionIdentity(id);
  const labels = useStore((s) => s.actorLabels);
  const special = !identity ? info?.description.split("\n")[1]?.split(": ") : undefined;
  return (
    <div className="sk-hero" style={{ "--accent": identity?.accent ?? "#f1d28b" } as CSSProperties}>
      <div className="sk-hero-banner" aria-hidden="true"><Flag id={id} /></div>
      <div className="sk-hero-flag"><Flag id={id} /></div>
      <div className="sk-hero-text">
        <span className="sk-hero-kicker">{identity?.title ?? (info ? SIDE_NAME[info.side] ?? info.side : "")}</span>
        <h2>{info?.name ?? id}</h2>
        {identity ? <p className="sk-hero-tagline">{identity.tagline}</p>
          : special?.length === 2 ? <p className="sk-hero-tagline">{special[0]} · <b>{special[1]}</b></p> : null}
        {identity && <p className="sk-hero-strengths">{identity.strengths}</p>}
      </div>
      {units.length > 0 && <div className="sk-hero-units" aria-hidden="true">
        {units.map((u, i) => <img key={u} src={`portraits/${u}.png`} alt="" title={labels[u] ?? labels[u.toUpperCase()]} draggable={false} style={{ animationDelay: `${0.08 + i * 0.06}s` }} />)}
      </div>}
    </div>
  );
}

/** The AI co-commander for this match: on/off, and which brain (the local AI stack, or a scripted stand-in). */
function CoCommanderToggle({ game, enabled, mode, error }: { game: Game; enabled: boolean; mode: "mock" | "local" | "browser"; error: string }) {
  const localAvailable = useStore((s) => s.ccLocalAvailable);
  return (
    <div className="sk-cc" data-on={enabled} title={error || "An AI co-commander that advises, answers and proposes orders"}>
      <button type="button" role="switch" aria-checked={enabled} aria-label="AI co-commander" className="sk-cc-switch" onClick={() => game.cc.setEnabled(!enabled)}>
        <Brain size={18} aria-hidden="true" />
        <span className="sk-cc-text"><b>Co-commander</b><small>{enabled ? (localAvailable ? "On" : "Strategy adviser") : "Off"}</small></span>
        <span className="scr-switch-track" aria-hidden="true"><i /></span>
      </button>
      {enabled && localAvailable && (
        <span className="sk-cc-modes">
          {(["browser", "local", "mock"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => game.cc.setMode(m)}>
              {m === "browser" ? "Strategy adviser" : m === "local" ? "Local AI" : "Scripted"}
            </button>
          ))}
        </span>
      )}
      {error && <span className="sk-cc-error" aria-label={error} />}
    </div>
  );
}
