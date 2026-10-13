// Briefing art for a mission from its shot list (tools/briefings/<mission>.json), drawn locally by Qwen-Image 2.1 in
// ComfyUI (the graph of Comfy-Org's image_qwen_image_2_1 templates, as the betenshi console builds it). A shot with
// "reference": "map" is an edit of the mission's own map preview, so the briefing table shows the real battlefield;
// "reference": "<mission>/<shot id>" is an edit of an earlier still, so a returning commander keeps the same face.
// Images are cached by prompt: a shot is drawn again only when its prompt, reference or seed changes.
//   node tools/briefings/art.mjs <mission> [--out D:/rtsai-ea-build/briefings] [--force]
// Needs ComfyUI running on :8188 (betenshi service "comfyui"); check AI\logs\gpu-claim.txt first.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const mission = argv[0];
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const force = argv.includes("--force");
const comfy = opt("comfy", "http://127.0.0.1:8188");
const outDir = path.join(opt("out", "D:/rtsai-ea-build/briefings"), mission);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const spec = JSON.parse(fs.readFileSync(path.join(here, `${mission}.json`), "utf8"));
const mapPreview = path.resolve(here, "../../../RTSAI-Mod/mods/rtsai/campaigns/maps", mission, "map.png");
const [W, H] = [1664, 928];
fs.mkdirSync(outDir, { recursive: true });

async function upload(file) {
  const form = new FormData();
  form.append("image", new Blob([fs.readFileSync(file)], { type: "image/png" }), path.basename(file));
  form.append("overwrite", "true");
  const r = await fetch(`${comfy}/upload/image`, { method: "POST", body: form });
  if (!r.ok) throw new Error(`upload ${r.status}`);
  return (await r.json()).name;
}

function graph(prompt, seed, reference) {
  const g = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2.1_int8_convrot.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
    "4": { class_type: "QwenImage21Cache", inputs: { model: ["1", 0], device: "auto", dtype: "default" } },
    "6": { class_type: "EmptyLatentImage", inputs: { width: W, height: H, batch_size: 1 } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: `rtsai-briefing-${mission}` } },
  };
  const refs = {};
  if (reference) { g["20"] = { class_type: "LoadImage", inputs: { image: reference } }; refs["images.image_1"] = ["20", 0]; }
  g["5"] = { class_type: "TextEncodeQwenImage21", inputs: { clip: ["2", 0], prompt, negative_prompt: "", resolution: reference ? Math.round(Math.sqrt(W * H) / 32) * 32 : 1024, ...(reference ? { vae: ["3", 0], ...refs } : {}) } };
  g["7"] = { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["5", 0], negative: ["5", 1], latent_image: reference ? ["5", 2] : ["6", 0], seed, steps: 25, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } };
  return g;
}

async function run(workflow) {
  const q = await fetch(`${comfy}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow }) });
  if (!q.ok) throw new Error(`queue ${q.status}: ${(await q.text()).slice(0, 300)}`);
  const { prompt_id } = await q.json();
  for (let t = 0; t < 600; t++) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = await (await fetch(`${comfy}/history/${prompt_id}`)).json();
    const entry = h[prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === "error") throw new Error(`comfy error: ${JSON.stringify(entry.status.messages).slice(0, 400)}`);
    const img = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
    if (img) return Buffer.from(await (await fetch(`${comfy}/view?${new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type })}`)).arrayBuffer());
  }
  throw new Error("timed out");
}

const manifest = { mission, model: "qwen-image-2.1 (ComfyUI, local)", shots: [] };
for (const shot of spec.shots) {
  const prompt = `${shot.prompt} ${spec.style}`;
  const seed = Number.parseInt(createHash("sha256").update(`${mission}/${shot.id}/${shot.seed ?? 0}`).digest("hex").slice(0, 8), 16);
  const key = createHash("sha256").update(JSON.stringify({ prompt, seed, ref: shot.reference ?? null, W, H })).digest("hex").slice(0, 16);
  const file = path.join(outDir, `${shot.id}.png`);
  const stamp = `${file}.key`;
  if (!force && fs.existsSync(file) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === key) { console.log("cached", shot.id); manifest.shots.push({ id: shot.id, seed, key }); continue; }
  const t0 = Date.now();
  // "map": the mission's own map preview; "<mission>/<shot id>": an earlier still (a returning commander's portrait).
  const refFile = shot.reference === "map" ? mapPreview : shot.reference ? path.join(path.dirname(outDir), `${shot.reference}.png`) : null;
  const reference = refFile ? await upload(refFile) : null;
  fs.writeFileSync(file, await run(graph(prompt, seed, reference)));
  fs.writeFileSync(stamp, key);
  manifest.shots.push({ id: shot.id, seed, key, reference: shot.reference ?? null });
  console.log("drew", shot.id, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
fs.writeFileSync(path.join(outDir, "art.json"), JSON.stringify(manifest, null, 2));
