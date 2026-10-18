import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { checkOutput, checkProfile, CLIP_MAX_BYTES, EA_NOTICE, listPackEntries, noticeText } from "./ea-gate.mjs";

function pack(entries) {
  const header = Buffer.alloc(12); header.write("ORAPACK1"); header.writeInt32LE(entries.length, 8);
  return Buffer.concat([header, ...entries.flatMap(([name, value]) => {
    const key = Buffer.from(name), data = Buffer.from(value), nameLength = Buffer.alloc(2), length = Buffer.alloc(4);
    nameLength.writeUInt16LE(key.length); length.writeInt32LE(data.length);
    return [nameLength, key, length, data];
  })]);
}
/** A range-read pack and its index, exactly as Bundle.WriteLazyPack writes them. */
function lazyPack(entries) {
  const bytes = pack(entries);
  return { bytes, index: { files: listPackEntries(bytes).map((e) => ({ path: e.name, offset: e.offset, size: e.length })) } };
}
const wave = (n = 64) => { const b = Buffer.alloc(n); b.write("RIFF"); b.writeUInt32LE(n - 8, 4); b.write("WAVE", 8); return b; };

test('native Classic accepts hashed terrain and unit clips, without archives', () => {
  const prefix = 'mods/rtsai-classic-core/web/ea/';
  const tile = Buffer.from('terrain'), clip = Buffer.from('unit sound');
  const files = [['temperat/s01.tem',tile,'temperat.mix'],['sounds/cannon.aud',clip,'sounds.mix']];
  const manifest = JSON.stringify({notice:EA_NOTICE,files:files.map(([name,data,source])=>({name,source,sha256:crypto.createHash('sha256').update(data).digest('hex')}))});
  const p = fixture('public-classic', [[prefix+'ea-content.json',manifest],[prefix+'temperat/s01.tem',tile]], [], [[prefix+'sounds/cannon.aud',clip]]);
  try { const result=checkProfile(p); assert.equal(result.files,1); assert.equal(result.audio.files,1); }
  finally { fs.rmSync(p.dir,{recursive:true,force:true}); }
});

test('native Classic rejects an altered asset and music from a non-unit package', () => {
  const prefix='mods/rtsai-classic-core/web/ea/';
  for(const [name,source,payload,hash,why] of [
    ['temperat/s01.tem','temperat.mix','changed','0'.repeat(64),/hash mismatch/],
    ['local/intro.aud','local.mix','music',crypto.createHash('sha256').update('music').digest('hex'),/unit\/weapon allowlist/]]) {
    const manifest=JSON.stringify({notice:EA_NOTICE,files:[{name,source,sha256:hash}]});
    const p=fixture('public-classic',[[prefix+'ea-content.json',manifest]],[],[[prefix+name,payload]]);
    try { assert.throws(()=>checkProfile(p),why); } finally {fs.rmSync(p.dir,{recursive:true,force:true});}
  }
});
const content = (names, notice = EA_NOTICE, audio = undefined) =>
  JSON.stringify({ notice, files: names.map((name) => ({ name, sha256: "0".repeat(64), source: "fixture" })),
    ...(audio ? { audio: audio.map((name) => ({ name, sha256: "0".repeat(64), source: "fixture" })) } : {}) });

function fixture(id, entries, art = [], audio = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtsai-ea-gate-"));
  fs.writeFileSync(path.join(dir, "web-bundle.pack"), pack(entries));
  fs.writeFileSync(path.join(dir, "web-art.json"), JSON.stringify({ files: art.map((p) => ({ path: p, offset: 0, size: 40000 })) }));
  // Audio: plain paths (project files, no bytes needed) or [path, bytes] pairs written into a real web-audio.pack.
  const lazy = lazyPack(audio.map((a) => Array.isArray(a) ? a : [a, "x"]));
  fs.writeFileSync(path.join(dir, "web-audio.pack"), lazy.bytes);
  fs.writeFileSync(path.join(dir, "web-audio.json"), JSON.stringify(lazy.index));
  return { id, dir };
}
const EA = "mods/rtsai/web/ea/";
const CLIPS = EA + "audio/";
const base = [["ora/BUNDLE_ID", "0".repeat(20)], ["mods/rtsai/mod.yaml", "Rules:\n"]];

