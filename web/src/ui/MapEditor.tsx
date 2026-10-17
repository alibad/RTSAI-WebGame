// The map editor. Start: open any map, make a blank one, a random one (the engine's generator) or one from a real place
// (the website's Earth compiler), or load an .oramap. Editing: the engine's own editor does the work (ui -> editor.ts ->
// sim EditorHost): paint terrain templates, ore and gems, place any actor for any owner, set start positions, select,
// drag and delete, undo and redo. Save keeps the map in this browser's library (playable in skirmish and the
// simulator), Download gives the .oramap the desktop editor opens.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Download, Flag as FlagIcon, Gem, Globe2, Map as MapIcon, Mountain, MousePointer2, Plus, Redo2, Save, Search, Swords, Trash2, Undo2, Upload, Users, Waves } from "lucide-react";
import type { Game } from "../game";
import { EditorController, type EditorTool } from "../editor";
import { useStore } from "../store";
import { cn } from "../lib/utils";
import { OptionSelect } from "../components/ui/fields";
import { GameButton } from "./kit/game";
import { MapStrip } from "./MapStrip";
import { ScreenBackdrop } from "./screen-parts";
import { EarthStudio } from "./EarthStudio";
import { readOramap } from "../oramap";
import type { MissionSpec } from "../mission";

/** Template categories worth painting with, in the order a mapper reaches for them (the tileset's own order after). */
const FIRST = ["Lat Grass", "LAT Grass Rough", "LAT Grass, thick", "LAT Sand", "LAT Pavement", "Water", "Shore Pieces", "Sand (beach) Transitions", "Cliff Set", "Cliff/Water pieces", "Ramps", "Slope Set Pieces", "DirtRoads Straight", "DirtRoads Bendy", "DirtRoads Junctions", "Paved Roads", "Bridges", "Wood Bridges", "Farm Crops"];
const HIDDEN = /^(ZMM|Z|Obsolete|New MM|Newest MM|Ramp edge fixup|Blank|RTS AI .* edges|Tunnel|DirtTunnel|Water Caves|Waterfalls|RA2 uss)/;
/** What a mapper calls the tileset's categories. */
const NAMES: Record<string, string> = {
  "Lat Grass": "Grass", "LAT Grass Rough": "Rough ground", "LAT Grass, thick": "Thick grass", "LAT Sand": "Sand", "LAT Pavement": "Pavement",
  "Water": "Water", "Shore Pieces": "Shores", "Sand (beach) Transitions": "Beaches", "Cliff Set": "Cliffs", "Cliff/Water pieces": "Sea cliffs",
  "Ramps": "Ramps", "Slope Set Pieces": "Slopes", "DirtRoads Straight": "Dirt roads", "DirtRoads Bendy": "Road bends", "DirtRoads Junctions": "Junctions",
  "Paved Roads": "Paved roads", "Bridges": "Bridges", "Wood Bridges": "Wooden bridges", "Farm Crops": "Farmland",
};
const nameOf = (c: string) => NAMES[c] ?? c;
const TOOLS: { id: EditorTool; label: string; icon: React.ReactNode; key: string }[] = [
  { id: "select", label: "Select and move", icon: <MousePointer2 size={18} />, key: "S" },
  { id: "terrain", label: "Terrain", icon: <Mountain size={18} />, key: "T" },
  { id: "resource", label: "Ore and gems", icon: <Gem size={18} />, key: "O" },
  { id: "actor", label: "Units, buildings, trees", icon: <Users size={18} />, key: "A" },
  { id: "spawn", label: "Start positions", icon: <FlagIcon size={18} />, key: "P" },
];
const SIZES = [64, 96, 128];
/** The water brush's half-widths in cells. */
const WATER_WIDTHS: [number, string][] = [[2, "Stream"], [3, "River"], [5, "Lake"]];

