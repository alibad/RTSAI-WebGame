import { useEffect, useRef, useState } from "react";
import { Keyboard, Mic, MousePointer2, RotateCcw, Settings as SettingsIcon, Sparkles, Volume2 } from "lucide-react";
import type { Game } from "../game";
import { COMMAND_KEYS, RESERVED_KEYS, defaults, preferences, savePreferences, type Command, type Preferences } from "../preferences";
import { readVoiceLanguage, normalizeVoiceLanguage } from "../voice-language";
import { useStore } from "../store";
import { companionDeveloperTools } from "../companion-policy";
import { Button } from "../components/ui/button";
import { OptionSelect } from "../components/ui/fields";
import { GameButton, GameDialog, GameSection } from "./kit/game";
import { Segmented, Toggle } from "./screen-parts";

/** The rebindable commands, with Red Alert 2's keys as defaults (preferences.ts). */
const COMMANDS: [Command, string][] = [["deploy", "Deploy"], ["guard", "Guard"], ["stop", "Stop"], ["scatter", "Scatter"], ["attackmove", "Attack move"],
  ["repair", "Repair"], ["sell", "Sell"], ["typeselect", "Select matching units"], ["selectall", "Select all units"]];
const ASSIST = [{ value: "off", label: "Off" }, { value: "suggest", label: "Suggest orders" }, { value: "auto", label: "Apply automatically" }] as const;
const ASSIST_HINT = { off: "Battlefield tips and recommended orders are turned off.", suggest: "You stay in control. Review each order, then press J or Apply.", auto: "The adviser carries out recommended orders for you without asking." };

/** One tab per kind of setting, so each fits without scrolling. The last one opened is shown next time. */
const TABS = [{ id: "sound", label: "Sound", icon: <Volume2 size={15} aria-hidden="true" /> }, { id: "controls", label: "Controls", icon: <Keyboard size={15} aria-hidden="true" /> },
  { id: "adviser", label: "Adviser", icon: <Sparkles size={15} aria-hidden="true" /> }] as const;
type Tab = (typeof TABS)[number]["id"];
let lastTab: Tab = "sound";