test("pack entries are listed exactly", () => {
  assert.deepEqual(listPackEntries(pack([["a", "xyz"], ["b", ""]])).map((e) => [e.name, e.length]), [["a", 3], ["b", 0]]);
  assert.throws(() => listPackEntries(Buffer.concat([pack([["a", "x"]]), Buffer.from("junk")])), /trailing/);
});

test("a profile without original content passes and reports none", () => {
  assert.equal(checkProfile(fixture("public-classic", base, [], ["mods/rtsai/audio/ping.wav"])), null);
});

test("listed original art passes, counting core and range-read files", () => {
  const p = fixture("public", [...base, [EA + "unit.vxl", "v"], [EA + "small.shp", "s"], [EA + "ea-content.json", content(["unit.vxl", "small.shp", "big.shp"])]], [EA + "big.shp"]);
  assert.deepEqual(checkProfile(p), { files: 3, bytes: 40002, notice: EA_NOTICE, audio: { files: 0, bytes: 0, names: [] } });
});

test("audio, archives, unlisted files, a missing notice or the classic profile are refused", () => {
  const ok = [EA + "ea-content.json", content(["unit.vxl"])];
  assert.throws(() => checkProfile(fixture("public", [...base, [EA + "unit.vxl", "v"], [EA + "theme.aud", "a"], ok])), /audio/);
  assert.throws(() => checkProfile(fixture("public", [...base, [EA + "unit.vxl", "v"], ["mods/rtsai/ra2.mix", "m"], ok])), /archive/);
  assert.throws(() => checkProfile(fixture("public", [...base, [EA + "unit.vxl", "v"], ok], [], [EA + "voice.wav"])), /audio outside/);
  assert.throws(() => checkProfile(fixture("public", [...base, [EA + "unit.vxl", "v"], [EA + "other.shp", "o"], ok])), /not listed/);
  assert.throws(() => checkProfile(fixture("public", [...base, [EA + "unit.vxl", "v"], [EA + "ea-content.json", content(["unit.vxl"], "")]])), /notice/);
  assert.throws(() => checkProfile(fixture("public", [...base, [EA + "unit.vxl", "v"]])), /ea-content.json missing/);
  assert.throws(() => checkProfile(fixture("public-classic", [...base, [EA + "unit.vxl", "v"], ok])), /isometric only/);
  assert.throws(() => checkProfile(fixture("public", [...base, [EA + "intro.vqa", "v"], [EA + "ea-content.json", content(["intro.vqa"])]])), /archive or video/);
});

test("listed original voice clips in the audio pack pass and are counted", () => {
  const record = [EA + "ea-content.json", content(["unit.vxl"], EA_NOTICE, ["igisea.wav", "idogsela.wav"])];
  const p = fixture("public", [...base, [EA + "unit.vxl", "v"], record], [],
    ["mods/rtsai/standalone/audio/voices/idogsela.wav", [CLIPS + "idogsela.wav", wave(100)], [CLIPS + "igisea.wav", wave(60)]]);
  assert.deepEqual(checkProfile(p).audio, { files: 2, bytes: 160, names: ["idogsela.wav", "igisea.wav"] });
});

