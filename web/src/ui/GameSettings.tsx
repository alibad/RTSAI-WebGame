import { useState } from "react";
import type { Game } from "../game";
import { defaults, preferences, savePreferences, type Preferences } from "../preferences";
import { Button } from "../components/ui/button";

export function GameSettings({ game }: { game: Game }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({ ...preferences });
  const [error, setError] = useState("");
  function update(next: Partial<Preferences>) { savePreferences(next); setValues({ ...preferences }); game.audio.applyVolumes(); }
  return <>
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Settings</Button>
    {open && <div className="fixed inset-0 z-50 grid place-items-center bg-black/70" role="dialog" aria-modal="true" aria-label="Game settings">
      <div className="hud-panel max-h-[85vh] w-[min(460px,95vw)] overflow-auto p-4">
        <div className="mb-4 flex justify-between"><strong>Game settings</strong><Button size="sm" onClick={() => setOpen(false)}>Close</Button></div>
        {([["master", "Master volume"], ["effects", "Effects volume"], ["music", "Music volume"], ["voice", "Companion voice"], ["scroll", "Camera scroll speed"]] as const).filter(([key]) => key !== "voice" || import.meta.env.VITE_STATIC_BUILD !== "1").map(([key, label]) =>
          <label key={key} className="mb-3 block text-xs">{label} · {Math.round(values[key] * 100)}%
            <input aria-label={label} type="range" min={key === "scroll" ? 0.25 : 0} max={key === "scroll" ? 3 : 1} step="0.05" value={values[key]} className="mt-1 block w-full" onChange={(e) => update({ [key]: Number(e.target.value) })} />
          </label>)}
        <p className="mb-2 text-xs">Command keys · choose a letter for each action</p>
        {([["a", "Attack move"], ["d", "Guard"], ["f", "Deploy"], ["s", "Stop"], ["c", "Repair"], ["z", "Sell"], ["p", "Pause"]] as const).map(([key, label]) =>
          <label key={key} className="mb-2 flex items-center justify-between text-xs">{label}<input aria-label={`${label} key`} className="hud-inset w-12 p-1 text-center" value={values.bindings[key] ?? key} maxLength={1} onChange={(e) => {
            const next = e.target.value.toLowerCase();
            if (!/^[a-z]$/.test(next)) return;
            const keys = ["a", "d", "f", "s", "c", "z", "p"];
            if (keys.some((other) => other !== key && (values.bindings[other] ?? other) === next) || "ertyuibhqw".includes(next)) { setError("That key is already assigned. Choose another letter."); return; }
            setError(""); update({ bindings: { ...values.bindings, [key]: next } });
          }} /></label>)}
        {error && <p role="status" className="my-2 text-xs text-red-400">{error}</p>}
        <Button size="sm" onClick={() => { update({ ...defaults, bindings: {} }); setError(""); }}>Reset settings</Button>
      </div>
    </div>}
  </>;
}
