import fs from "node:fs";
import path from "node:path";

const bundlePattern = /^[0-9a-f]{20}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function readBundleId(pack) {
  if (pack.length < 12 || pack.subarray(0, 8).toString() !== "ORAPACK1")
    throw new Error("Malformed ORAPACK1 header");
  const count = pack.readInt32LE(8);
  if (count < 1 || count > Math.floor((pack.length - 12) / 7))
    throw new Error("Malformed ORAPACK1 entry count");
  let offset = 12, bundle;
  const requireBytes = (length) => {
    if (length < 0 || length > pack.length - offset)
      throw new Error("Malformed ORAPACK1 entry bounds");
  };
  for (let i = 0; i < count; i++) {
    requireBytes(2);
    const nameLength = pack.readUInt16LE(offset); offset += 2;
    if (!nameLength) throw new Error("Malformed ORAPACK1 empty entry name");
    requireBytes(nameLength);
    const name = decoder.decode(pack.subarray(offset, offset + nameLength)); offset += nameLength;
    requireBytes(4);
    const length = pack.readInt32LE(offset); offset += 4;
    requireBytes(length);
    if (name === "ora/BUNDLE_ID") {
      if (bundle !== undefined) throw new Error("Duplicate ora/BUNDLE_ID entries");
      bundle = decoder.decode(pack.subarray(offset, offset + length));
      if (!bundlePattern.test(bundle)) throw new Error("Malformed ora/BUNDLE_ID: expected 20 lowercase hexadecimal characters");
    }
    offset += length;
  }
  if (offset !== pack.length) throw new Error("Malformed ORAPACK1 trailing bytes");
  if (bundle === undefined) throw new Error("Missing ora/BUNDLE_ID entry");
  return bundle;
}

export function readSpriteBundle(indexText) {
  const index = JSON.parse(indexText);
  if (index?.format !== "ORASPR01" || typeof index.bundle !== "string" || !bundlePattern.test(index.bundle))
    throw new Error("Malformed sprites/index.json: expected ORASPR01 and a 20-character lowercase hexadecimal bundle ID");
  let depth = 0, bundleProperties = 0;
  for (let i = 0; i < indexText.length; i++) {
    const char = indexText[i];
    if (char === '"') {
      const start = i++;
      while (i < indexText.length && indexText[i] !== '"') {
        if (indexText[i] === "\\") i++;
        i++;
      }
      if (depth === 1 && JSON.parse(indexText.slice(start, i + 1)) === "bundle" && /^\s*:/.test(indexText.slice(i + 1)))
        bundleProperties++;
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
  if (bundleProperties !== 1) throw new Error("Duplicate or missing sprites/index.json bundle ID");
  return index.bundle;
}

export function verifySpriteBundle(profile) {
  try {
    const bundle = readBundleId(fs.readFileSync(path.join(profile.dir, "web-bundle.pack")));
    const sprites = readSpriteBundle(fs.readFileSync(path.join(profile.dir, "sprites/index.json"), "utf8"));
    if (bundle !== sprites)
      throw new Error(`Sprite bundle mismatch: actual pack ${bundle}, supplied prebakes ${sprites}. Rebuild prebakes from this exact pack; automatic rebinding is disabled.`);
    return bundle;
  } catch (error) {
    throw new Error(`Public sprite input validation failed for ${profile.id} (${profile.dir}): ${error.message}`, { cause: error });
  }
}