test("original clips that are unlisted, misplaced, not WAVE, too large, EVA, archives or in the classic profile are refused", () => {
  const record = (clips) => [EA + "ea-content.json", content(["unit.vxl"], EA_NOTICE, clips)];
  const art = [EA + "unit.vxl", "v"];
  const run = (clips, audio, id = "public", core = []) => checkProfile(fixture(id, [...base, art, ...core, record(clips)], [], audio));
  assert.throws(() => run(["igisea.wav"], [[CLIPS + "igisea.wav", wave()], [CLIPS + "igiseb.wav", wave()]]), /igiseb.wav is not listed/);
  assert.throws(() => run(["igisea.wav", "igiseb.wav"], [[CLIPS + "igisea.wav", wave()]]), /lists 2 clips, the audio pack carries 1/);
  assert.throws(() => run(["igisea.wav"], [[EA + "igisea.wav", wave()]]), /audio outside/);
  assert.throws(() => run(["igisea.wav"], [[CLIPS + "sub/igisea.wav", wave()]]), /audio outside/);
  assert.throws(() => run(["igisea.wav"], [[CLIPS + "igisea.wav", "not a wave file"]]), /not a RIFF WAVE/);
  assert.throws(() => run(["igisea.wav"], [[CLIPS + "igisea.wav", wave(CLIP_MAX_BYTES + 2)]]), /is not a voice or sound clip/);
  assert.throws(() => run(["ceva001.wav"], [[CLIPS + "ceva001.wav", wave()]]), /not a unit voice or sound/);
  assert.throws(() => run(["theme.aud"], [[CLIPS + "theme.aud", wave()]]), /not a unit voice or sound/);
  assert.throws(() => run(["audio.bag"], [[CLIPS + "audio.bag", wave()]]), /archive/);
  assert.throws(() => run(["igisea.wav"], [[CLIPS + "igisea.wav", wave()]], "public-classic"), /isometric only/);
  assert.throws(() => run(["igisea.wav"], [[CLIPS + "igisea.wav", wave()]], "public", [[CLIPS + "igiseb.wav", wave()]]), /original art outside|audio in the original-art folder/);
});

test("the output tree may carry only the listed clips as original audio, and NOTICE carries EA's notice", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rtsai-ea-out-"));
  const clips = path.join(out, "data-0123456789ab/public/audio/web/ea/audio");
  fs.mkdirSync(clips, { recursive: true });
  fs.writeFileSync(path.join(out, "index.html"), "");
  checkOutput(out);
  fs.writeFileSync(path.join(clips, "igisea.wav"), "RIFF");
  assert.throws(() => checkOutput(out), /not listed/);
  const summary = { files: 1, bytes: 1, audio: { files: 1, bytes: 4, names: ["igisea.wav"] } };
  checkOutput(out, summary);
  assert.throws(() => checkOutput(out, { ...summary, audio: { ...summary.audio, names: ["igisea.wav", "igiseb.wav"] } }), /missing from the output/);
  fs.writeFileSync(path.join(clips, "theme.wav"), "");
  assert.throws(() => checkOutput(out, summary), /not listed/);
  fs.rmSync(path.join(clips, "theme.wav"));
  fs.mkdirSync(path.join(out, "data-0123456789ab/public/audio/web/ea/music"), { recursive: true });
  fs.writeFileSync(path.join(out, "data-0123456789ab/public/audio/web/ea/music/grinder.wav"), "");
  assert.throws(() => checkOutput(out, summary), /not listed/);
  fs.rmSync(path.join(out, "data-0123456789ab/public/audio/web/ea/music"), { recursive: true });
  fs.writeFileSync(path.join(clips, "big.wav"), Buffer.alloc(CLIP_MAX_BYTES + 1));
  assert.throws(() => checkOutput(out, { ...summary, audio: { ...summary.audio, names: ["igisea.wav", "big.wav"] } }), /larger than a voice/);
  fs.rmSync(path.join(clips, "big.wav"));
  fs.writeFileSync(path.join(out, "language.mix"), "");
  assert.throws(() => checkOutput(out, summary), /archive/);
  const notice = noticeText({ files: 2, bytes: 1048576, audio: { files: 3, bytes: 2097152, names: [] } });
  assert.match(notice, /EA has not endorsed and does not support this product\./);
  assert.match(notice, /unit voices and sounds/);
  assert.match(notice, /No C&C music/);
  assert.match(notice, /3 original unit voice and sound clips/);
});