function Slider({ label, value, min = 0, max = 1, onChange }: { label: string; value: number; min?: number; max?: number; onChange: (value: number) => void }) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <label className="settings-slider">
      <span>{label}<b>{Math.round(value * 100)}%</b></span>
      <input aria-label={label} type="range" min={min} max={max} step={max === 1 ? "0.01" : "0.05"} value={value} style={{ "--fill": `${fill}%` } as React.CSSProperties} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function GameSettings({ game }: { game: Game }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({ ...preferences });
  const [error, setError] = useState("");
  const [language, setLanguage] = useState(readVoiceLanguage);
  const [tab, setTab] = useState<Tab>(lastTab);
  const [lock, setLock] = useState(game.lock.enabled);
  const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  function show(next: Tab) { lastTab = next; setTab(next); }
  function mouseLock(on: boolean) { game.setMouseLock(on); setLock(on); }
  const playing = useStore((s) => s.phase === "playing");
  const assist = useStore((s) => (s.cc.enabled ? (s.cc.auto ? "auto" : "suggest") : "off"));
  const [assistNote, setAssistNote] = useState("");
  function setAssist(value: "off" | "suggest" | "auto") {
    game.cc.setAuto(value === "auto");
    const now = game.setCoCommander(value !== "off");
    setAssistNote(now ? "" : "Starts with your next match.");
  }
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);
  async function updateLanguage(value: string) {
    const current = ++revision.current;
    const selected = normalizeVoiceLanguage(value); setLanguage(selected);
    const result = await game.client.voiceLanguage(selected);
    if (current === revision.current) setError(result.error ?? "");
  }
  function update(next: Partial<Preferences>) { savePreferences(next); setValues({ ...preferences }); game.audio.applyVolumes(); }
  function bind(command: Command, letter: string) {
    const next = letter.toLowerCase();
    if (!/^[a-z]$/.test(next)) return;
    const taken = COMMANDS.some(([other]) => other !== command && (values.bindings[other] ?? COMMAND_KEYS[other]) === next) || RESERVED_KEYS.includes(next);
    if (taken) { setError(`“${next.toUpperCase()}” is already used. Choose another key.`); return; }
    setError(""); update({ bindings: { ...values.bindings, [command]: next } });
  }
  function close() { setOpen(false); setError(""); }
  // The voice bus carries the campaign's radio calls, and the co-commander's spoken replies where it can speak.
  const volumes = [["master", "Master volume"], ["effects", "Effects volume"], ["music", "Music volume"],
    ["voice", companionDeveloperTools ? "Radio and companion voices" : "Radio voices"]] as const;
  return <>
    <Button size="sm" variant="outline" aria-label="Settings" onClick={() => { setValues({ ...preferences }); setLock(game.lock.enabled); setOpen(true); }}><SettingsIcon size={14} aria-hidden="true" />Settings</Button>
    {open && <GameDialog eyebrow="Settings" title="Game settings" onClose={close} footer={<>
      <GameButton variant="ghost" size="sm" icon={<RotateCcw size={14} />} onClick={() => { update({ ...defaults, bindings: {} }); void updateLanguage("faction"); setAssist("suggest"); mouseLock(true); setError(""); }}>Reset settings</GameButton>
      <GameButton variant="primary" onClick={close}>Done</GameButton>
    </>}>
        <div className="settings-tabs" role="tablist" aria-label="Settings">
          {TABS.map((t) => <button key={t.id} type="button" role="tab" id={`settings-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="settings-panel" onClick={() => show(t.id)}>{t.icon}{t.label}</button>)}
        </div>
        <div className="settings-tabpanel" role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${tab}`}>
          {tab === "sound" && <>
            <GameSection icon={<Volume2 size={15} />} title="Volume">
              {volumes.map(([key, label]) => <Slider key={key} label={label} value={values[key]} onChange={(value) => update({ [key]: value })} />)}
            </GameSection>
            <GameSection icon={<Mic size={15} />} title="Unit voices">
              <label className="settings-row">
                <span>Language<small>Units use their original recording when a translation is unavailable.</small></span>
                <OptionSelect aria-label="Unit voice language" value={language} onValueChange={(value) => void updateLanguage(value)}
                  options={[{ value: "faction", label: "Nation’s language" }, { value: "en", label: "English" }]} />
              </label>
              {playing && <GameButton size="sm" className="mt-3" onClick={() => { const current = ++revision.current; void game.client.previewVoice().then((result) => { if (current === revision.current) setError(String(result.error ?? (result.played ? "" : "Voice audio is loading. Preview again shortly."))); }); }}>Preview selected unit voice</GameButton>}
            </GameSection>
          </>}
          {tab === "controls" && <>
            <GameSection icon={<MousePointer2 size={15} />} title="Mouse and camera">
              <Slider label="Camera scroll speed" value={values.scroll} min={0.25} max={3} onChange={(scroll) => update({ scroll })} />
              {!touch && <Toggle label={<>Keep the mouse in the game<small className="settings-toggle-hint">The map scrolls at the screen edges. Esc releases the mouse.</small></>} checked={lock} onChange={mouseLock} />}
            </GameSection>
            <GameSection icon={<Keyboard size={15} />} title="Command keys">
              <div className="settings-keys">
                {COMMANDS.map(([key, label]) => (
                  <label key={key} className="settings-key">
                    <span>{label}</span>
                    <input aria-label={`${label} key`} className="keycap" value={(values.bindings[key] ?? COMMAND_KEYS[key]).toUpperCase()} maxLength={1} readOnly
                      onKeyDown={(e) => { if (e.key.length === 1) { e.preventDefault(); bind(key, e.key); } }} onFocus={(e) => e.currentTarget.select()} />
                  </label>
                ))}
              </div>
              <p className="settings-hint">Select a key, then press a letter to change it. Attack move sends units to a destination while fighting enemies along the way; you can also use Ctrl+Shift+click.</p>
            </GameSection>
          </>}
          {tab === "adviser" && <GameSection icon={<Sparkles size={15} />} title="Built-in adviser">
            <div className="settings-row">
              <span>Recommendations<small>{assistNote || ASSIST_HINT[assist]}</small></span>
              <Segmented label="Adviser orders" value={assist} options={ASSIST} onChange={setAssist} />
            </div>
          </GameSection>}
        </div>
        {error && <p role="status" className="settings-error">{error}</p>}
    </GameDialog>}
  </>;
}
