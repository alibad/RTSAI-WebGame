// Local GPU jobs through the BeTenshi console's own HTTP API (the same calls its MCP server makes), for when the MCP
// connection is down: start/stop a service, animate a shot list's stills with the video queue, generate a score.
//   node tools/briefings/gpu.mjs service start|stop <id>
//   node tools/briefings/gpu.mjs clips <mission> [--stills D:/rtsai-ea-build/briefings] [--seconds 7] [--out <json>]
//        [--only <shot,shot>]
//        queues one i2v clip per shot (camera sentence + scene + action, as commission.mjs words them), waits, and
//        writes {shot id: mp4} to --out (default D:/rtsai-campaign/p2-clips-<mission>.json); --only redoes those shots
//        and keeps the others already in --out
//   node tools/briefings/gpu.mjs wait <mission> <log> [--out <json>]
//        waits again for the jobs a `clips` run queued (its "queued <mission> <shot> <job>" lines in <log>)
//   node tools/briefings/gpu.mjs music "<prompt>" <seconds> [fade]   -> prints the FLAC path
import fs from "node:fs";
import path from "node:path";

const CONSOLE = process.env.CONSOLE_URL ?? "http://localhost:8003";
const MANAGER = process.env.MANAGER_URL ?? "http://localhost:8099";
const VIDEO_ROOT = "C:/Users/Admin/Code/AI/betenshi-console/generated/video";
const MUSIC_ROOT = "C:/Users/Admin/Code/AI/betenshi-console/generated-music";
const [cmd, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAMERA = {
  "push-in": "The camera pushes in slowly and steadily toward the centre of the frame.",
  "push-in-slow": "The camera creeps in very slowly toward the subject, almost still.",
  "pull-out": "The camera pulls back slowly and steadily, revealing more of the scene.",
  "pan-left": "The camera pans slowly and smoothly from right to left across the scene.",
  "pan-right": "The camera pans slowly and smoothly from left to right across the scene.",
  "zoom-target": "The camera zooms in slowly and steadily on the target in the frame.",
  static: "The camera holds still, locked off on a tripod.",
};
const ACTION = "Gentle, natural motion only: smoke, dust, mist and light drift; vehicles and people move a little and keep their shape; one continuous shot, no cuts.";
const anchor = (p) => String(p).replace(/^keep this [^.]*\.\s*/i, "").split(/(?<=[.!?])\s+/)[0];

/** Polls the queue until every job is done. The console may be restarting or mid-edit (an HTML error page instead of
 *  JSON): that is a pause, not a failure; only a job the queue reports failed or cancelled is. */
async function waitFor(jobs, out) {
  const done = {};
  while (Object.keys(done).length < Object.keys(jobs).length) {
    for (const [shot, id] of Object.entries(jobs)) {
      if (done[shot]) continue;
      let j;
      try { j = (await (await fetch(`${CONSOLE}/api/video/jobs/${id}`, { signal: AbortSignal.timeout(30_000) })).json()).job; }
      catch { continue; }
      if (j?.status === "done") { done[shot] = path.join(VIDEO_ROOT, j.output).replace(/\\/g, "/"); console.log("done", shot); }
      else if (["failed", "cancelled"].includes(j?.status)) throw new Error(`${shot} ${j.status}: ${j.error ?? ""}`);
    }
    if (Object.keys(done).length < Object.keys(jobs).length) await sleep(20_000);
  }
  const kept = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : {};
  fs.writeFileSync(out, JSON.stringify({ ...kept, ...done }, null, 1));
  console.log("wrote", out);
}

if (cmd === "service") {
  const [action, id] = rest;
  const r = await fetch(`${MANAGER}/services/${encodeURIComponent(id)}/${action}`, { method: "POST" });
  console.log(r.status, (await r.text()).slice(0, 300));
} else if (cmd === "music") {
  const [prompt, seconds, fade] = rest;
  const f = new FormData();
  f.set("task", "text2music"); f.set("caption", prompt); f.set("instrumental", "true");
  f.set("duration", String(Math.round(Number(seconds) || 60))); f.set("format", "flac");
  if (Number(fade) > 0) f.set("fade_out", String(fade));
  const r = await fetch(`${CONSOLE}/api/labs/music/run`, { method: "POST", body: f, signal: AbortSignal.timeout(900_000) });
  const body = await r.json().catch(() => ({}));
  if (!body.ok) { console.error("music failed:", body.error ?? r.status); process.exit(1); }
  console.log(path.join(MUSIC_ROOT, body.output.track.file).replace(/\\/g, "/"));
} else if (cmd === "clips") {
  const mission = rest[0];
  const spec = JSON.parse(fs.readFileSync(path.join(here, `${mission}.json`), "utf8"));
  const stills = path.join(opt("stills", "D:/rtsai-ea-build/briefings"), mission);
  const out = opt("out", `D:/rtsai-campaign/p2-clips-${mission}.json`);
  const jobs = {};
  const only = opt("only")?.split(",");
  for (const s of spec.shots.filter((x) => !only || only.includes(x.id))) {
    const still = path.join(stills, `${s.id}.png`);
    const reg = await fetch(`${CONSOLE}/api/video/source`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: `data:image/png;base64,${fs.readFileSync(still).toString("base64")}` }) });
    const src = await reg.json();
    if (!reg.ok) throw new Error(`source ${s.id}: ${src.error ?? reg.status}`);
    const prompt = [CAMERA[s.motion] ?? CAMERA["push-in"], anchor(s.prompt), s.action ?? ACTION].join(" ");
    const q = await fetch(`${CONSOLE}/api/video/jobs`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "wan2.2-ti2v-5b", mode: "i2v", prompt, seconds: Number(opt("seconds", 7)), tier: "high", sourceImage: src.path, origin: "rtsai-briefings" }) });
    const job = (await q.json()).job;
    if (!job) throw new Error(`queue ${s.id} failed`);
    jobs[s.id] = job.id;
    console.log("queued", mission, s.id, job.id);
  }
  await waitFor(jobs, out);
} else if (cmd === "wait") {
  const [mission, log] = rest;
  const jobs = Object.fromEntries(fs.readFileSync(log, "utf8").split("\n")
    .map((l) => l.trim().split(" ")).filter((w) => w[0] === "queued" && w[1] === mission).map((w) => [w[2], w[3]]));
  await waitFor(jobs, opt("out", `D:/rtsai-campaign/p2-clips-${mission}.json`));
} else {
  console.error("usage: gpu.mjs service start|stop <id> | clips <mission> | wait <mission> <log> | music <prompt> <seconds> [fade]");
  process.exit(2);
}
