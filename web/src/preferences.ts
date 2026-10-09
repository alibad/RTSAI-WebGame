export interface Preferences { master: number; effects: number; music: number; voice: number; scroll: number; bindings: Record<string, string> }
export const defaults: Preferences = { master: 1, effects: 1, music: 1, voice: 1, scroll: 1, bindings: {} };
function read(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem("rtsai.preferences.v1") ?? "{}");
    const value = { ...defaults, ...saved };
    value.bindings = Object.fromEntries(Object.entries(value.bindings ?? {}).filter(([, key]) => key !== "g"));
    for (const key of ["master", "effects", "music", "voice", "scroll"] as const)
      value[key] = Number.isFinite(value[key]) ? Math.max(0, Math.min(key === "scroll" ? 3 : 1, value[key])) : defaults[key];
    return value;
  } catch { return { ...defaults }; }
}
export const preferences = read();
export function savePreferences(next: Partial<Preferences>) { Object.assign(preferences, next); localStorage.setItem("rtsai.preferences.v1", JSON.stringify(preferences)); }
const translated = new WeakSet<KeyboardEvent>();
for (const type of ["keydown", "keyup"] as const) window.addEventListener(type, (event) => {
  if (translated.has(event) || event.ctrlKey || event.altKey || event.metaKey || (event.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable]")) return;
  const canonical = Object.entries(preferences.bindings).find(([, key]) => key === event.key.toLowerCase())?.[0];
  if (!canonical) {
    const current = event.key.toLowerCase();
    if (preferences.bindings[current] && preferences.bindings[current] !== current) { event.preventDefault(); event.stopImmediatePropagation(); }
    return;
  }
  if (canonical === event.key.toLowerCase()) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const replacement = new KeyboardEvent(type, { key: canonical, code: `Key${canonical.toUpperCase()}`, shiftKey: event.shiftKey, bubbles: true, cancelable: true, repeat: event.repeat });
  translated.add(replacement); window.dispatchEvent(replacement);
}, true);