function StartScreen({ game, editor, mission, play, earthFirst }: { game: Game; editor: EditorController; mission: (m: MissionSpec) => void; play: (map: string, you: string, enemy: string) => void; earthFirst: boolean }) {
  const st = useStore((s) => s.editor)!;
  const [size, setSize] = useState(96);
  const [earth, setEarth] = useState(earthFirst);
  const file = useRef<HTMLInputElement>(null);
  const upload = async (f: File) => {
    try {
      const m = await readOramap(new Uint8Array(await f.arrayBuffer()));
      await editor.openFiles(m.id, m.title, m.players, m.files);
    } catch (e) { useStore.getState().set({ editor: { ...editor.state, error: e instanceof Error ? e.message : String(e) } }); }
  };
  return (
    <div className="scr-root ed-start" data-ui-sfx>
      <ScreenBackdrop image="menu/backdrop.webp" />
      <main className="scr-content ed-start-body" inert={earth} aria-hidden={earth || undefined}>
        <header className="scr-head"><span className="menu-eyebrow">Build a battlefield</span><h1>Map editor</h1></header>
        {st.error && <p className="ed-error" role="alert">{st.error}</p>}
        <section className="ed-new" aria-label="New map">
          <button type="button" className="ed-new-card is-earth" onClick={() => setEarth(true)} data-testid="ed-earth">
            <Globe2 size={30} strokeWidth={1.4} /><b>From a real place</b><small>Search anywhere on Earth; its roads, water and land become the map</small>
          </button>
          <div className="ed-new-card">
            <Plus size={30} strokeWidth={1.4} /><b>Blank map</b>
            <div className="ed-sizes" role="radiogroup" aria-label="Size">{SIZES.map((n) => <button key={n} type="button" role="radio" aria-checked={size === n} onClick={() => setSize(n)}>{n}×{n}</button>)}</div>
            <GameButton size="sm" variant="primary" onClick={() => void editor.open({ new: { width: size, height: size, title: "New map" } })} data-testid="ed-blank">Create</GameButton>
          </div>
          <button type="button" className="ed-new-card" onClick={() => file.current?.click()}>
            <Upload size={30} strokeWidth={1.4} /><b>Import a map</b><small>Open an .oramap file from the desktop editor or a friend</small>
            <input ref={file} type="file" accept=".oramap,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
          </button>
        </section>
        <section className="ed-open" aria-label="Open a map">
          <h2 className="scr-label"><MapIcon size={14} />Open a map, or make a random one</h2>
          <MapStrip game={game} value={undefined} onChange={(id) => void editor.open({ map: id })} className="sim-maps-grid ed-maps" />
        </section>
        {st.opening && <div className="ed-opening" role="status"><span className="spinner" />{st.opening === "random" ? "Making a random map…" : "Opening the map…"}</div>}
      </main>
      {earth && <EarthStudio game={game} editor={editor} close={() => setEarth(false)} mission={mission} play={play} />}
    </div>
  );
}

