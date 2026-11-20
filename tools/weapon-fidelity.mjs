// Weapon fidelity: how every weapon in RTS AI fires, flies, lands and looks, measured in the engine and held to numbers.
//
// The engine part is `websim weaponaudit` (sim/OpenRA.WebSim.Native/WeaponAudit.cs): every armed roster unit of every
// country, at its first rank and at elite where that changes its guns, fires each weapon through a real attack order at
// a standard target (a heavy tank, else a soldier, a building, a ship or an aircraft) at short, medium and maximum
// range in four directions, plus once at a target driving across. It records, tick by tick, the barrel tips, the muzzle
// overlay, every projectile and beam (beams by the light the page actually draws), every sprite effect, the damage.
// This tool turns that into checks with thresholds, compares each weapon with Red Alert 2 (tools/data/ra2-weapon-look.json:
// its projectile, muzzle animation and laser flags), names the cause of each failure and ranks the causes by how many
// units they hit.
//
//   node tools/weapon-fidelity.mjs --raw <weaponaudit.json> [--out <dir>] [--baseline <json>] [--write-baseline]
//   node tools/weapon-fidelity.mjs --websim <websim.exe> --root <unpacked bundle> [--factions a,b] [--out <dir>]
//
// The exit code is the number of findings not in the baseline (tools/data/weapon-fidelity-baseline.json), so a release
// cannot bring a fixed fault back or add a new one unnoticed. tools/gameplay-check.mjs runs it on every data release.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every threshold in one place. Screen distances are pixels at 1x zoom. */
export const T = {
  hitMarginPx: 6, // a shot lands inside the target's box, give or take this
  hitShare: 0.9, // of shots at a standing target
  movingMissPx: 30, // half a cell: a shell that lands farther from a target driving across has missed it
  movingHitShare: 0.5,
  muzzleTipPx: 6, // the flash is drawn at the barrel tip
  muzzleAreaShare: 0.6, // a flash covering more of the unit than this looks like the unit is hit
  launchEffectPx: 30,
  impactAreaShare: 1.6, // an impact effect this much bigger than the target's box reads as the target dying
  beamContrast: 0.25, // brightness difference from grass at the beam's brightest point
  beamWidthPx: 3, // width that keeps at least that contrast, on the first frame
  beamTicks: 8, // a beam stays on screen at least this long
  visibleShare: 0.5, // a shell or missile is drawn for at least half its flight
  projectilePx: 3, // and is at least this big
};

