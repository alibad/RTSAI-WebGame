import { buildIdentity } from "../sim/build-identity";
import { GameSelect } from "../components/ui/fields";
import { useState } from "react";
import type { Game } from "../game";
import { useStore } from "../store";
import { Button } from "../components/ui/button";

interface MatchRecord { id: string; date: string; scenario: Record<string, unknown>; tick: number; log: unknown; profile: string; identity?: string; selection?: number[]; groups?: number[][]; view?: ReturnType<Game["captureUi"]> }
const KEY = "rtsai.local-matches.v1";
function read(): MatchRecord[] { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; } }

export function MatchLibrary({ game }: { game: Game }) {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState(read);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [seek, setSeek] = useState<number | null>(null);
  const profile = useStore((s) => s.profile);
  const phase = useStore((s) => s.phase);
  const paused = useStore((s) => s.paused);
  const tick = useStore((s) => s.ui?.tick ?? 0);
  const replay = JSON.parse(game.scenarioJson || "{}").webReplay;
  async function save() {
    setBusy(true);
    try {
      const recording = await game.client.request<{ log: unknown; tick: number; selection: number[]; groups: number[][] }>({ type: "record" });
      const scenario = JSON.parse(game.scenarioJson); delete scenario.webReplay;
      const record: MatchRecord = { id: crypto.randomUUID(), date: new Date().toISOString(), scenario, ...recording, profile, identity: await buildIdentity(profile, new URLSearchParams(location.search).get("runtime") || "aot"), view: game.captureUi() };
      const next = [record, ...records].slice(0, 10);
      localStorage.setItem(KEY, JSON.stringify(next)); setRecords(next); setMessage("Match saved on this device.");
    } catch (error) { setMessage(`Save failed: ${String(error)}`); }
    finally { setBusy(false); }
  }
  async function load(record: MatchRecord, readonly: boolean, position = readonly ? 0 : record.tick) {
    if (record.profile !== profile) { setMessage("Switch to this save's content profile before loading it."); return; }
    if (!record.identity || record.identity !== await buildIdentity(profile, new URLSearchParams(location.search).get("runtime") || "aot")) { setMessage("This save requires its original simulator and content build."); return; }
    game.start(JSON.stringify({ ...record.scenario, webReplay: { log: record.log, tick: position, readonly, end: record.tick, groups: record.groups, selection: record.selection, view: record.view } }), readonly);
    setOpen(false);
  }
  function exportRecord(record: MatchRecord) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(record)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `rtsai-match-${record.id}.json`; link.click(); URL.revokeObjectURL(url);
  }
  return <>
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Saves & replays</Button>
    {replay?.readonly && <div className="hud-panel flex items-center gap-2 px-2 text-xs">
      <span>{tick >= replay.end ? "Replay finished" : "Replay"} {Math.floor(tick / 25)} / {Math.floor(replay.end / 25)}s</span>
      <Button size="sm" onClick={() => tick >= replay.end
        ? game.start(JSON.stringify({ ...JSON.parse(game.scenarioJson), webReplay: { ...replay, tick: 0 } }), false)
        : game.setPaused(!paused)}>{tick >= replay.end ? "Restart" : paused ? "Play" : "Pause"}</Button>
      <GameSelect aria-label="Replay speed" onChange={(e) => game.client.send({ type: "speed", speed: Number(e.target.value) })} defaultValue="1">
        {[0.25, 0.5, 1, 2, 4, 8].map((v) => <option key={v} value={v}>{v}×</option>)}
      </GameSelect>
      <input type="range" aria-label="Replay position" min="0" max={replay.end} value={seek ?? tick}
        onChange={(e) => setSeek(Number(e.target.value))}
        onPointerUp={(e) => { game.start(JSON.stringify({ ...JSON.parse(game.scenarioJson), webReplay: { ...replay, tick: Number(e.currentTarget.value) } }), true); setSeek(null); }}
        onKeyUp={(e) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { game.start(JSON.stringify({ ...JSON.parse(game.scenarioJson), webReplay: { ...replay, tick: Number(e.currentTarget.value) } }), true); setSeek(null); } }} />
    </div>}
    {open && <div className="fixed inset-0 z-50 grid place-items-center bg-black/70" role="dialog" aria-modal="true" aria-label="Local saves and replays">
      <div className="hud-panel max-h-[85vh] w-[min(600px,95vw)] overflow-auto p-4">
        <div className="flex justify-between"><strong>Local saves & replays</strong><Button size="sm" onClick={() => setOpen(false)}>Close</Button></div>
        <p className="my-3 text-xs">Save a local match, resume it, or watch its recorded orders. Saves use the current game content.</p>
        <Button disabled={busy || phase !== "playing" || game.multiplayer || !!replay?.readonly || !game.scenarioJson} onClick={() => void save()}>{busy ? "Saving…" : "Save current match"}</Button>
        <label className="ml-3 text-xs">Import<input type="file" accept="application/json,.json" className="block max-w-full" onChange={async (e) => {
          try { const file = e.target.files?.[0]; if (!file) return; const r = JSON.parse(await file.text()) as MatchRecord;
            if (!r.scenario || !Number.isInteger(r.tick) || r.tick < 0 || r.tick > 2000000 || !r.log || typeof r.profile !== "string" || typeof r.date !== "string") throw new Error("Invalid match file");
            const next = [{ ...r, id: crypto.randomUUID() }, ...records].slice(0, 10); localStorage.setItem(KEY, JSON.stringify(next)); setRecords(next);
          } catch (error) { setMessage(String(error)); }
        }} /></label>
        {message && <p role="status" className="my-2 text-xs">{message}</p>}
        {records.map((r) => <div key={r.id} className="mt-3 border-t border-white/20 pt-2 text-xs">
          <div>{String(r.scenario.map)} · {new Date(r.date).toLocaleString()} · {Math.floor(r.tick / 25)}s</div>
          <div className="mt-2 flex gap-2"><Button size="sm" onClick={() => load(r, false)}>Resume</Button><Button size="sm" onClick={() => load(r, true)}>Replay</Button>
            <Button size="sm" onClick={() => exportRecord(r)}>Export</Button><Button size="sm" onClick={() => { const next = records.filter((x) => x.id !== r.id); localStorage.setItem(KEY, JSON.stringify(next)); setRecords(next); }}>Delete</Button></div>
        </div>)}
        {!records.length && <p className="mt-3 text-xs">No saved matches yet.</p>}
      </div>
    </div>}
  </>;
}