function Palette({ game, editor }: { game: Game; editor: EditorController }) {
  const st = useStore((s) => s.editor)!;
  const icons = useStore((s) => s.icons);
  const [query, setQuery] = useState("");
  const cat = st.catalog!;
  const categories = useMemo(() => {
    const used = cat.categories.filter((c) => !HIDDEN.test(c) && cat.templates.some((t) => t.categories.includes(c)));
    return [...FIRST.filter((c) => used.includes(c)), ...used.filter((c) => !FIRST.includes(c))];
  }, [cat]);
  const actorCategories = useMemo(() => [...new Set(cat.actors.flatMap((a) => a.categories))].sort(), [cat]);
  const [actorCategory, setActorCategory] = useState(() => actorCategories.find((c) => /tree/i.test(c)) ?? actorCategories[0] ?? "");
  useEffect(() => {
    if (st.tool !== "terrain") return;
    // The chosen category's templates, and one picture for each main category.
    const covers = categories.filter((c) => FIRST.includes(c)).map((c) => cat.templates.find((t) => t.categories.includes(c))?.id).filter((id): id is number => id !== undefined);
    editor.thumbnails([...cat.templates.filter((t) => t.categories.includes(st.category)).map((t) => t.id), ...covers]);
  }, [editor, st.tool, st.category, categories, cat]);
  const actors = cat.actors.filter((a) => query ? a.label.toLowerCase().includes(query.toLowerCase()) || a.name.includes(query.toLowerCase()) : a.categories.includes(actorCategory));
  useEffect(() => { if (st.tool === "actor") game.requestIcons(actors.slice(0, 60).map((a) => a.name)); }, [game, st.tool, actorCategory, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (st.tool !== "actor") return;
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < actors.length && !cancelled; i += 60)
        await editor.actorThumbnails(actors.slice(i, i + 60).map(a => a.name), () => cancelled);
    })();
    return () => { cancelled = true; };
  }, [editor, st.tool, st.owner, actorCategory, query, cat]); // eslint-disable-line react-hooks/exhaustive-deps

  if (st.tool === "terrain") {
    const main = categories.filter((c) => FIRST.includes(c)), more = categories.filter((c) => !FIRST.includes(c));
    const cover = (c: string) => cat.templates.find((t) => t.categories.includes(c));
    return (
      <div className="ed-palette hud-panel">
        <div className="ed-cats" role="tablist" aria-label="Terrain">
          {main.map((c) => { const t = cover(c); return (
            <button key={c} type="button" role="tab" aria-selected={st.category === c} onClick={() => editor.setCategory(c)} data-category={c}>
              <span>{t && st.thumbs[t.id] ? <img src={st.thumbs[t.id]} alt="" draggable={false} /> : null}</span><b>{nameOf(c)}</b>
            </button>); })}
        </div>
        {more.length > 0 && <details className="ed-more"><summary>More terrain ({more.length})</summary>
          <div className="ed-chips">{more.map((c) => <button key={c} type="button" role="tab" aria-selected={st.category === c} onClick={() => editor.setCategory(c)}>{nameOf(c)}</button>)}</div>
        </details>}
        {st.category === "Water" && (
          <div className="ed-water">
            <button type="button" className="ed-water-card" aria-pressed={st.brush.startsWith("water:")} onClick={() => editor.brushWater(3)} data-testid="ed-water">
              <Waves size={22} strokeWidth={1.6} /><b>Lake and river brush</b><small>Drag to paint water; shores and beaches follow it</small>
            </button>
            {st.brush.startsWith("water:") && (
              <div className="ed-sizes" role="radiogroup" aria-label="Brush width">
                {WATER_WIDTHS.map(([r, label]) => <button key={r} type="button" role="radio" aria-checked={st.brush === `water:${r}`} onClick={() => editor.brushWater(r)}>{label}</button>)}
              </div>
            )}
          </div>
        )}
        <div className="ed-tiles">
          {cat.templates.filter((t) => t.categories.includes(st.category)).map((t) => (
            <button key={t.id} type="button" title={`${nameOf(st.category)} · ${t.size[0]}×${t.size[1]}`} aria-pressed={st.brush === `tile:${t.id}`} onClick={() => editor.brushTile(t.id)} data-tile={t.id}>
              {st.thumbs[t.id] ? <img src={st.thumbs[t.id]} alt="" draggable={false} /> : <span className="spinner" />}
            </button>
          ))}
        </div>
        <p className="ed-tip">{st.brush.startsWith("water:") ? "Drag a lake or a river · strokes that touch merge · right-click stops" : "Click or drag to paint · Shift-click fills an area · right-click stops"}</p>
      </div>
    );
  }
  if (st.tool === "resource") return (
    <div className="ed-palette hud-panel is-compact" aria-label="Resource palette">
      <div className="ed-res">
        {cat.resources.map((r) => (
          <button key={r} type="button" aria-pressed={st.brush === `resource:${r}`} onClick={() => editor.brushResource(r)} className={cn("ed-res-card", /gem/i.test(r) && "is-gem")}>
            <Gem size={26} /><b>{r}</b>
          </button>
        ))}
      </div>
      <div className="ed-field-width">
        <span>Brush diameter (cells)</span>
        <div className="ed-sizes" role="radiogroup" aria-label="Resource brush diameter">
          {[0, 1, 2, 4].map((r, i, sizes) => <button key={r} type="button" role="radio" aria-checked={st.fieldRadius === r} tabIndex={st.fieldRadius === r ? 0 : -1} onClick={() => editor.fieldSize(r)} onKeyDown={(e) => {
            const direction = getComputedStyle(e.currentTarget).direction === "rtl" ? -1 : 1;
            const step = e.key === "ArrowRight" ? direction : e.key === "ArrowLeft" ? -direction : 0;
            const next = e.key === "Home" ? 0 : e.key === "End" ? sizes.length - 1 : step ? (i + step + sizes.length) % sizes.length : -1;
            if (next < 0) return;
            e.preventDefault(); editor.fieldSize(sizes[next]);
            (e.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
          }}>{r * 2 + 1}</button>)}
        </div>
      </div>
      <button type="button" className="ed-flatten" aria-pressed={st.brush === "flatten"} onClick={() => editor.brushFlatten()}><Mountain size={18} /><b>Flatten ground</b></button>
      <p className="ed-tip">{st.brush === "flatten" ? "Drag a field or a connected path, then release. Slopes join the surrounding ground automatically. Touching resource fields join the level area; rivers and buildings stay intact." : "Click or drag to paint a field. Use Flatten ground to prepare connected fields and paths. Right-click stops."}</p>
      {st.placement && <p className={cn("ed-placement", !st.placement.added && "is-blocked")} role="status" data-testid="ed-placement">
        {st.placement.added ? st.brush === "flatten" ? `Flattened ${st.placement.added} ground ${st.placement.added === 1 ? "tile" : "tiles"}.` : `Painted ${st.placement.added} ${st.brush === "resource:Gems" ? "gem" : st.brush.slice(9).toLowerCase()} ${st.placement.added === 1 ? "tile" : "tiles"}.` : st.placement.blocked || (st.brush === "flatten" ? "This ground is already level." : "No resource tiles changed.")}
        {st.placement.added > 0 && st.brush === "flatten" && st.placement.blocked && <small className="ed-ground-note">Riverbanks and structures kept intact.</small>}
      </p>}
    </div>
  );
  if (st.tool === "actor") return (
    <div className="ed-palette hud-panel">
      <label className="ed-owner"><span>Owner</span>
        <OptionSelect aria-label="Actor owner" value={st.owner} onValueChange={(value) => editor.setOwner(value)}
          options={cat.owners.map((o) => ({ value: o.name, label: o.name }))} size="sm" />
      </label>
      <div className="ed-search"><Search size={14} /><input aria-label="Find a unit, building or tree" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a unit, building, tree…" /></div>
      {!query && <div className="ed-chips" role="tablist" aria-label="Actor categories">
        {actorCategories.map((c) => <button key={c} type="button" role="tab" aria-selected={actorCategory === c} onClick={() => setActorCategory(c)}>{c}</button>)}
      </div>}
      <div className="ed-actors">
        {actors.map((a) => (
          <button key={a.name} type="button" title={`${a.label} (${a.name})`} aria-label={`${a.label} (${a.name})`} aria-pressed={st.brush === `actor:${a.name}`} onClick={() => editor.brushActor(a.name)} data-actor={a.name}>
            <span className="ed-actor-picture">{st.actorThumbs[`${st.owner}:${a.name}`] || icons[a.name] ? <img src={(st.actorThumbs[`${st.owner}:${a.name}`] || icons[a.name])!} alt="" draggable={false} /> : <span aria-hidden="true">◇</span>}</span>
            <span className="ed-actor-name">{a.label}</span>
            {a.categories.includes("Bridge") && <small className="ed-actor-detail">{bridgePart(a.name)}</small>}
          </button>
        ))}
      </div>
      <p className="ed-tip">{actorCategory === "Bridge" && !query ? "Bridge pieces: match span direction and ramps at the banks. A destroyed span leaves a gap. " : ""}Click to place · right-click stops · Select tool moves and deletes</p>
    </div>
  );
  if (st.tool === "spawn") return (
    <div className="ed-palette hud-panel is-compact"><p className="ed-tip">Click to add a start position. Every start position is a player slot: two for a duel, up to eight.</p></div>
  );
  return (
    <div className="ed-palette hud-panel is-compact"><p className="ed-tip">Click to select · drag to move a unit · drag empty ground to select an area · Delete removes it</p></div>
  );
}