const BEAMS = new Set(["LaserZap", "OriginalRa2Laser", "RadBeam", "ElectricBolt", "ArcLaserZap", "Railgun", "AreaBeam"]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const inRect = (p, r, m = 0) => !!r && p[0] >= r[0] - m && p[0] <= r[0] + r[2] + m && p[1] >= r[1] - m && p[1] <= r[1] + r[3] + m;
const area = (r) => (r ? r[2] * r[3] : 0);

/** The Red Alert 2 weapon an original-country weapon copies, or the closest kind for a modern one. */
export function ra2For(weapon, facts, look) {
  const own = look.weapons[weapon.replace(/^ea-retail-/, "").replace(/^retail/, "")];
  if (weapon.startsWith("ea-retail-") && own) return { ...own, exact: true, damage: Number(own.damage ?? facts.damage ?? 0) };
  // A modern copy of an RA2 weapon (the stand-in Flak Track's flaktrackaagun) is held to that weapon's own impacts.
  if (own) return { ...own, exact: false, damage: Number(facts.damage ?? own.damage ?? 0) };
  const p = facts.projectile;
  const image = facts.fields?.Image;
  const damage = Number(facts.damage ?? 0);
  // A modern weapon is held to the closest RA2 kind: its impact to that kind's generic warhead (HE, AP or SA).
  if (BEAMS.has(p) || p === "OriginalRa2Action") return { kind: "laser", muzzle: null, exact: false, damage };
  if (p === "Missile" || p === "OriginalRa2Rocket") return { kind: "missile", muzzle: null, exact: false, impact: look.warheads?.HE, damage };
  if (p === "GravityBomb") return { kind: "bomb", muzzle: null, exact: false, impact: look.warheads?.HE, damage };
  // Artillery and naval guns (long range or a high arc) land with RA2's general explosive list, tank guns with its AP one.
  const artillery = (facts.range ?? 0) >= 9 * 1024 || Number(String(facts.fields?.LaunchAngle ?? "0").split(",")[0]) >= 100;
  if (p === "Bullet" && image) return { kind: "shell", muzzle: "GUNFIRE", exact: false, impact: artillery ? look.warheads?.HE : look.warheads?.AP, damage };
  return { kind: "invisible", muzzle: "GUNFIRE", exact: false, impact: look.warheads?.SA, damage };
}

/** The animation RA2 plays for a hit: its warhead's AnimList entry for the damage, in bands of 25 (ModEnc "AnimList"). */
export function ra2Impact(ra2, look) {
  const list = (ra2.impact ?? "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (!list.length || !(ra2.damage >= 1)) return null;
  const name = list[Math.min(Math.floor(ra2.damage / 25), list.length - 1)];
  return { name, visible: look.anims?.[name]?.visible ?? null };
}

/** Measurements of one trial: where each shot landed, what the muzzle and the impact drew, what flew. */
export function measureTrial(t, facts) {
  const tracks = t.tracks.map((k) => ({ kind: k.kind ?? k.Kind, type: k.type ?? k.Type, image: k.image ?? k.Image, weapon: k.weapon ?? k.Weapon, ticks: k.ticks ?? k.Ticks, visibleTicks: k.visibleTicks ?? k.VisibleTicks, ...k }));
  const projectiles = tracks.filter((k) => k.kind === "projectile" && k.weapon === t.weapon);
  const sprites = tracks.filter((k) => k.kind === "sprite" && k.end);
  // The weapon's own effect images (its warheads'): another sprite near the target, such as a ship's wake, is not its hit.
  const own = new Set((facts?.effects ?? []).map((e) => e.image).filter(Boolean));
  // ... and only its own explosions: a tank's coaxial gun is not credited with the main gun's blast beside it.
  const ownSeqs = new Set((facts?.effects ?? []).flatMap((e) => e.explosions ?? []));
  // With no effect images of its own, only an explosion counts (a dog's "impact" is otherwise its victim's death).
  const hits = sprites.filter((s) => (own.size ? own.has(s.image) || s.explosion : s.explosion) && !/watersplash/.test(s.sequences?.[0] ?? "")
    && (!ownSeqs.size || ownSeqs.has(s.sequences?.[0])));
  const path = new Map((t.victimPath ?? []).map((p) => [p[0], p]));
  const victimAt = (tick) => {
    if (!t.moving || path.size === 0) return { c: t.victimCentre, r: t.victimRect };
    let best = null;
    for (const [k, p] of path) if (best === null || Math.abs(k - tick) < Math.abs(best[0] - tick)) best = p;
    const dx = best[1] - t.victimCentre[0], dy = best[2] - t.victimCentre[1];
    return { c: [best[1], best[2]], r: t.victimRect && [t.victimRect[0] + dx, t.victimRect[1] + dy, t.victimRect[2], t.victimRect[3]] };
  };
  const shots = [];
  for (const k of projectiles) {
    const beam = BEAMS.has(k.type);
    // A missile still flying when the trial stops has not landed anywhere yet (the Aegis' late salvo).
    if (!beam && t.ticks != null && k.last >= t.ticks - 1) continue;
    // A beam strikes on its first tick and then fades; a shell or missile strikes when it is gone.
    const tick = beam ? k.first : k.last + 1;
    const near = (p) => hits.filter((s) => s.first >= tick - 2 && s.first <= tick + 2 && dist(s.end, p) < 60);
    // A shell lands where it was sent (unless blocked); a missile, bomb or beam where it ends.
    let at = k.type === "Bullet" && k.aim ? k.aim : k.end;
    if (!beam && k.type !== "Bullet") {
      const s = near(k.end).sort((a, b) => dist(a.end, k.end) - dist(b.end, k.end))[0];
      if (s) at = s.end;
    }
    if (!at) continue;
    const v = victimAt(tick);
    const effect = near(at).filter((s) => !inRect(s.end, t.shooterRect) || inRect(s.end, v.r)).sort((a, b) => dist(a.end, at) - dist(b.end, at))[0];
    shots.push({ tick, at, miss: Math.round(dist(at, v.c)), hit: inRect(at, v.r, T.hitMarginPx), effect: effect && { image: effect.image, sequence: effect.sequences?.[0], rect: effect.rect, share: +(area(effect.rect) / Math.max(1, area(v.r))).toFixed(2) } });
  }
  // A shot that hits at once leaves no projectile behind: its effect near the target after a shot is the impact.
  if (projectiles.length === 0 && t.fires.length > 0) {
    for (const f of t.fires.filter((f) => f.weapon === t.weapon)) {
      const s = hits.filter((s) => s.first >= f.tick && s.first <= f.tick + 4 && dist(s.end, t.victimCentre) < 60 && !inRect(s.end, t.shooterRect)).sort((a, b) => dist(a.end, t.victimCentre) - dist(b.end, t.victimCentre))[0];
      const v = victimAt(f.tick);
      if (s) shots.push({ tick: f.tick, at: s.end, miss: Math.round(dist(s.end, v.c)), hit: inRect(s.end, v.r, T.hitMarginPx), instant: true, effect: { image: s.image, sequence: s.sequences?.[0], rect: s.rect, share: +(area(s.rect) / Math.max(1, area(v.r))).toFixed(2) } });
      else if (t.damage > 0) shots.push({ tick: f.tick, at: v.c, miss: 0, hit: true, instant: true, effect: null });
    }
  }
  const muzzles = t.fires.filter((f) => f.weapon === t.weapon).map((f) => {
    const drawn = t.muzzles.filter((m) => m.tick >= f.tick && m.tick <= f.tick + 3);
    if (drawn.length) {
      const off = Math.min(...drawn.flatMap((m) => f.muzzles.map((tip) => dist(m.drawn, tip))));
      const m = drawn[0];
      return { kind: "overlay", off: Math.round(off), sequence: `${m.image}.${m.sequence}`, share: +(area(m.rect) / Math.max(1, area(t.shooterRect))).toFixed(2) };
    }
    const launch = sprites.find((s) => s.first >= f.tick && s.first <= f.tick + 3 && !s.explosion && Math.min(...f.muzzles.map((tip) => dist(s.end, tip))) < T.launchEffectPx);
    return launch ? { kind: "launch", off: 0, sequence: `${launch.image}.${launch.sequences?.[0]}`, share: +(area(launch.rect) / Math.max(1, area(t.shooterRect))).toFixed(2) } : { kind: "none" };
  });
  const impacts = shots.map((s) => s.at);
  const atShooter = sprites.filter((s) => s.explosion && inRect(s.end, t.shooterRect) && !inRect(s.end, t.victimRect) && impacts.every((p) => dist(s.end, p) > 40))
    .map((s) => `${s.image}.${s.sequences?.[0]}`);
  const flights = projectiles.filter((k) => ["Bullet", "Missile", "GravityBomb"].includes(k.type) && k.ticks >= 3)
    .map((k) => ({ ticks: k.ticks, visible: k.visibleTicks, px: k.rect ? Math.max(k.rect[2], k.rect[3]) : 0 }));
  // Beams only: a missile's smoke trail is not one.
  const beams = projectiles.filter((k) => BEAMS.has(k.type)).map((k) => {
    const drawn = (k.beams ?? []).filter((b) => b.light && !String(b.type).startsWith("Before"));
    const before = (k.beams ?? []).find((b) => String(b.type).startsWith("Before"))?.light ?? null;
    const first = drawn[0]?.light ?? null;
    const lit = drawn.filter((b) => b.light.peak >= T.beamContrast).length;
    return { type: k.type, first, before, litTicks: lit, ticks: k.ticks };
  });
  return { shots, muzzles, atShooter, flights, beams };
}

/** Checks per unit, rank and weapon; each failure carries the cause it shares with others. */
export function analyze(raw, look, baseline = { accepted: {} }) {
  const pairs = new Map();
  for (const t of raw.trials) {
    const key = `${t.unit}|${t.level}|${t.weapon}`;
    if (!pairs.has(key)) pairs.set(key, { unit: t.unit, level: t.level, weapon: t.weapon, factions: new Set(), trials: [] });
    const p = pairs.get(key);
    p.factions.add(t.faction);
    p.trials.push(t);
  }
  const findings = [];
  const results = [];
  for (const p of pairs.values()) {
    const facts = raw.weapons[p.weapon] ?? {};
    const ra2 = ra2For(p.weapon, facts, look);
    const family = p.weapon.startsWith("ea-retail-") || p.weapon.startsWith("retail") ? "original" : "modern";
    const t0 = p.trials[0];
    const kind = t0.shooterKind ?? "unit";
    const m = p.trials.map((t) => ({ t, m: measureTrial(t, facts) }));
    const fired = p.trials.some((t) => t.fires.some((f) => f.weapon === p.weapon));
    const special = !fired && (facts.projectile === "OriginalRa2Action" || !facts.projectile || /charge|warhead|jump|grab|targeting|patriot|skyshield|aasite/i.test(p.weapon));
    const checks = [];
    const add = (id, pass, value, cause, note) => checks.push({ id, pass, value, cause, note });
    if (!fired) add("fires", special, special ? "special weapon (no armament shot)" : "never fired in 9 trials", special ? null : "never fires at a standard target", "the battle-review session's");
    const still = m.filter((x) => !x.t.moving).flatMap((x) => x.m.shots);
    if (still.length) {
      const share = still.filter((s) => s.hit).length / still.length;
      add("hits", share >= T.hitShare, `${Math.round(share * 100)}% inside the target, median miss ${median(still.map((s) => s.miss))} px`, `${facts.projectile} lands off a standing target`);
    }
    const moving = m.filter((x) => x.t.moving).flatMap((x) => x.m.shots);
    if (moving.length) {
      const share = moving.filter((s) => s.hit || s.miss <= T.movingMissPx).length / moving.length;
      add("hitsMoving", share >= T.movingHitShare, `${Math.round(share * 100)}% within ${T.movingMissPx} px of a target driving across, median miss ${median(moving.map((s) => s.miss))} px`,
        `${facts.projectile}${facts.fields?.Speed ? ` at speed ${facts.fields.Speed}` : ""} aims where the target was`);
    }
    // A V3 or Dreadnought rocket is an actor, not an effect: the audit stops watching before it lands.
    const rocket = facts.projectile === "OriginalRa2Rocket";
    if (fired && !rocket && p.trials.every((t) => t.damage === 0) && (facts.damage ?? 0) > 0) add("damage", false, "no damage in any trial", "hits but deals no damage", "the battle-review session's");
    const muzzles = m.flatMap((x) => x.m.muzzles);
    if (muzzles.length) {
      const none = muzzles.filter((x) => x.kind === "none").length;
      const expected = !!ra2.muzzle && !(ra2.exact === false && kind === "infantry");
      if (expected) add("muzzleFlash", none === 0, none ? `${none} of ${muzzles.length} shots show no flash; RA2's ${ra2.exact ? `${p.weapon.replace(/^ea-retail-/, "")} plays ${ra2.muzzle}` : `${ra2.kind} weapons flash`}` : "every shot flashes",
        t0.muzzleSequence == null ? `${family} ${kind}s: the armament names no muzzle flash` : !t0.muzzleOverlay ? `${family} ${kind}s: the unit has no muzzle overlay` : `${family} ${kind}s: muzzle overlay never drawn`);
      const drawn = muzzles.filter((x) => x.kind === "overlay");
      if (drawn.length) {
        const off = Math.max(...drawn.map((x) => x.off));
        add("muzzleAtTip", off <= T.muzzleTipPx, `drawn up to ${off} px from the barrel tip`, `muzzle flash drawn away from the barrel tip`);
        const share = Math.max(...drawn.map((x) => x.share));
        add("muzzleSize", share <= T.muzzleAreaShare, `flash covers ${Math.round(share * 100)}% of the unit`, `muzzle flash as big as the unit (${drawn[0].sequence})`);
      }
    }
    const atShooter = [...new Set(m.flatMap((x) => x.m.atShooter))];
    add("noBlastAtShooter", atShooter.length === 0, atShooter.length ? `explosion drawn on the shooter: ${atShooter.join(", ")}` : "none", `explosion drawn on the shooter (${atShooter[0]})`);
    const effects = m.flatMap((x) => x.m.shots).filter((s) => s.effect?.rect);
    // RA2's flak draws its own puffs (HTRKPUFF, SMKPUFF) whatever the damage: a flak gun drawing them is RA2's look.
    const flak = { flak_puff: "htrkpuff", flak_puff_AA: "smkpuff" }[effects[0]?.effect.sequence];
    const expected = flak ? { name: flak, visible: look.anims?.[flak]?.visible } : ra2Impact(ra2, look);
    if (effects.length && expected?.visible) {
      // Held to what RA2 draws for a hit of this damage, not to the target's size: RA2's big missiles do dwarf a tank.
      const worst = effects.reduce((a, b) => (area(b.effect.rect) > area(a.effect.rect) ? b : a));
      const ratio = area(worst.effect.rect) / (expected.visible[0] * expected.visible[1]);
      const seq = `${worst.effect.image}.${worst.effect.sequence}`;
      add("impactSize", ratio <= T.impactAreaShare, `a ${ra2.damage}-damage hit draws ${seq} (${worst.effect.rect[2]}x${worst.effect.rect[3]} px, ${Math.round(worst.effect.share * 100)}% of the ${t0.target}); RA2 draws ${expected.name} (${expected.visible.join("x")} px)`,
        `${family} ${seq}: heavier than RA2's hit for the same damage`);
    }
    const flights = m.flatMap((x) => x.m.flights);
    if (flights.length) {
      const shown = flights.filter((f) => f.visible / f.ticks >= T.visibleShare && f.px >= T.projectilePx).length / flights.length;
      const visibleInRa2 = ["arcing", "shell", "missile", "bomb"].includes(ra2.kind);
      if (visibleInRa2) add("projectileVisible", shown >= 0.5, `${Math.round(shown * 100)}% of flights drawn (RA2: ${ra2.exact ? `${ra2.projectile}, image ${ra2.image}` : ra2.kind})`,
        facts.fields?.Image ? `${family} ${facts.projectile}: drawn too small or too briefly` : `${family} ${facts.projectile}: the projectile has no image`);
    }
    const beams = m.flatMap((x) => x.m.beams).filter((b) => b.first);
    if (beams.length && ra2.kind !== "laser") {
      // RA2's electric bolts are 1 px strands and its rad beam a wave: held to being drawn at all, not to a width.
      add("beamDrawn", beams.every((b) => b.first.quads > 0), `${beams[0].type}: ${beams[0].first.quads} quads`, `${beams[0].type}: not drawn`);
    } else if (beams.length) {
      const weak = beams.filter((b) => b.first.peak < T.beamContrast || b.first.width25 < T.beamWidthPx);
      const short = beams.filter((b) => b.litTicks < T.beamTicks);
      const f = beams[0].first;
      add("beamVisible", weak.length === 0, `peak contrast ${f.peak}, ${f.width25} px wide at 0.25, ${f.width10} px at 0.1${beams[0].before ? ` (before: ${beams[0].before.peak}, ${beams[0].before.width25} px)` : ""}`,
        `${beams[0].type}: a thin, faint line`);
      add("beamDuration", short.length === 0, `lit for ${Math.min(...beams.map((b) => b.litTicks))} ticks`, `${beams[0].type}: gone too fast`);
    }
    // RA2's own weapon may be silent too: the carrier's HornetLauncher (its Hornets sound), Yuri's MindControl (the
    // controller plays YuriMindControl). Only a sound RA2 gives and the port lacks, or a modern weapon's, is missing.
    const silentInRa2 = !!ra2.projectile && !ra2.report;
    if (fired && !(facts.report?.length)) add("sound", silentInRa2, silentInRa2 ? "silent, as RA2's weapon is" : "no firing sound", "weapon has no Report (firing sound)");
    // Original art drawn with the project's palette shows as coloured noise (the Typhoon's bubble trail, 20 Nov 2026).
    for (const [image, palette] of [["Image", "Palette"], ["TrailImage", "TrailPalette"]]) {
      const img = facts.fields?.[image], pal = facts.fields?.[palette];
      if (img?.startsWith("ea-")) add("originalPalette", pal?.startsWith("ea") || pal === "shadow", `${image} ${img} drawn with palette ${pal}`,
        `original art in a projectile drawn with the project's palette (${image})`);
    }
    const result = { unit: p.unit, level: p.level, weapon: p.weapon, family, kind, factions: [...p.factions].sort(), ra2: ra2.exact ? p.weapon.replace(/^ea-retail-/, "") : `(${ra2.kind})`, checks };
    results.push(result);
    for (const c of checks.filter((c) => !c.pass && c.cause)) {
      const id = `${p.unit}|${p.level}|${p.weapon}|${c.id}`;
      findings.push({ id, unit: p.unit, level: p.level, weapon: p.weapon, check: c.id, value: c.value, cause: c.cause, note: c.note, family, accepted: baseline.accepted?.[id] ?? null });
    }
  }
  const causes = new Map();
  for (const f of findings) {
    if (!causes.has(f.cause)) causes.set(f.cause, { cause: f.cause, check: f.check, units: new Set(), weapons: new Set(), findings: 0, note: f.note });
    const c = causes.get(f.cause);
    c.units.add(f.unit);
    c.weapons.add(f.weapon);
    c.findings++;
  }
  const ranked = [...causes.values()].map((c) => ({ ...c, units: [...c.units].sort(), weapons: [...c.weapons].sort() })).sort((a, b) => b.units.length - a.units.length || b.findings - a.findings);
  const fresh = findings.filter((f) => !f.accepted);
  const fixed = Object.keys(baseline.accepted ?? {}).filter((id) => !findings.some((f) => f.id === id));
  return { thresholds: T, pairs: results.length, units: new Set(results.map((r) => r.unit)).size, results, findings, ranked, fresh, fixed };
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function markdown(r) {
  const lines = [`# Weapon fidelity`, ``, `${r.units} armed units, ${r.pairs} unit-weapon pairs, ${r.findings.length} findings (${r.fresh.length} not in the baseline).`, ``,
    `| # | Cause | Check | Units | Weapons |`, `|---|---|---|---|---|`];
  r.ranked.forEach((c, i) => lines.push(`| ${i + 1} | ${c.cause} | ${c.check} | ${c.units.length} | ${c.weapons.length} |`));
  lines.push(``, `## Findings`, ``);
  for (const c of r.ranked) {
    lines.push(`### ${c.cause}`, ``, `Units: ${c.units.join(", ")}`, ``);
    for (const f of r.findings.filter((f) => f.cause === c.cause)) lines.push(`- ${f.unit}${f.level ? " (elite)" : ""} ${f.weapon}: ${f.value}${f.accepted ? ` (accepted: ${f.accepted})` : ""}`);
    lines.push(``);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const out = path.resolve(opt("out", path.join(process.env.LOCALAPPDATA ?? repo, "RTSAI-WebGame", "scratch", "weapon-fidelity")));
  fs.mkdirSync(out, { recursive: true });
  let rawFile = opt("raw");
  if (!rawFile) {
    const websim = opt("websim"), root = opt("root");
    if (!websim || !root) { console.error("usage: node tools/weapon-fidelity.mjs --raw <weaponaudit.json> | --websim <websim> --root <vfs> [--factions a,b] [--out dir]"); process.exit(2); }
    rawFile = path.join(out, "weaponaudit.json");
    const factions = opt("factions") ? ["--factions", opt("factions")] : [];
    console.log(execFileSync(websim, ["weaponaudit", "--root", root, "--out", rawFile, ...factions], { encoding: "utf8", maxBuffer: 1 << 28 }).trim().split("\n").at(-1));
  }
  const raw = JSON.parse(fs.readFileSync(rawFile, "utf8"));
  const look = JSON.parse(fs.readFileSync(path.join(repo, "tools", "data", "ra2-weapon-look.json"), "utf8"));
  const baselineFile = path.resolve(opt("baseline", path.join(repo, "tools", "data", "weapon-fidelity-baseline.json")));
  const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, "utf8")) : { accepted: {} };
  const r = analyze(raw, look, baseline);
  fs.writeFileSync(path.join(out, "weapon-fidelity.json"), JSON.stringify(r, null, 1));
  fs.writeFileSync(path.join(out, "weapon-fidelity.md"), markdown(r));
  if (argv.includes("--write-baseline")) {
    const accepted = Object.fromEntries(r.findings.map((f) => [f.id, baseline.accepted?.[f.id] ?? `open: ${f.cause}`]));
    fs.writeFileSync(baselineFile, JSON.stringify({ $comment: "Known weapon-look findings a release may carry (id: unit|rank|weapon|check). Remove a line when its fault is fixed; never add one to pass a release without saying why.", accepted }, null, 1) + "\n");
    console.log(`baseline: ${Object.keys(accepted).length} accepted finding(s) written to ${baselineFile}`);
  }
  console.log(`${r.units} units, ${r.pairs} pairs, ${r.findings.length} findings, ${r.fresh.length} new${r.fixed.length ? `, ${r.fixed.length} accepted ones now fixed (remove them from the baseline)` : ""}; report in ${out}`);
  for (const c of r.ranked.slice(0, 15)) console.log(`  ${String(c.units.length).padStart(3)} units  ${c.cause}`);
  for (const f of r.fresh.slice(0, 20)) console.log(`NEW ${f.id}: ${f.value}`);
  process.exit(Math.min(r.fresh.length, 100));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
