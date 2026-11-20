// Save, open and share a battle setup (battle-setups.ts): three buttons in the simulator's setup panel.
// - Save battle: the setup joins "My battles" in this browser.
// - My battles: every saved setup as a card (its map, who fights whom, how many); click one to lay it out again.
// - Copy link: the setup as a link into the simulator, for anyone (rtsai.net/play/?mode=sandbox&s=...).
// The owner's pick from the old website Workshop (16 Nov 2026): "save and copy a battle setup".

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, FolderOpen, Link2, Map as MapIcon, Save, Trash2, X } from "lucide-react";
import type { Game } from "../game";
import type { Sandbox } from "../sandbox";
import { keepSetup, removeSetup, savedSetups, setupCounts, setupId, setupLink, type BattleSetup } from "../battle-setups";
import { useStore } from "../store";
import { Flag } from "./Flag";
import { GameButton } from "./kit/game";
import "./maker.css";

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* no clipboard permission: the old way */ }
  const area = document.createElement("textarea");
  area.value = text; area.style.cssText = "position:fixed;opacity:0";
  document.body.append(area); area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* refused */ }
  area.remove();
  return ok;
}

function Card({ game, setup, open, changed }: { game: Game; setup: BattleSetup; open: (s: BattleSetup) => void; changed: () => void }) {
  const preview = useStore((s) => s.previews[setup.map]);
  const here = useStore((s) => !!s.setup?.maps.some((m) => m.id === setup.map));
  const nations = useStore((s) => s.setup?.factions);
  const [name, setName] = useState(setup.name);
  const [copied, setCopied] = useState(false);
  const [a, b] = setupCounts(setup);
  useEffect(() => { if (here) game.preview(setup.map); }, [game, here, setup.map]);
  const nameOf = (id: string) => nations?.find((f) => f.id === id)?.name ?? id;
  const usable = here || !!setup.gen;
  return (
    <div className="bs-card" data-testid="bs-card">
      <button type="button" className="bs-open" data-sfx-hover disabled={!usable} title={usable ? "Lay this battle out" : "This battle's map is no longer in this browser"} onClick={() => open({ ...setup, name })}>
        <span className="bs-art">{preview ? <img src={preview} alt="" draggable={false} /> : <MapIcon size={22} strokeWidth={1.4} aria-hidden="true" />}</span>
        <span className="bs-sides" aria-label={`${nameOf(setup.fa)} ${a} against ${nameOf(setup.fb)} ${b}`}>
          <Flag id={setup.fa} className="h-[14px] w-[22px] rounded-[1px]" /><span className="digits">{a}</span><i>VS</i><span className="digits">{b}</span><Flag id={setup.fb} className="h-[14px] w-[22px] rounded-[1px]" />
        </span>
        <span className="bs-meta">{setup.mapTitle} · {day(setup.savedAt)}{usable ? "" : " · map missing"}</span>
      </button>
      <div className="bs-tools">
        <input className="bs-name" value={name} aria-label="Name of this battle" maxLength={60} onChange={(e) => setName(e.target.value)}
          onBlur={() => { const next = name.trim() || setup.name; setName(next); if (next !== setup.name) { keepSetup({ ...setup, name: next }); changed(); } }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); e.stopPropagation(); }} />
      </div>
      <div className="bs-tools">
        <button type="button" onClick={() => void copyText(setupLink(setup)).then((ok) => { setCopied(ok); setTimeout(() => setCopied(false), 1800); })}>{copied ? <Check size={13} /> : <Link2 size={13} />}{copied ? "Copied" : "Copy link"}</button>
        <button type="button" className="is-danger" onClick={() => { removeSetup(setup.id); changed(); }}><Trash2 size={13} />Delete</button>
      </div>
    </div>
  );
}

export function BattleSetups({ game, sandbox }: { game: Game; sandbox: Sandbox }) {
  const [list, setList] = useState(savedSetups);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<{ text: string; warn?: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const nations = useStore((s) => s.setup?.factions);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = (text: string, warn = false) => {
    setNote({ text, warn });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), 7000);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  const nameOf = (id: string) => nations?.find((f) => f.id === id)?.name ?? id;

  const save = async () => {
    const snap = await sandbox.snapshot();
    if (!snap.placements.length) { say("Place something first: an empty battlefield has nothing to save.", true); return; }
    const ok = keepSetup({ id: setupId(), name: `${nameOf(snap.fa)} vs ${nameOf(snap.fb)}`, savedAt: Date.now(), ...snap });
    setList(savedSetups());
    say(ok ? "Saved to My battles, in this browser." : "This browser refused to store the battle.", !ok);
  };
  const copy = async () => {
    const snap = await sandbox.snapshot();
    if (!snap.placements.length) { say("Place something first: an empty battlefield has nothing to share.", true); return; }
    const ok = await copyText(setupLink(snap));
    setCopied(ok); setTimeout(() => setCopied(false), 1800);
    say(!ok ? "The browser refused the clipboard." : snap.own ? "Link copied. Its map was made in this browser, so the link opens the battle on this device only." : "Link copied: it opens this battle for anyone.", !ok || !!snap.own);
  };
  const lay = async (s: BattleSetup) => {
    setOpen(false);
    try {
      const { missing } = await sandbox.restore(s);
      say(missing ? `Opened "${s.name}". ${missing} ${missing === 1 ? "unit" : "units"} no longer fit on this map.` : `Opened "${s.name}".`, missing > 0);
    } catch (e) { say(e instanceof Error ? e.message : String(e), true); }
  };

  return (
    <>
      <div className="bs-row" data-testid="bs-row">
        <GameButton size="sm" icon={<Save size={13} />} onClick={() => void save()} data-testid="bs-save">Save</GameButton>
        <GameButton size="sm" icon={<FolderOpen size={13} />} onClick={() => { setList(savedSetups()); setOpen(true); }} data-testid="bs-open">My battles{list.length ? ` · ${list.length}` : ""}</GameButton>
        <GameButton size="sm" icon={copied ? <Check size={13} /> : <Link2 size={13} />} onClick={() => void copy()} data-testid="bs-copy">{copied ? "Copied" : "Copy link"}</GameButton>
      </div>
      {note && createPortal(<p className={note.warn ? "bs-toast is-warn" : "bs-toast"} role="status" data-testid="bs-note">{note.text}</p>, document.body)}
      {open && createPortal(
        <div className="rm-scrim" role="dialog" aria-modal="true" aria-label="My battles" onClick={() => setOpen(false)} data-ui-sfx>
          <div className="rm-panel hud-panel" style={{ width: `min(${list.length <= 1 ? 460 : list.length === 2 ? 600 : 860}px, 100%)` }} onClick={(e) => e.stopPropagation()} data-testid="bs-dialog">
            <header><b>My battles</b><button type="button" aria-label="Close" onClick={() => setOpen(false)}><X size={16} /></button></header>
            {list.length === 0
              ? <p className="bs-empty">No saved battles yet.<br />Set one up, then press <b>Save</b>: it is kept in this browser and opens here again with one click.</p>
              : <div className="bs-list">{list.map((s) => <Card key={s.id} game={game} setup={s} open={(x) => void lay(x)} changed={() => setList(savedSetups())} />)}</div>}
            <p className="rm-note">Saved battles live in this browser. <b>Copy link</b> gives a battle to anyone: a random map travels with it, a map you made yourself stays on this device.</p>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
