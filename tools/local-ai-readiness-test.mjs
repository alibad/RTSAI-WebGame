import assert from 'node:assert/strict';
import http from 'node:http';
import { probeLocalAI } from '../server/local-ai-readiness.mjs';

const wav = Buffer.alloc(32044); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
let scenario = '', requests = [];
const fixture = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks); requests.push(req.url);
  const json = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
  if (req.url === '/health/liveliness') return json({ status: 'ok', mode: scenario === 'hosted' ? 'hosted' : 'local' });
  if (req.url === '/v1/model/info') return json({ data: [['local-coder', 'chat'], ['local-kokoro', 'audio_speech'], ['local-whisper', 'audio_transcription']].map(([model_name, mode]) => ({ model_name, model_info: { mode, litellm_provider: scenario === 'mock' ? 'mock' : 'local' } })) });
  if (scenario === 'healthy-without-models') { res.statusCode = 503; return json({ error: 'model_missing' }); }
  if (req.url === '/v1/chat/completions') return json({ choices: [{ message: { content: scenario === 'broken-chat' ? '' : 'ready' } }] });
  if (req.url === '/v1/audio/speech') { res.setHeader('content-type', 'audio/wav'); return res.end(scenario === 'broken-speech' ? Buffer.from('not speech') : wav); }
  if (req.url === '/v1/audio/transcriptions') {
    assert.ok(body.includes(Buffer.from('RIFF')), 'transcription must use the newly generated WAV');
    return json({ text: scenario === 'broken-transcription' ? '' : 'Ready for battle.' });
  }
  res.statusCode = 404; res.end();
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
try {
  const base = `http://127.0.0.1:${fixture.address().port}`;
  for (scenario of ['healthy-without-models', 'hosted', 'mock', 'broken-chat', 'broken-speech', 'broken-transcription', 'success']) {
    requests = [];
    const result = await probeLocalAI(base, { timeoutMs: 2000 });
    assert.equal(result.ready, scenario === 'success', scenario);
    if (result.ready) { assert.deepEqual(result.checks, { chat: true, speech: true, transcription: true }); assert.equal(requests.length, 5); }
    console.log(`PASS ${scenario}: ${result.state}`);
  }
  assert.equal((await probeLocalAI('https://remote.invalid', { timeoutMs: 1 })).ready, false);
} finally { await new Promise(resolve => fixture.close(resolve)); }
console.log('PASS model readiness requires successful local inference for chat, speech and transcription');
