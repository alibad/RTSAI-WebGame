// Every actor's display name, from the mod's own Fluent messages in the downloaded game data: the strings the engine's
// Tooltip traits name ("actor-gacnst-name = Construction Yard", "levant-r2hzbunker-name = …"). The engine lists names
// only for the local player's build menu and for buildable units (Ui.cs Catalog, UnitCatalog); the HUD names every other
// actor with these: the Construction Yard (never in a build menu), the other side's buildings, neutral ones.

/** Pack file names of the Fluent files the game's mod loads, in its load order (later files override earlier ones). */
export function fluentFiles(names: string[], read: (name: string) => string): string[] {
  const mods = new Map<string, string>();
  for (const name of names) {
    const m = /^mods\/([^/]+)\/mod\.yaml$/.exec(name);
    if (m) mods.set(m[1], read(name));
  }
  // The mod the game runs is the one no other mod builds on ("$rtsai: ra2" in rtsai-topdown's packages).
  const top = [...mods.keys()].find((id) => ![...mods].some(([other, yaml]) => other !== id && yaml.includes(`$${id}:`))) ?? [...mods.keys()][0];
  if (!top) return [];
  const lines = mods.get(top)!.split(/\r?\n/);
  const roots = new Map<string, string>();
  for (const line of lines) {
    const own = /^\s+\$([\w.-]+):\s*([\w.-]+)\s*$/.exec(line);
    if (own) roots.set(own[2], `mods/${own[1]}/`);
    const engine = /^\s+\^EngineDir\|(\S+?):\s*([\w.-]+)\s*$/.exec(line);
    if (engine) roots.set(engine[2], `ora/${engine[1]}/`);
  }
  const start = lines.findIndex((l) => /^FluentMessages:\s*$/.test(l));
  const files: string[] = [];
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) break;
    const entry = line.trim();
    const bar = entry.indexOf("|");
    const path = bar < 0 ? entry : entry.slice(bar + 1);
    const root = bar < 0 ? undefined : roots.get(entry.slice(0, bar));
    const file = root && names.includes(root + path) ? root + path : names.find((n) => n.endsWith(`/${path}`));
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

/** Actor type -> name from Fluent files in load order: every single-line "<prefix>-<actor>-name = Name" message. */
export function fluentActorNames(texts: string[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const text of texts)
    for (const line of text.split(/\r?\n/)) {
      const m = /^[a-z0-9]+-([a-z0-9][a-z0-9-]*?)-name\s*=\s*([^{}\s][^{}]*?)\s*$/.exec(line);
      if (m) names[m[1]] = m[2];
    }
  return names;
}
