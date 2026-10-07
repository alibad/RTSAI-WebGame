// A scripted stand-in for the companion's local AI gateway (OpenAI-compatible: chat, transcription, speech), so the
// co-commander runs end to end with no GPU and no model downloads. Replies are canned; structured (JSON schema)
// requests get a valid object built from the schema. Not used when the player's local AI stack is running.

import http from "node:http";

const ADVICE = [
  "Copy, Commander. Power is steady; a second refinery now pays for the tanks later.",
  "Their scouts are probing the fords. Keep a squad on the crossing and the base is safe.",
  "Good tempo. Queue anti-armor next; their army leans on vehicles.",
  "Hold the high ground by the bridge and let them come to you.",
  "Credits are healthy. Spend them: idle money wins no fights.",
];
const TRANSCRIPTS = ["What should I build next?", "Build a power plant", "How is our economy?", "Train five riflemen"];
let turn = 0, heard = 0;

function lastUser(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join(" ");
  }
  return "";
}

/** A value that satisfies a JSON schema (first enum value, required fields, minimal arrays); text fields get advice. */
function sample(schema, root, key = "", depth = 0) {
  if (!schema || depth > 12) return null;
  if (schema.$ref) {
    const ref = schema.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k], root);
    return sample(ref, root, key, depth + 1);
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  const alt = schema.anyOf ?? schema.oneOf;
  if (alt) return sample(alt.find((s) => s.type !== "null") ?? alt[0], root, key, depth + 1);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (type === "object" || schema.properties) {
    const out = {};
    for (const [k, s] of Object.entries(schema.properties ?? {})) out[k] = sample(s, root, k, depth + 1);
    return out;
  }
  if (type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items, root, key, depth + 1));
  if (type === "string") {
    if (/text|reply|answer|message|summary|say|speech|advice|explanation|response|rationale|reason/i.test(key)) return ADVICE[turn % ADVICE.length];
    return schema.default ?? "";
  }
  if (type === "integer" || type === "number") return schema.default ?? schema.minimum ?? 0;
  if (type === "boolean") return schema.default ?? false;
  return null;
}

/** 16-bit mono WAV: a soft radio chirp whose length follows the text (it is a mock voice, not speech). */
function chirp(text) {
  const rate = 24000, seconds = Math.min(3, 0.4 + text.split(/\s+/).length * 0.06);
  const n = Math.floor(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate, syllable = Math.sin(Math.PI * ((t * 6) % 1));
    const f = 180 + 60 * Math.sin(t * 9);
    const v = 0.18 * syllable * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * 2.1 * f * t)) * Math.min(1, (seconds - t) * 8);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return buf;
}

function body(req) {
  return new Promise((resolve) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => resolve(Buffer.concat(c))); });
}

export function startMockGateway(port) {
  const server = http.createServer(async (req, res) => {
    const json = (status, obj) => { res.writeHead(status, { "content-type": "application/json", "X-RTSAI-AI-Route": "mock", "X-RTSAI-AI-State": "ok" }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, "http://x");
    if (req.method === "GET") {
      if (url.pathname.startsWith("/health")) return json(200, { status: "healthy", mock: true });
      if (url.pathname === "/v1/models") return json(200, { object: "list", data: ["local-coder", "local-whisper", "local-kokoro"].map((id) => ({ id, object: "model", owned_by: "mock" })) });
      if (url.pathname === "/v1/model/info") return json(200, { data: [] });
      return json(404, { error: "not_found" });
    }
    const raw = await body(req);
    if (url.pathname === "/v1/chat/completions") {
      let request = {};
      try { request = JSON.parse(raw.toString("utf8")); } catch { /* empty */ }
      const fmt = request.response_format;
      const schema = fmt?.json_schema?.schema;
      turn++;
      const content = schema ? JSON.stringify(sample(schema, schema)) : fmt?.type === "json_object" ? JSON.stringify({ reply: ADVICE[turn % ADVICE.length] })
        : /\?\s*$/.test(lastUser(request.messages).trim()) ? ADVICE[turn % ADVICE.length] : `Understood. ${ADVICE[turn % ADVICE.length]}`;
      const reply = { id: `mock-${turn}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: request.model ?? "local-coder",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      if (request.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "X-RTSAI-AI-Route": "mock" });
        res.write(`data: ${JSON.stringify({ ...reply, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...reply, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      return json(200, reply);
    }
    if (url.pathname === "/v1/audio/transcriptions") {
      const text = process.env.RTSAI_MOCK_TRANSCRIPT || TRANSCRIPTS[heard++ % TRANSCRIPTS.length];
      return json(200, { text });
    }
    if (url.pathname === "/v1/audio/speech") {
      let text = "";
      try { text = JSON.parse(raw.toString("utf8")).input ?? ""; } catch { /* empty */ }
      const wav = chirp(text);
      res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
      return res.end(wav);
    }
    return json(404, { error: "not_found" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
