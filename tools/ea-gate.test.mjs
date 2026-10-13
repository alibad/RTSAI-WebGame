import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkOutput, checkProfile, EA_NOTICE, listPackEntries, noticeText } from "./ea-gate.mjs";

function pack(entries) {
  const header = Buffer.alloc(12); header.write("ORAPACK1"); header.writeInt32LE(entries.length, 8);
  return Buffer.concat([header, ...entries.flatMap(([name, value]) => {
    const key = Buffer.from(name), data = Buffer.from(value), nameLength = Buffer.alloc(2), length = Buffer.alloc(4);
    nameLength.writeUInt16LE(key.length); length.writeInt32LE(data.length);
    return [nameLength, key, length, data];
  })]);
}
const content = (names, notice = EA_NOTICE) => JSON.stringify({ notice, files: names.map((name) => ({ name, sha256: "0".repeat(64), source: "fixture" })) });

function fixture(id, entries, art = [], audio = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtsai-ea-gate-"));
  fs.writeFileSync(path.join(dir, "web-bundle.pack"), pack(entries));
  fs.writeFileSync(path.join(dir, "web-art.json"), JSON.stringify({ files: art.map((p) => ({ path: p, offset: 0, size: 40000 })) }));
  fs.writeFileSync(path.join(dir, "web-audio.json"), JSON.stringify({ files: audio.map((p) => ({ path: p, offset: 0, size: 10 })) }));
  return { id, dir };
}
const EA = "mods/rtsai/web/ea/";
const base = [["ora/BUNDLE_ID", "0".repeat(20)], ["mods/rtsai/mod.yaml", "Rules:\n"]];

test("pack entries are listed exactly", () => {
  assert.deepEqual(listPackEntries(pack([["a", "xyz"], ["b", ""]])).map((e) => [e.name, e.length]), [["a", 3], ["b", 0]]);
  assert.throws(() => listPackEntries(Buffer.concat([pack([["a", "x"]]), Buffer.from("junk")])), /trailing/);
});

test("a profile without original art passes and reports none", () => {
  assert.equal(checkProfile(fixture("public-classic", base, [], ["mods/rtsai/audio/ping.wav"])), null);
});

test("listed original art passes, counting core and range-read files", () => {
  const p = fixture("public", [...base, [EA + "unit.vxl", "v"], [EA + "small.shp", "s"], [EA + "ea-content.json", content(["unit.vxl", "small.shp", "big.shp"])]], [EA + "big.shp"]);
  assert.deepEqual(checkProfile(p), { files: 3, bytes: 40002, notice: EA_NOTICE });
});

test("audio, archives, unlisted files, a missing notice or the classic profile are refused", () => {
  const ok = [EA + "ea-content.json", content(["unit.vxl"])];
  assert.throws(() => checkProfile(fixture("public", [...base, [EA + "unit.vxl", "v"], [EA + "theme.aud", "a"], ok])), /audio/);
  assert.throws(() => checkProfile(fixture("public", [...base, [EA + "unit.vxl", "v"], ["mods/rtsai/ra2.mix", "m"], ok])), /archive/);
  assert.throws(() => checkProfile(fixture("public", [...base, [EA + "unit.vxl", "v"], ok], [], [EA + "voice.wav"])), /audio/);
  assert.throws(() => checkProfile(fixture("public", [...base, [EA + "unit.vxl", "v"], [EA + "other.shp", "o"], ok])), /not listed/);
  assert.throws(() => checkProfile(fixture("public", [...base, [EA + "unit.vxl", "v"], [EA + "ea-content.json", content(["unit.vxl"], "")]])), /notice/);
  assert.throws(() => checkProfile(fixture("public", [...base, [EA + "unit.vxl", "v"]])), /ea-content.json missing/);
  assert.throws(() => checkProfile(fixture("public-classic", [...base, [EA + "unit.vxl", "v"], ok])), /isometric only/);
  assert.throws(() => checkProfile(fixture("public", [...base, [EA + "intro.vqa", "v"], [EA + "ea-content.json", content(["intro.vqa"])]])), /archive or video/);
});

test("the output tree may not carry archives or original audio, and NOTICE carries EA's notice", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rtsai-ea-out-"));
  fs.mkdirSync(path.join(out, "data-x/public/audio/web/ea"), { recursive: true });
  fs.writeFileSync(path.join(out, "index.html"), "");
  checkOutput(out);
  fs.writeFileSync(path.join(out, "data-x/public/audio/web/ea/theme.wav"), "");
  assert.throws(() => checkOutput(out), /original audio/);
  fs.rmSync(path.join(out, "data-x/public/audio/web/ea/theme.wav"));
  fs.writeFileSync(path.join(out, "language.mix"), "");
  assert.throws(() => checkOutput(out), /archive/);
  assert.match(noticeText({ files: 2, bytes: 1048576 }), /EA has not endorsed and does not support this product\./);
});