function bridgePart(name: string) {
  if (name === "cabhut") return "Repair hut";
  if (/^bridg/.test(name)) return `Elevated · ${name.endsWith("1") ? "NW / SE" : "NE / SW"}`;
  const ramp = /_r_(ne|nw|se|sw)$/.exec(name);
  if (ramp) return `${name.startsWith("lobrdb") ? "Wood" : "Concrete"} · ${ramp[1].toUpperCase()} bank`;
  return `${name.endsWith("_d") ? "Destroyed" : "Span"} · ${/_a(?:_d)?$/.test(name) ? "NE / SW" : "NW / SE"}`;
}

/** A light footprint guide follows the pointer without re-rendering the palette on every move. */
function FieldCursor({ game, brush, radius }: { game: Game; brush: string; radius: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const el = ref.current, info = game.info;
      if (!el || !info) return;
      el.hidden = e.target !== game.canvas;
      if (el.hidden) return;
      const rect = el.parentElement!.getBoundingClientRect();
      const scale = info.gridType === "Rectangular" ? 1 : Math.SQRT1_2;
      el.style.width = `${Math.max(8, (radius * 2 + 1) * info.tileSize[0] * scale * game.cam.zoom)}px`;
      el.style.height = `${Math.max(8, (radius * 2 + 1) * info.tileSize[1] * scale * game.cam.zoom)}px`;
      el.style.left = `${e.clientX - rect.left}px`; el.style.top = `${e.clientY - rect.top}px`;
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [game, radius]);
  return <div ref={ref} hidden aria-hidden="true" className={cn("ed-field-cursor", brush === "flatten" && "is-flatten", brush === "resource:Gems" && "is-gem")} />;
}

