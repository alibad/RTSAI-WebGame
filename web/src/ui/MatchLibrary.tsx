// Saves & replays: local matches saved on this device, each a card with its battlefield, sides, date and
// length, to resume or watch back; export, import and delete. A save is the match's scenario plus the engine's
// recorded order packets (MatchRestore.cs rebuilds the world from them), the selection, groups and the view.

import { useEffect, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Check, Clock, Download, Film, Map as MapIcon, Play, Save, Swords, Trash2, Upload } from "lucide-react";
import { buildIdentity } from "../sim/build-identity";
import { findSaveVersion, savedBattleUrl, type SaveVersion } from "../sim/save-versions";
import { EditorController, savedMapArchive } from "../editor";
import { retainBattle } from "../sim/save-records";
import type { Game } from "../game";
import { useStore } from "../store";
import { Button } from "../components/ui/button";
import { EmptyState, FilePickButton, GameButton, GameDialog } from "./kit/game";
import { Flag } from "./Flag";
import { clock, matchKind, matchSides, matchTitle, parseScenario, type ScenarioLike } from "./match-info";
import { replayOf, setReplaySpeed } from "./Replay";

export interface MatchRecord {
  id: string; date: string; scenario: Record<string, unknown>; tick: number; log: unknown; profile: string; identity?: string;
  selection?: number[]; groups?: number[][]; view?: ReturnType<Game["captureUi"]>;
  /** A small picture of the battlefield when it was saved (JPEG data URL). */
  thumb?: string;
  /** The battlefield's name when it was saved: a random map is not in a later session's map list. */
  title?: string;
  /** Original rules and custom-map files are preserved in exported and resumed saves. */
  version?: SaveVersion;
  mapFiles?: Record<string, string>;
}

const KEY = "rtsai.local-matches.v1";

// ---------------------------------------------------------------- the saved list, shared by every view of it

let records: MatchRecord[] | null = null;
const subs = new Set<() => void>();
function load(): MatchRecord[] {
  if (records) return records;
  try { records = JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { records = []; }
  if (!Array.isArray(records)) records = [];
  return records!;
}
function store(next: MatchRecord[]) {
  localStorage.setItem(KEY, JSON.stringify(next));
  records = next;
  subs.forEach((f) => f());
}
/** A save by id (the one to resume after a reload, GraphicsState.tsx). */
export function savedRecord(id: string) { return load().find((r) => r.id === id) ?? null; }

/** sessionStorage: a save to resume as soon as the page has reloaded (the graphics were reset mid-match). */
export const RESUME_AFTER_RELOAD = "rtsai.resumeAfterReload";

function useRecords() {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, load);
}

const runtime = () => new URLSearchParams(location.search).get("runtime") || "aot";

