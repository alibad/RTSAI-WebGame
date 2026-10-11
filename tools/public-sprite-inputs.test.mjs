import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readBundleId, readSpriteBundle, verifySpriteBundle } from "./public-sprite-inputs.mjs";

const bundle = "031090b88a03a9e39a9d", other = "43c1ad940c6e68d448f8";
function pack(entries) {
  const header = Buffer.alloc(12); header.write("ORAPACK1"); header.writeInt32LE(entries.length, 8);
  return Buffer.concat([header, ...entries.flatMap(([name, value]) => {
    const key = Buffer.from(name), data = Buffer.from(value), nameLength = Buffer.alloc(2), length = Buffer.alloc(4);
    nameLength.writeUInt16LE(key.length); length.writeInt32LE(data.length);
    return [nameLength, key, length, data];
  })]);
}
const spriteIndex = (id) => JSON.stringify({ format: "ORASPR01", bundle: id, packings: {} });

function fixtures(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtsai-sprite-guard-"));
  try { return run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function profile(root, id, actual, sprites) {
  const dir = path.join(root, id); fs.mkdirSync(path.join(dir, "sprites"), { recursive: true });
  fs.writeFileSync(path.join(dir, "web-bundle.pack"), pack([["ora/MOD_ID", "rtsai"], ["ora/BUNDLE_ID", actual]]));
  fs.writeFileSync(path.join(dir, "sprites/index.json"), spriteIndex(sprites));
  return { id, dir };
}

test("actual ORAPACK1 identity accepts unrelated content and empty files", () => {
  assert.equal(readBundleId(pack([["mods/test/map.yaml", "name: fixture"], ["empty", ""], ["ora/BUNDLE_ID", bundle]])), bundle);
});
test("matching input identities accept both profiles without writing inputs", () => fixtures(root => {
  for (const [id, value] of [["public", bundle], ["public-classic", other]]) {
    const input = profile(root, id, value, value), before = fs.readFileSync(path.join(input.dir, "sprites/index.json"));
    assert.equal(verifySpriteBundle(input), value);
    assert.deepEqual(fs.readFileSync(path.join(input.dir, "sprites/index.json")), before);
  }
}));
test("mismatched cache refuses automatic rebinding", () => fixtures(root => {
  const input = profile(root, "public", bundle, other), before = fs.readFileSync(path.join(input.dir, "sprites/index.json"));
  assert.throws(() => verifySpriteBundle(input), /Sprite bundle mismatch.*Rebuild prebakes/);
  assert.deepEqual(fs.readFileSync(path.join(input.dir, "sprites/index.json")), before);
}));
test("missing and duplicate pack identities are rejected", () => {
  assert.throws(() => readBundleId(pack([["ora/MOD_ID", "rtsai"]])), /Missing ora\/BUNDLE_ID/);
  for (const id of [bundle, other])
    assert.throws(() => readBundleId(pack([["ora/BUNDLE_ID", bundle], ["ora/BUNDLE_ID", id]])), /Duplicate ora\/BUNDLE_ID/);
});
test("malformed bundle values are rejected", () => {
  for (const id of ["", bundle.toUpperCase(), bundle + "\n", "x".repeat(20), "ab", "a".repeat(64)])
    assert.throws(() => readBundleId(pack([["ora/BUNDLE_ID", id]])), /Malformed ora\/BUNDLE_ID/);
});
test("truncated, corrupt and trailing ORAPACK1 data is rejected", () => {
  const valid = pack([["ora/BUNDLE_ID", bundle]]);
  for (let length = 0; length < valid.length; length++) assert.throws(() => readBundleId(valid.subarray(0, length)));
  assert.throws(() => readBundleId(Buffer.concat([valid, Buffer.from("junk")])), /trailing bytes/);
  for (const [offset, value] of [[8, -1], [8, 2147483647], [27, -1]]) {
    const bad = Buffer.from(valid); bad.writeInt32LE(value, offset); assert.throws(() => readBundleId(bad));
  }
  const badName = Buffer.from(valid); badName[14] = 0xff; assert.throws(() => readBundleId(badName));
});
test("invalid and duplicate JSON identity properties are rejected", () => {
  for (const json of ["not json", "null", "[]", '{"format":"ORASPR01"}', spriteIndex(11111111111111111000), spriteIndex(bundle.toUpperCase()), '{"format":"ORASPR01","bundle":"' + bundle + '","bundle":"' + bundle + '"}', '{"format":"ORASPR01","bundle":"' + bundle + '","\\u0062undle":"' + other + '"}'])
    assert.throws(() => readSpriteBundle(json));
  assert.equal(readSpriteBundle(JSON.stringify({ format: "ORASPR01", bundle, packings: { bundle: { nested: '\\"bundle\\":{}' } } })), bundle);
});
test("missing sprite file is rejected with the profile identity", () => fixtures(root => {
  const input = profile(root, "public-classic", other, other); fs.unlinkSync(path.join(input.dir, "sprites/index.json"));
  assert.throws(() => verifySpriteBundle(input), /validation failed for public-classic/);
}));
test("CLI rejects both-profile faults before output deletion or frontend build", () => fixtures(root => {
  const main = profile(root, "public", bundle, bundle), classic = profile(root, "public-classic", other, bundle);
  const inputs = path.join(root, "build-inputs.json"); fs.writeFileSync(inputs, JSON.stringify({ standalone: { profile: "standalone-main" }, inputs: { mod: "test", engine: "test" } }));
  const out = path.join(root, "existing-build"); fs.mkdirSync(out); fs.writeFileSync(path.join(out, "BUILD.json"), "existing marker"); fs.writeFileSync(path.join(out, "keep.txt"), "keep existing output");
  const build = fileURLToPath(new URL("./build-public.mjs", import.meta.url));
  const run = () => spawnSync(process.execPath, [build, "--data", main.dir, "--classic-data", classic.dir, "--inputs", inputs, "--out", out], { encoding: "utf8", env: { ...process.env, PATH: root }, timeout: 10000 });
  for (const fault of ["classic-mismatch", "primary-malformed", "classic-duplicate", "classic-missing-pack"]) {
    fs.writeFileSync(path.join(main.dir, "web-bundle.pack"), pack([["ora/BUNDLE_ID", bundle]]));
    fs.writeFileSync(path.join(classic.dir, "web-bundle.pack"), pack([["ora/BUNDLE_ID", other]]));
    if (fault === "primary-malformed") fs.writeFileSync(path.join(main.dir, "web-bundle.pack"), Buffer.from("invalid"));
    if (fault === "classic-duplicate") fs.writeFileSync(path.join(classic.dir, "web-bundle.pack"), pack([["ora/BUNDLE_ID", other], ["ora/BUNDLE_ID", other]]));
    if (fault === "classic-missing-pack") fs.unlinkSync(path.join(classic.dir, "web-bundle.pack"));
    const result = run(); assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /Public sprite input validation failed/);
    assert.equal(fs.readFileSync(path.join(out, "BUILD.json"), "utf8"), "existing marker");
    assert.equal(fs.readFileSync(path.join(out, "keep.txt"), "utf8"), "keep existing output");
  }
}));