function Editing({ game, editor, test }: { game: Game; editor: EditorController; test: (map: string) => void }) {
  const st = useStore((s) => s.editor)!;
  const back = () => { if (!st.dirty || confirm("Leave without saving?")) editor.close(); };
  // A battle needs a start position for each side.
  const testSaved = (id: string) => {
    const players = useStore.getState().setup?.maps.find((m) => m.id === id)?.players ?? 0;
    if (players >= 2) test(id);
    else editor.fail("Add two start positions (the flag tool) before testing it in the simulator.");
  };
  return (
    <>
      <header className="ed-top hud-panel" data-ui-sfx>
        <button type="button" className="hud-tool" aria-label="Close the map" data-tip="Close the map" onClick={back}><ArrowLeft /></button>
        <input className="ed-title" value={st.title} onChange={(e) => editor.setTitle(e.target.value)} aria-label="Map name" data-testid="ed-title" />
        <span className="ed-size digits">{st.catalog?.size.join(" × ")}</span>
        <span className="ed-sep" />
        <button type="button" className="hud-tool" aria-label="Undo" data-tip="Undo · Ctrl+Z" disabled={!st.undo} onClick={() => editor.undo()}><Undo2 /></button>
        <button type="button" className="hud-tool" aria-label="Redo" data-tip="Redo · Ctrl+Y" disabled={!st.redo} onClick={() => editor.redo()}><Redo2 /></button>
        <button type="button" className="hud-tool" aria-label="Delete selection" data-tip="Delete selection · Del" onClick={() => editor.deleteSelection()}><Trash2 /></button>
        <span className="ed-sep" />
        <GameButton size="sm" icon={<Save size={14} />} onClick={() => void editor.save()} data-testid="ed-save">{st.saving ? "Saving…" : st.dirty || !st.saved ? "Save" : "Saved"}</GameButton>
        <GameButton size="sm" icon={<Download size={14} />} onClick={() => void editor.download()}>Download map</GameButton>
        <GameButton size="sm" variant="primary" icon={<Swords size={14} />} onClick={() => void editor.save().then((id) => { if (id) testSaved(id); })} data-testid="ed-test">Test in simulator</GameButton>
      </header>
      {st.error && <p className="ed-error ed-error-float" role="alert">{st.error}</p>}
      <nav className="ed-tools hud-panel" aria-label="Tools">
        {TOOLS.map((t) => (
          <button key={t.id} type="button" aria-pressed={st.tool === t.id} aria-label={t.label} data-tip={`${t.label} · ${t.key}`} data-tip-pos="right" onClick={() => editor.setTool(t.id)} data-tool={t.id}>{t.icon}</button>
        ))}
      </nav>
      {st.catalog && <Palette game={game} editor={editor} />}
      {(st.brush === "flatten" || st.brush.startsWith("resource:")) && <FieldCursor game={game} brush={st.brush} radius={st.fieldRadius} />}
    </>
  );
}

export function MapEditor({ game, exit, test, mission, play, earthFirst = false }: { game: Game; exit: () => void; test: (map: string) => void; mission: (m: MissionSpec) => void; play: (map: string, you: string, enemy: string) => void; earthFirst?: boolean }) {
  const [editor] = useState(() => (game.editor ??= new EditorController(game)));
  const st = useStore((s) => s.editor);
  const phase = useStore((s) => s.phase);
  // Tool keys (T, O, A, P, S) while editing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (!editor.active || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
      const tool = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (tool) { editor.setTool(tool.id); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor]);
  if (!st) return null;
  const editing = !!st.map && phase === "playing";
  return (
    <div className="ed-root" style={{ "--ed-palette-w": "300px" } as CSSProperties}>
      {editing ? <Editing game={game} editor={editor} test={test} /> : <StartScreen game={game} editor={editor} mission={mission} play={play} earthFirst={earthFirst} />}
      {!editing && <nav className="menu-subnav scr-subnav" aria-label="Map editor" data-ui-sfx>
        <button type="button" onClick={exit} className="menu-subnav-back" aria-label="Main menu"><ArrowLeft size={15} aria-hidden="true" /><span>Main menu</span></button>
      </nav>}
    </div>
  );
}