/** A picture of the battlefield (16:9, 320 px wide) for the save's card. */
export async function captureThumb(game: Game) {
  try {
    const frame = await game.captureFrame(800);
    const w = 320, h = 180;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const scale = Math.max(w / frame.width, h / frame.height);
    const sw = w / scale, sh = h / scale;
    canvas.getContext("2d")!.drawImage(frame, (frame.width - sw) / 2, (frame.height - sh) / 2, sw, sh, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch { return ""; }
}

/** The running match as a save (its scenario, the recorded orders, the selection, groups and view). */
export async function recordMatch(game: Game): Promise<MatchRecord> {
  const scenario = JSON.parse(game.scenarioJson); delete scenario.webReplay;
  const recording = await game.client.request<{ log: unknown; tick: number; selection: number[]; groups: number[][]; mapFiles?: Record<string, string> }>({ type: "record", map: String(scenario.map ?? '') });
  const { profile, setup } = useStore.getState();
  const thumb = await captureThumb(game);
  const identity = await buildIdentity(profile, runtime());
  const version = await findSaveVersion(identity).catch(() => null);
  return { id: crypto.randomUUID(), date: new Date().toISOString(), scenario, ...recording, profile, identity, ...(version ? { version } : {}), view: game.captureUi(),
    title: matchTitle(scenario, setup), ...(thumb ? { thumb } : {}) };
}

/** Never evict another battle to make room. Without room for its picture, try this save without one. */
export function keepRecord(record: MatchRecord) {
  retainBattle(record, load(), store);
}

/** Starts a save: resumed where it was saved, or (readonly) its replay from the start. Returns why it cannot. */
export async function startRecord(game: Game, record: MatchRecord, readonly: boolean): Promise<string> {
  try {
    const profile = useStore.getState().profile;
    if (record.profile !== profile) return `This match was saved in the ${record.profile === "public-classic" ? "Classic / top-down" : "Isometric"} view. Switch views to open it.`;
    if (!record.identity) return "This save does not identify its original game files. Your saved battle has been kept.";
    if (record.identity !== await buildIdentity(profile, runtime())) {
      const version = await findSaveVersion(record.identity);
      if (!version) return "The original game files for this save are not in the archive yet. Your saved battle has been kept.";
      const mapFiles = record.mapFiles ?? await savedMapArchive(String(record.scenario.map ?? ''));
      // Add only recovery metadata: the original tick, orders, frame hashes and view are unchanged.
      try { keepRecord({ ...record, version, ...(mapFiles ? { mapFiles } : {}) }); }
      catch { /* Optional metadata must not prevent opening a battle when storage is full; the original is intact. */ }
      location.assign(savedBattleUrl(location.href, version, record.id, readonly));
      return '';
    }
    game.editor ??= new EditorController(game);
    await game.editor.loadLibrary();
    if (record.mapFiles) {
      const map = String(record.scenario.map ?? '');
      if (!/^[a-z0-9-]+$/.test(map) || !record.mapFiles['map.yaml'] || !record.mapFiles['map.bin'])
        return 'This save has invalid map files. Your saved battle has been kept.';
      const files: Record<string, Uint8Array> = {};
      for (const [name, encoded] of Object.entries(record.mapFiles)) {
        if (!/^[a-zA-Z0-9_.-]+$/.test(name) || typeof encoded !== 'string') return 'This save has invalid map files. Your saved battle has been kept.';
        files[name] = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      }
      await game.editor.addFiles(map, record.title ?? 'Saved battlefield', (record.scenario.players as unknown[] | undefined)?.length ?? 2, files);
    }
    setReplaySpeed(game, 1);
    const position = readonly ? 0 : record.tick;
    game.start(JSON.stringify({ ...record.scenario, webReplay: { log: record.log, tick: position, readonly, end: record.tick, groups: record.groups, selection: record.selection, view: record.view } }), readonly);
    return "";
  } catch (error) {
    return `${error instanceof Error ? error.message : 'The saved battle could not be opened.'} Your save has been kept.`;
  }
}

function exportRecord(record: MatchRecord) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(record)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `rtsai-match-${record.id}.json`; link.click(); URL.revokeObjectURL(url);
}

/** The other battlefield view is another game profile: the page reloads into it (as the main menu's view tiles do). */
function switchView(profile: string) {
  const url = new URL(location.href);
  url.searchParams.delete('saveVersion'); url.searchParams.delete('openMatch'); url.searchParams.delete('watch');
  url.searchParams.set("game", profile === "public-classic" ? "classic" : "isometric");
  url.searchParams.set("profile", profile);
  location.assign(url);
}

function when(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) })} ${time}`;
}

// ---------------------------------------------------------------- one save

function SaveCard({ game, record, fresh, onStart }: { game: Game; record: MatchRecord; fresh: boolean; onStart: () => void }) {
  const setup = useStore((s) => s.setup);
  const profile = useStore((s) => s.profile);
  const phase = useStore((s) => s.phase);
  const scenario = record.scenario as ScenarioLike;
  const mapId = typeof scenario.map === "string" ? scenario.map : "";
  const preview = useStore((s) => (record.thumb ? undefined : s.previews[mapId]));
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const title = matchTitle(scenario, setup, typeof record.title === "string" ? record.title : undefined);
  const sides = matchSides(scenario, setup);
  // A save without its own picture shows the map, when this game has it (the menu asks the engine for previews).
  useEffect(() => {
    if (!record.thumb && phase === "setup" && record.profile === profile && setup?.maps.some((m) => m.id === mapId)) game.preview(mapId);
  }, [game, record.thumb, phase, record.profile, profile, setup, mapId]);
  async function start(readonly: boolean) {
    setBusy(true); setError("");
    const why = await startRecord(game, record, readonly);
    setBusy(false);
    if (why) setError(why); else onStart();
  }
  const view = record.profile === "public-classic" ? "Classic" : record.profile === "public" ? "Isometric" : "";
  // A static build offers only the views it was built with (tools/build-public.mjs, VITE_GAME_MODES).
  const offered = import.meta.env.VITE_STATIC_BUILD !== "1" || (import.meta.env.VITE_GAME_MODES ?? "public").split(",").includes(record.profile);
  return (
    <li className={`lib-card${fresh ? " is-new" : ""}`}>
      <button type="button" className="lib-thumb" aria-label={`Watch the replay of ${title}`} data-sfx-hover disabled={busy} onClick={() => void start(true)}>
        {record.thumb ? <img src={record.thumb} alt="" draggable={false} />
          : preview ? <img className="is-map" src={preview} alt="" draggable={false} />
            : <span className="lib-thumb-empty"><MapIcon size={34} /><b>{title}</b></span>}
        <span className="lib-chip lib-kind">{matchKind(scenario)}</span>
        <span className="lib-chip lib-len"><Clock />{clock(record.tick)}</span>
        <span className="lib-play"><Play /></span>
      </button>
      <div className="lib-body">
        <div className="lib-title"><b>{title}</b><small>{when(record.date)}</small></div>
        <div className="lib-sides">
          {sides.map((s, i) => <span key={i} className="lib-side">{i > 0 && <span className="lib-vs">VS</span>}<Flag id={s.faction} /><span>{s.you ? <em>You</em> : s.nation}</span></span>)}
          {view && profile !== record.profile && <span className="lib-tag">{view}</span>}
        </div>
        <div className="lib-actions">
          {confirming ? (
            <div className="lib-confirm" role="group" aria-label="Delete this save?">
              <span>Delete this save?</span>
              <GameButton size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</GameButton>
              <GameButton size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => store(load().filter((x) => x.id !== record.id))}>Delete</GameButton>
            </div>
          ) : <>
            <GameButton size="sm" icon={<Swords size={14} />} disabled={busy} onClick={() => void start(false)}>Resume</GameButton>
            <GameButton size="sm" icon={<Film size={14} />} disabled={busy} onClick={() => void start(true)}>Replay</GameButton>
            <button type="button" className="lib-icon" aria-label="Export" data-tip="Export file" data-tip-pos="top" onClick={() => exportRecord(record)}><Download /></button>
            <button type="button" className="lib-icon is-danger" aria-label="Delete" data-tip="Delete" data-tip-pos="top" onClick={() => setConfirming(true)}><Trash2 /></button>
          </>}
        </div>
        {error && <div className="lib-error-row">
          <p role="alert" className="lib-error"><AlertTriangle size={14} />{error}</p>
          {view && offered && profile !== record.profile && <GameButton size="sm" variant="ghost" onClick={() => switchView(record.profile)}>Open the {view.toLowerCase()} view</GameButton>}
        </div>}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- the dialog

/**
 * The Saves & replays button and its dialog. `variant`: "menu" (the main menu's utility row, the default), "hud" (an
 * icon in the in-match top bar) or "item" (a row of the game menu, named "Save or load").
 */
export function MatchLibrary({ game, variant = "menu" }: { game: Game; variant?: "menu" | "hud" | "item" }) {
  const [open, setOpen] = useState(false);
  const list = useRecords();
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [importError, setImportError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState("");
  const [live, setLive] = useState("");
  const phase = useStore((s) => s.phase);
  const setup = useStore((s) => s.setup);
  const tick = useStore((s) => (open ? s.ui?.tick ?? 0 : 0));
  const replaying = phase === "playing" && !!replayOf(game);
  const canSave = phase === "playing" && !game.multiplayer && !replaying && !!game.scenarioJson;
  useEffect(() => { if (open && canSave) void captureThumb(game).then(setLive); }, [open, canSave, game]);

  function close() { setOpen(false); setMessage(""); setSaveError(""); setImportError(""); setFresh(""); }
  async function save() {
    setBusy(true); setSaveError(""); setMessage("");
    try {
      const record = await recordMatch(game);
      keepRecord(record);
      setFresh(record.id);
      setMessage("Match saved on this device.");
    } catch (error) { setSaveError(error instanceof Error && error.message.startsWith("This device") ? error.message : `Save failed: ${String(error)}`); }
    finally { setBusy(false); }
  }
  async function importFile(file: File) {
    setImportError("");
    try {
      const r = JSON.parse(await file.text()) as MatchRecord;
      if (!r.scenario || !Number.isInteger(r.tick) || r.tick < 0 || r.tick > 2000000 || !r.log || typeof r.profile !== "string" || typeof r.date !== "string") throw new Error();
      const { thumb, ...rest } = r;
      const record: MatchRecord = { ...rest, id: crypto.randomUUID(), ...(typeof thumb === "string" && thumb.startsWith("data:image/") ? { thumb } : {}) };
      keepRecord(record);
      setFresh(record.id);
    } catch (error) { setImportError(error instanceof Error && error.message.startsWith("This device") ? error.message : "That file is not a saved RTS AI match. Choose a file exported from Saves & replays."); }
  }

  const scenario = parseScenario(game.scenarioJson);
  const trigger = variant === "hud"
    ? <button type="button" className="hud-tool" aria-label="Saves & replays" data-tip="Saves & replays" onClick={() => setOpen(true)}><Film /></button>
    : variant === "item"
      ? <button type="button" className="pm-item" data-sfx-hover onClick={() => setOpen(true)}><Save />Save or load</button>
      : <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Film size={14} aria-hidden="true" />Saves & replays</Button>;

  return <>
    {trigger}
    {open && <GameDialog eyebrow="This device" title="Saves & replays" size="lg" onClose={close} footer={<>
      <span className="lib-foot-note">{list.length} saved {list.length === 1 ? 'battle' : 'battles'}</span>
      <div className="lib-import">
        {importError && <p role="alert" className="lib-error"><AlertTriangle size={14} />{importError}</p>}
        <FilePickButton accept="application/json,.json" variant="ghost" size="sm" icon={<Upload size={14} />} onFile={(f) => void importFile(f)}>Import</FilePickButton>
      </div>
    </>}>
      <p className="settings-hint">Saves stay in this browser until you delete them, and resume with their original game rules. Export a save to keep a separate copy or move it to another device.</p>
      {canSave && <section className="lib-current" aria-label="Current match">
        <div className="lib-current-thumb">
          {live ? <img src={live} alt="" /> : <Swords size={26} />}
          <span className="lib-live"><i />LIVE</span>
        </div>
        <div className="lib-current-info">
          <span className="menu-eyebrow">Current match</span>
          <b>{matchTitle(scenario, setup)}</b>
          <small>{matchKind(scenario)} · {clock(tick)}</small>
        </div>
        <div className="lib-current-act">
          <GameButton variant="primary" icon={<Save size={16} />} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save current match"}</GameButton>
          {message && <p role="status" className="lib-ok"><Check size={14} />{message}</p>}
          {saveError && <p role="alert" className="lib-error"><AlertTriangle size={14} />{saveError}</p>}
        </div>
      </section>}
      {list.length
        ? <ul className="lib-grid" aria-label="Saved matches">{list.map((r) => <SaveCard key={r.id} game={game} record={r} fresh={r.id === fresh} onStart={close} />)}</ul>
        : <EmptyState icon={<Film size={22} />} title="No saved matches yet">{canSave ? "Save this match to resume it later or watch it back." : "Save during a match to resume it later or watch it back."}</EmptyState>}
    </GameDialog>}
  </>;
}
