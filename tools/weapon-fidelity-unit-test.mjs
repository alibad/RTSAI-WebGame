// The weapon-fidelity checks (tools/weapon-fidelity.mjs) on made-up shots, so the thresholds keep meaning what they say:
// a shell on the target passes, a flash off the barrel, a faint beam, a blast on the shooter and an impact that dwarfs
// its target fail, and a baseline entry stops a known finding from failing a release. Runs in milliseconds.
import assert from "node:assert/strict";
import { analyze, measureTrial, T } from "./weapon-fidelity.mjs";

const look = { weapons: { "120mmx": { kind: "arcing", projectile: "Cannon", image: "120MM", muzzle: "APMUZZLE", impact: "APOCEXP", damage: "100" }, comet: { kind: "laser", muzzle: null } },
  anims: { apocexp: { visible: [75, 74] } }, warheads: {} };
const shooterRect = [404, 1199, 92, 92], victimRect = [356, 1212, 82, 54], victimCentre = [390, 1245];

function trial(over = {}) {
  return {
    faction: "russia", unit: "apoc", level: 0, weapon: "ea-retail-120mmx", target: "htnk", range: "medium", angle: 256, moving: false,
    muzzleSequence: "muzzle", muzzleOverlay: true, shooterKind: "vehicle", damage: 200, victimHp: 400,
    shooterRect, victimRect, victimCentre, shooterCentre: [450, 1245], victimPath: [[0, 390, 1245]],
    fires: [{ tick: 10, weapon: "ea-retail-120mmx", muzzles: [[418, 1230]] }],
    muzzles: [{ tick: 11, image: "ea-apoc", sequence: "muzzle", drawn: [418, 1230], rect: [405, 1216, 26, 24] }],
    tracks: [
      { Kind: "projectile", Type: "Bullet", Weapon: "ea-retail-120mmx", first: 10, last: 13, Ticks: 4, VisibleTicks: 3, rect: [360, 1220, 60, 20], source: [418, 1230], aim: [390, 1245], end: [395, 1240], beams: [] },
      { Kind: "sprite", Type: "SpriteEffect", Image: "ea-explosion", sequences: ["apoc_explosion"], first: 14, last: 30, end: [390, 1245], rect: [351, 1192, 75, 78], explosion: true },
    ],
    ...over,
  };
}
const weapons = { "ea-retail-120mmx": { projectile: "Bullet", fields: { Image: "ea-120mm", Palette: "eaunit", Speed: "0c682" }, report: ["vapoat1a.wav"], damage: 100 },
  "ea-retail-comet": { projectile: "OriginalRa2Action", fields: {}, report: ["vpriatta.wav"], damage: 100 } };
const run = (trials, baseline) => analyze({ trials, weapons }, look, baseline);
const failing = (r) => r.findings.map((f) => f.check).sort();

// A shell that lands on the tank, a flash at the tip, an impact the size of RA2's: nothing to report.
let r = run([trial()]);
assert.deepEqual(failing(r), [], JSON.stringify(r.findings));
assert.equal(measureTrial(trial(), weapons["ea-retail-120mmx"]).shots[0].hit, true);

// The flash drawn 20 px from the barrel tip.
r = run([trial({ muzzles: [{ tick: 11, image: "ea-apoc", sequence: "muzzle", drawn: [438, 1230], rect: [425, 1216, 26, 24] }] })]);
assert.deepEqual(failing(r), ["muzzleAtTip"]);

// No flash at all, where RA2 plays APMUZZLE: the cause names the missing piece.
r = run([trial({ muzzles: [], muzzleSequence: null })]);
assert.deepEqual(failing(r), ["muzzleFlash"]);
assert.match(r.ranked[0].cause, /names no muzzle flash/);

// A blast drawn on the shooter that is not this shot's impact.
const blast = { Kind: "sprite", Type: "SpriteEffect", Image: "ea-explosion", sequences: ["medium_clsn"], first: 12, last: 30, end: [450, 1245], rect: [420, 1215, 59, 60], explosion: true };
r = run([trial({ tracks: [...trial().tracks, blast] })]);
assert.deepEqual(failing(r), ["noBlastAtShooter"]);

// An impact three times what RA2 draws for the same hit (APOCEXP, 75x74 px).
const huge = { ...trial().tracks[1], rect: [300, 1150, 164, 122] };
r = run([trial({ tracks: [trial().tracks[0], huge] })]);
assert.deepEqual(failing(r), ["impactSize"]);

// A shell that lands two cells short of a standing target.
r = run([trial({ tracks: [{ ...trial().tracks[0], aim: [250, 1245] }, { ...trial().tracks[1], end: [250, 1245] }] })]);
assert.ok(failing(r).includes("hits"));

// The Prism's old flat line (contrast 0.015) fails; RA2's glowing laser passes.
const beam = (light) => trial({ unit: "sref", weapon: "ea-retail-comet", muzzleSequence: null, muzzleOverlay: false, muzzles: [],
  fires: [{ tick: 6, weapon: "ea-retail-comet", muzzles: [[440, 1217]] }],
  tracks: [{ Kind: "projectile", Type: "OriginalRa2Laser", Weapon: "ea-retail-comet", first: 6, last: 19, Ticks: 14, VisibleTicks: 0, source: [440, 1217], end: [390, 1245],
    beams: Array.from({ length: 14 }, (_, i) => ({ tick: 6 + i, type: "LaserLight", light: { ...light, peak: i < 10 ? light.peak : 0.01 } })) }] });
r = run([beam({ peak: 0.015, width25: 0, width10: 0 })]);
assert.deepEqual(failing(r), ["beamDuration", "beamVisible"]);
r = run([beam({ peak: 0.618, width25: 6, width10: 9.5 })]);
assert.deepEqual(failing(r), []);
assert.ok(T.beamWidthPx <= 6 && T.beamContrast <= 0.618);

// The Typhoon's bubble trail: original art on the project's "effect" palette fails, on the original palette passes.
const torpedo = (trailPalette) => ({ ...weapons, "ea-retail-120mmx": { ...weapons["ea-retail-120mmx"], fields: { ...weapons["ea-retail-120mmx"].fields, Palette: "eaunit", TrailImage: "ea-bbblelrg", TrailPalette: trailPalette } } });
assert.deepEqual(analyze({ trials: [trial()], weapons: torpedo("effect") }, look).findings.map((f) => f.check), ["originalPalette"]);
assert.deepEqual(analyze({ trials: [trial()], weapons: torpedo("eaeffect") }, look).findings, []);

// A known finding in the baseline does not fail a release; a fixed one is reported as fixed.
r = run([trial({ muzzles: [], muzzleSequence: null })], { accepted: { "apoc|0|ea-retail-120mmx|muzzleFlash": "open" } });
assert.equal(r.fresh.length, 0);
r = run([trial()], { accepted: { "apoc|0|ea-retail-120mmx|muzzleFlash": "open" } });
assert.deepEqual(r.fixed, ["apoc|0|ea-retail-120mmx|muzzleFlash"]);

console.log("weapon-fidelity: all checks behave");
