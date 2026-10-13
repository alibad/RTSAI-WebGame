/**
 * Rebindable commands and their default keys: Red Alert 2's own (the RA2 manual, "Keyboard Commands"), so D deploys,
 * G guards, X scatters, K repairs, L sells, T selects a type and P selects all. Attack move is RA2's Ctrl+Shift+click;
 * A is kept as a key for it (RA2's A is the alliance key, which this game has no use for). game.ts keyDown reads these
 * default letters; a player's own binding is translated to them below.
 */
export const COMMAND_KEYS = { deploy: "d", guard: "g", stop: "s", scatter: "x", attackmove: "a", repair: "k", sell: "l", typeselect: "t", selectall: "p" } as const;
export type Command = keyof typeof COMMAND_KEYS;

export interface Preferences { master: number; effects: number; music: number; voice: number; scroll: number; bindings: Partial<Record<Command, string>>; keymap?: number }
export const defaults: Preferences = { master: 1, effects: 1, music: 1, voice: 1, scroll: 1, bindings: {}, keymap: 2 };

/** The key a command answers to: the player's binding, else RA2's. */
export const keyFor = (command: Command) => preferences.bindings[command] ?? COMMAND_KEYS[command];

/** Bindings saved before keymap 2 were keyed by OpenRA's default letters (A attack move, D guard, F deploy, ...). */
const OPENRA_LETTERS: Record<string, Command> = { a: "attackmove", d: "guard", f: "deploy", s: "stop", c: "repair", z: "sell" };
/** Letters the game uses outside the rebindable commands (game.ts keyDown); a binding may not take them. */
export const RESERVED_KEYS = "qwerfhbjmnvz";

function migrate(old: Record<string, string>) {
  const bindings: Partial<Record<Command, string>> = {};
  for (const [letter, key] of Object.entries(old)) {
    const command = OPENRA_LETTERS[letter];
    if (command && /^[a-z]$/.test(key) && key !== COMMAND_KEYS[command]) bindings[command] = key;
  }
  // Keep only bindings that clash with nothing under the new defaults.
  const taken = (command: Command, key: string) => RESERVED_KEYS.includes(key)
    || (Object.keys(COMMAND_KEYS) as Command[]).some((other) => other !== command && (bindings[other] ?? COMMAND_KEYS[other]) === key);
  return Object.fromEntries(Object.entries(bindings).filter(([command, key]) => !taken(command as Command, key!)));
}

function read(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem("rtsai.preferences.v1") ?? "{}");
    const value = { ...defaults, ...saved };
    value.bindings = saved.keymap === 2
      ? Object.fromEntries(Object.entries(value.bindings ?? {}).filter(([command, key]) => command in COMMAND_KEYS && /^[a-z]$/.test(String(key))))
      : migrate(value.bindings ?? {});
    value.keymap = 2;
    for (const key of ["master", "effects", "music", "voice", "scroll"] as const)
      value[key] = Number.isFinite(value[key]) ? Math.max(0, Math.min(key === "scroll" ? 3 : 1, value[key])) : defaults[key];
    return value;
  } catch { return { ...defaults }; }
}
export const preferences = read();
export function savePreferences(next: Partial<Preferences>) { Object.assign(preferences, next, { keymap: 2 }); localStorage.setItem("rtsai.preferences.v1", JSON.stringify(preferences)); }

// A rebound key is delivered to the game as the command's default key; the default key itself, once given to another
// command's binding or moved away, does nothing.
const translated = new WeakSet<KeyboardEvent>();
for (const type of ["keydown", "keyup"] as const) window.addEventListener(type, (event) => {
  if (translated.has(event) || event.ctrlKey || event.altKey || event.metaKey || (event.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable]")) return;
  const pressed = event.key.toLowerCase();
  const command = (Object.keys(COMMAND_KEYS) as Command[]).find((c) => keyFor(c) === pressed);
  if (!command) {
    if ((Object.keys(COMMAND_KEYS) as Command[]).some((c) => COMMAND_KEYS[c] === pressed)) { event.preventDefault(); event.stopImmediatePropagation(); }
    return;
  }
  const canonical = COMMAND_KEYS[command];
  if (canonical === pressed) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const replacement = new KeyboardEvent(type, { key: canonical, code: `Key${canonical.toUpperCase()}`, shiftKey: event.shiftKey, bubbles: true, cancelable: true, repeat: event.repeat });
  translated.add(replacement); window.dispatchEvent(replacement);
}, true);
