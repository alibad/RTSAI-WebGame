// A live inference check for developer/local tooling. An HTTP listener alone proves nothing about its models.
export async function probeLocalAI(base, { timeoutMs = 90000 } = {}) {
  const checks = { chat: false, speech: false, transcription: false };
  const checkedAt = new Date().toISOString();
  try {
    const root = new URL(base);
    if (root.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(root.hostname)) throw Error('A verified local model service is required.');
    const signal = AbortSignal.timeout(timeoutMs);
    const request = async (pathname, init = {}) => {
      const response = await fetch(new URL(pathname, root), { ...init, signal });
      if (!response.ok) throw Error('The local models did not complete their check.');
      return response;
    };
    const health = await (await request('/health/liveliness')).json();
    if (health.mode !== 'local') throw Error('This service is not running local models.');
    const info = await (await request('/v1/model/info')).json();
    for (const [name, mode] of [['local-coder', 'chat'], ['local-kokoro', 'audio_speech'], ['local-whisper', 'audio_transcription']]) {
      if (!info.data?.some(model => model.model_name === name && model.model_info?.mode === mode && model.model_info?.litellm_provider === 'local')) throw Error('The local chat and voice models are not installed.');
    }
    const chat = await (await request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'local-coder', messages: [{ role: 'user', content: 'Reply with the word ready.' }], max_tokens: 16, temperature: 0 }) })).json();
    if (typeof chat.choices?.[0]?.message?.content !== 'string' || !chat.choices[0].message.content.trim()) throw Error('The local chat model did not produce an answer.');
    checks.chat = true;
    const speech = Buffer.from(await (await request('/v1/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'local-kokoro', input: 'Ready for battle.', voice: 'am_michael', response_format: 'wav' }) })).arrayBuffer());
    if (speech.length <= 44 || speech.toString('ascii', 0, 4) !== 'RIFF' || speech.toString('ascii', 8, 12) !== 'WAVE') throw Error('The local voice model did not produce playable speech.');
    checks.speech = true;
    const form = new FormData();
    form.set('model', 'local-whisper'); form.set('response_format', 'json');
    form.set('file', new Blob([speech], { type: 'audio/wav' }), 'readiness.wav');
    const transcript = await (await request('/v1/audio/transcriptions', { method: 'POST', body: form })).json();
    if (typeof transcript.text !== 'string' || !/ready|battle/i.test(transcript.text)) throw Error('The local transcription model could not recognize the test speech.');
    checks.transcription = true;
    return { ready: true, state: 'ready', checkedAt, checks, message: 'Local chat, speech and transcription checks passed.' };
  } catch (error) {
    return { ready: false, state: 'unavailable', checkedAt, checks, message: error.name === 'TimeoutError' ? 'The local model check timed out.' : error instanceof TypeError ? 'The local model service is unavailable.' : error.message };
  }
}
