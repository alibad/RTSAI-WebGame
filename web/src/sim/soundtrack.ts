// Presentation policy also applies to the immutable data used by saved battles.
// Never edit those packs or simulation rules just to retire a song.
type Track = { id: string; title: string };
type MusicUi = { music?: Track | null };
export const retiredTrack = (track: Track | null | undefined) => !!track &&
  (/(?:^|[/\\])rtsai-final-push(?:\.ogg)?$/i.test(track.id) || /^final push$/i.test(track.title));

export class Soundtrack {
  private pending: { sound: number; send: () => void }[] = [];
  private nativeCommand: (json: string) => string;
  private nativeUi: () => string;
  constructor(nativeCommand: (json: string) => string, nativeUi: () => string) {
    this.nativeCommand = nativeCommand;
    this.nativeUi = nativeUi;
  }

  // Native audio callbacks run inside WASM. Wait until it returns before reading
  // the song identity; otherwise the first PCM of a retired song could leak out.
  buffer(sound: number, send: () => void) { this.pending.push({ sound, send }); }
  event(sound: number, send: () => void) {
    if (this.pending.some(chunk => chunk.sound === sound)) this.buffer(sound, send);
    else send();
  }
  stop(sound: number) { this.pending = this.pending.filter(chunk => sound >= 0 && chunk.sound !== sound); }
  reset() { this.pending = []; }
  private tracks(): Track[] {
    return (JSON.parse(this.nativeCommand('{"cmd":"music-list"}')).tracks ?? []).filter((track: Track) => !retiredTrack(track));
  }
  command(json: string): string {
    const request = JSON.parse(json);
    if (request.cmd === 'music-list') return JSON.stringify({ tracks: this.tracks() });
    if (request.cmd === 'music-play' && request.id && retiredTrack({ id: request.id, title: '' }))
      return JSON.stringify({ error: 'This track has been removed from the soundtrack.' });
    if (request.cmd === 'music-next' || request.cmd === 'music-previous') {
      const tracks = this.tracks();
      const current = (JSON.parse(this.nativeUi()) as MusicUi).music;
      const index = tracks.findIndex(track => track.id === current?.id);
      const next = request.cmd === 'music-previous'
        ? (index < 0 ? tracks.length - 1 : (index - 1 + tracks.length) % tracks.length)
        : (index + 1) % tracks.length;
      return tracks.length ? this.nativeCommand(JSON.stringify({ cmd: 'music-play', id: tracks[next].id })) : '{}';
    }
    return this.nativeCommand(json);
  }
  settle(): string {
    let json = this.nativeUi();
    const ui = JSON.parse(json) as MusicUi;
    if (retiredTrack(ui.music)) {
      this.reset(); // Discard every queued sample of the retired song.
      const next = this.tracks()[0];
      this.nativeCommand(JSON.stringify(next ? { cmd: 'music-play', id: next.id } : { cmd: 'music-pause' }));
      json = this.nativeUi();
      if (!next) { (ui as MusicUi).music = null; json = JSON.stringify(ui); }
    }
    const pending = this.pending;
    this.reset();
    for (const chunk of pending) chunk.send();
    return json;
  }
}
