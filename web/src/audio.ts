// WebAudio playback of what the engine's Sound system plays (sim/OpenRA.WebSim/WebPlatform.cs WebSoundEngine):
// PCM sources arrive once, then play/stop/volume events; music arrives as PCM chunks queued back to back.
// Positional sounds are attenuated and panned against the camera (the listener), like the desktop OpenAL path.

const NEAR = 450; // world px: full volume within this distance of the camera centre
const FAR = 1900; // silent beyond this

interface Playing {
  node: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  x: number;
  y: number;
  volume: number;
  positional: boolean;
}

interface Stream { gain: GainNode; next: number; nodes: AudioBufferSourceNode[]; volume: number }

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private music!: GainNode;
  /** Game sounds (effects, voices of units, notifications) and the co-commander's voice, mixed into master. */
  readonly buses: { sfx?: GainNode; voice?: GainNode } = {};
  /** The co-commander's reply started playing (its WAV bytes and the page time), e.g. for recording. */
  onVoice: ((wav: ArrayBuffer, at: number, seconds: number) => void) | null = null;
  private sources = new Map<number, AudioBuffer>();
  private playing = new Map<number, Playing>();
  private streams = new Map<number, Stream>();
  private listener = { x: 0, y: 0 };
  soundOn = true;
  musicOn = true;

  /** The audio context, created on first use (recording taps attach to the buses). */
  context() { return this.ensure(); }

  private ensure() {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.music = ctx.createGain();
    this.music.connect(this.master);
    this.buses.sfx = ctx.createGain();
    this.buses.sfx.connect(this.master);
    this.buses.voice = ctx.createGain();
    this.buses.voice.connect(this.master);
    this.ctx = ctx;
    // Browsers start audio suspended until the player interacts with the page.
    const resume = () => { if (ctx.state === "suspended") ctx.resume(); };
    for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, resume, { capture: true });
    return ctx;
  }

  private toBuffer(channels: number, bits: number, rate: number, pcm: ArrayBuffer) {
    const ctx = this.ensure();
    const bytes = bits / 8;
    const frames = Math.floor(pcm.byteLength / (bytes * channels));
    const buf = ctx.createBuffer(Math.max(1, channels), Math.max(1, frames), rate);
    const dv = new DataView(pcm);
    for (let c = 0; c < channels; c++) {
      const out = buf.getChannelData(c);
      for (let i = 0; i < frames; i++) {
        const o = (i * channels + c) * bytes;
        out[i] = bits === 16 ? dv.getInt16(o, true) / 32768 : (dv.getUint8(o) - 128) / 128;
      }
    }
    return buf;
  }

  source(id: number, channels: number, bits: number, rate: number, pcm: ArrayBuffer) {
    this.sources.set(id, this.toBuffer(channels, bits, rate, pcm));
  }

  private gainFor(p: { x: number; y: number; positional: boolean; volume: number }) {
    if (!p.positional) return { gain: p.volume, pan: 0 };
    const dx = p.x - this.listener.x;
    const dy = p.y - this.listener.y;
    const d = Math.hypot(dx, dy * 1.4);
    const f = d <= NEAR ? 1 : d >= FAR ? 0 : 1 - (d - NEAR) / (FAR - NEAR);
    return { gain: p.volume * f * f, pan: Math.max(-1, Math.min(1, dx / 1100)) * 0.7 };
  }

  play(sound: number, source: number, loop: boolean, relative: boolean, x: number, y: number, volume: number, attenuate: boolean) {
    const buf = this.sources.get(source);
    if (!buf || !this.soundOn) return;
    const ctx = this.ensure();
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.loop = loop;
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    const p: Playing = { node, gain, pan, x, y, volume, positional: !relative && attenuate };
    const g = this.gainFor(p);
    gain.gain.value = g.gain;
    pan.pan.value = g.pan;
    node.connect(gain).connect(pan).connect(this.buses.sfx!);
    node.onended = () => this.playing.delete(sound);
    node.start();
    this.playing.set(sound, p);
  }

  stream(sound: number, channels: number, bits: number, rate: number, pcm: ArrayBuffer, end: boolean, volume: number) {
    const ctx = this.ensure();
    let s = this.streams.get(sound);
    if (!s) {
      const gain = ctx.createGain();
      gain.connect(this.music);
      s = { gain, next: ctx.currentTime + 0.05, nodes: [], volume };
      this.streams.set(sound, s);
    }
    s.gain.gain.value = this.musicOn ? volume : 0;
    if (pcm.byteLength > 0) {
      const node = ctx.createBufferSource();
      node.buffer = this.toBuffer(channels, bits, rate, pcm);
      node.connect(s.gain);
      const at = Math.max(s.next, ctx.currentTime + 0.02);
      node.start(at);
      s.next = at + node.buffer.duration;
      s.nodes.push(node);
      node.onended = () => { s!.nodes = s!.nodes.filter((n) => n !== node); };
    }
    if (end) setTimeout(() => this.streams.delete(sound), Math.max(0, (s.next - ctx.currentTime) * 1000) + 500);
  }

  stop(sound: number) {
    const stopOne = (id: number) => {
      const p = this.playing.get(id);
      if (p) { try { p.node.stop(); } catch { /* already ended */ } this.playing.delete(id); }
      const s = this.streams.get(id);
      if (s) { for (const n of s.nodes) try { n.stop(); } catch { /* ended */ } this.streams.delete(id); }
    };
    if (sound < 0) for (const id of [...this.playing.keys(), ...this.streams.keys()]) stopOne(id);
    else stopOne(sound);
  }

  volume(sound: number, v: number) {
    if (sound < 0) return; // engine-wide sound volume is folded into each play's volume
    const p = this.playing.get(sound);
    if (p) { p.volume = v; p.gain.gain.value = this.gainFor(p).gain; }
    const s = this.streams.get(sound);
    if (s) { s.volume = v; s.gain.gain.value = this.musicOn ? v : 0; }
  }

  pause(sound: number, paused: boolean) {
    if (sound < 0 && this.ctx) {
      if (paused) this.ctx.suspend(); else this.ctx.resume();
    }
  }

  /** The camera moved: re-weigh positional sounds (cheap; called a few times a second). */
  setListener(x: number, y: number) {
    this.listener = { x, y };
    for (const p of this.playing.values()) {
      if (!p.positional) continue;
      const g = this.gainFor(p);
      p.gain.gain.value = g.gain;
      p.pan.pan.value = g.pan;
    }
  }

  /** ToggleMute (M): every sound and the music, until pressed again. */
  muted = false;

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 1;
  }

  setSoundOn(on: boolean) {
    this.soundOn = on;
    if (!on) for (const id of [...this.playing.keys()]) this.stop(id);
  }

  setMusicOn(on: boolean) {
    this.musicOn = on;
    for (const s of this.streams.values()) s.gain.gain.value = on ? s.volume : 0;
  }

  private voiceNode: AudioBufferSourceNode | null = null;

  /** The co-commander's spoken reply (a WAV); music ducks while it plays. Resolves when it ends. */
  async voice(wav: ArrayBuffer) {
    const ctx = this.ensure();
    const copy = this.onVoice ? wav.slice(0) : null;
    const buf = await ctx.decodeAudioData(wav);
    this.stopVoice();
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(this.buses.voice!);
    this.music.gain.setTargetAtTime(0.35, ctx.currentTime, 0.08);
    this.voiceNode = node;
    node.start();
    if (copy) this.onVoice?.(copy, performance.now(), buf.duration);
    await new Promise<void>((resolve) => { node.onended = () => resolve(); });
    if (this.voiceNode === node) {
      this.voiceNode = null;
      this.music.gain.setTargetAtTime(1, ctx.currentTime, 0.3);
    }
  }

  stopVoice() {
    try { this.voiceNode?.stop(); } catch { /* not started */ }
    this.voiceNode = null;
    if (this.ctx) this.music.gain.setTargetAtTime(1, this.ctx.currentTime, 0.2);
  }
}
