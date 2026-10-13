import { useEffect, useRef, useState } from "react";
import { Keyboard, Mic, RotateCcw, Settings as SettingsIcon, Volume2 } from "lucide-react";
import type { Game } from "../game";
import { defaults, preferences, savePreferences, type Preferences } from "../preferences";
import { readVoiceLanguage, normalizeVoiceLanguage } from "../voice-language";
import { useStore } from "../store";
import { Button } from "../components/ui/button";
import { GameButton, GameDialog, GameSection } from "./kit/game";

const COMMANDS = [["a", "Attack move"], ["d", "Guard"], ["f", "Deploy"], ["s", "Stop"], ["c", "Repair"], ["z", "Sell"], ["p", "Pause"]] as const;
/** Letters the HUD already uses for other commands. */
const RESERVED = "ertyuibhqwg";

function Slider({ label, value, min = 0, max = 1, onChange }: { label: string; value: number; min?: number; max?: number; onChange: (value: number) => void }) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <label className="settings-slider">
      <span>{label}<b>{Math.round(value * 100)}%</b></span>
      <input aria-label={label} type="range" min={min} max={max} step="0.05" value={value} style={{ "--fill": `${fill}%` } as React.CSSProperties} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function GameSettings({ game }: { game: Game }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({ ...preferences });
  const [error, setError] = useState("");
  const [language, setLanguage] = useState(readVoiceLanguage);
  const playing = useStore((s) => s.phase === "playing");
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);
  async function updateLanguage(value: string) {
    const current = ++revision.current;
    const selected = normalizeVoiceLanguage(value); setLanguage(selected);
    const result = await game.client.voiceLanguage(selected);
    if (current === revision.current) setError(result.error ?? "");
  }
  function update(next: Partial<Preferences>) { savePreferences(next); setValues({ ...preferences }); game.audio.applyVolumes(); }
  function bind(command: string, letter: string) {
    const next = letter.toLowerCase();
    if (!/^[a-z]$/.test(next)) return;
    const taken = COMMANDS.some(([other]) => other !== command && (values.bindings[other] ?? other) === next) || RESERVED.includes(next);
    if (taken) { setError(`“${next.toUpperCase()}” is already used. Choose another key.`); return; }
    setError(""); update({ bindings: { ...values.bindings, [command]: next } });
  }
  function close() { setOpen(false); setError(""); }
  const volumes = ([["master", "Master volume"], ["effects", "Effects volume"], ["music", "Music volume"], ["voice", "Companion voice"]] as const)
    .filter(([key]) => key !== "voice" || import.meta.env.VITE_STATIC_BUILD !== "1");
  return <>
    <Button size="sm" variant="outline" aria-label="Settings" onClick={() => setOpen(true)}><SettingsIcon size={14} aria-hidden="true" />Settings</Button>
    {open && <GameDialog eyebrow="Settings" title="Game settings" onClose={close} footer={<>
      <GameButton variant="ghost" size="sm" icon={<RotateCcw size={14} />} onClick={() => { update({ ...defaults, bindings: {} }); void updateLanguage("faction"); setError(""); }}>Reset settings</GameButton>
      <GameButton variant="primary" onClick={close}>Done</GameButton>
    </>}>
        <GameSection icon={<Volume2 size={15} />} title="Sound">
          {volumes.map(([key, label]) => <Slider key={key} label={label} value={values[key]} onChange={(value) => update({ [key]: value })} />)}
        </GameSection>
        <GameSection icon={<Mic size={15} />} title="Unit voices">
          <label className="settings-row">
            <span>Language<small>Falls back to the original voice.</small></span>
            <select aria-label="Unit voice language" className="settings-select" value={language} onChange={(e) => void updateLanguage(e.target.value)}>
              <option value="faction">Faction language</option><option value="en">English</option>
            </select>
          </label>
          {playing && <GameButton size="sm" className="mt-3" onClick={() => { const current = ++revision.current; void game.client.previewVoice().then((result) => { if (current === revision.current) setError(String(result.error ?? (result.played ? "" : "Voice audio is loading. Preview again shortly."))); }); }}>Preview selected unit voice</GameButton>}
        </GameSection>
        <GameSection icon={<Keyboard size={15} />} title="Controls">
          <Slider label="Camera scroll speed" value={values.scroll} min={0.25} max={3} onChange={(scroll) => update({ scroll })} />
          <div className="settings-keys">
            {COMMANDS.map(([key, label]) => (
              <label key={key} className="settings-key">
                <span>{label}</span>
                <input aria-label={`${label} key`} className="keycap" value={(values.bindings[key] ?? key).toUpperCase()} maxLength={1} readOnly
                  onKeyDown={(e) => { if (e.key.length === 1) { e.preventDefault(); bind(key, e.key); } }} onFocus={(e) => e.currentTarget.select()} />
              </label>
            ))}
          </div>
          <p className="settings-hint">Click a key, then press the letter you want.</p>
        </GameSection>
        {error && <p role="status" className="settings-error">{error}</p>}
    </GameDialog>}
  </>;
}
