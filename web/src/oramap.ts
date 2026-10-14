// Reads an .oramap (a zip of map.yaml, map.bin, map.png and any extra files), stored or deflated, with the browser's
// own DecompressionStream. The map editor opens uploaded maps with it.

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readOramap(zip: Uint8Array): Promise<{ id: string; title: string; players: number; files: Record<string, Uint8Array> }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw Error("That file isn't an .oramap.");
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const files: Record<string, Uint8Array> = {};
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw Error("That .oramap is damaged.");
    const method = view.getUint16(p + 10, true), size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extra = view.getUint16(p + 30, true), comment = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = zip.subarray(start, start + size);
    if (!name.endsWith("/")) files[name.split("/").pop()!] = method === 8 ? await inflate(raw) : method === 0 ? raw.slice() : (() => { throw Error("That .oramap uses an unsupported compression."); })();
    p += 46 + nameLen + extra + comment;
  }
  if (!files["map.yaml"] || !files["map.bin"]) throw Error("That .oramap has no map in it.");
  const yaml = new TextDecoder().decode(files["map.yaml"]);
  const title = /^Title:\s*(.+)$/m.exec(yaml)?.[1]?.trim() ?? "Uploaded map";
  const players = Math.max(1, (yaml.match(/^\s+Actor\d+:\s*mpspawn\b/gm) ?? []).length || (yaml.match(/mpspawn/g) ?? []).length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", zip.slice()));
  const id = "upload-" + [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { id, title, players, files };
}
