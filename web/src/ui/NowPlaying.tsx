import { useEffect, useState } from "react";
import { Music2, Volume2, VolumeX, Play, Pause, SkipBack, SkipForward, Check } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { preferences, savePreferences } from "../preferences";
import "./now-playing.css";

const time = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, "0")}`;

export function NowPlaying({ game }: { game: Game }) {
  const track = useStore((s) => s.ui?.music);
  const paused = useStore((s) => s.paused);
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState<{ id: string; title: string }[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [seekTo, setSeekTo] = useState<number | null>(null);
  const [volume, setVolume] = useState(() => preferences.music);
  const [playback, setPlayback] = useState(() => game.audio.musicPlayback());
  useEffect(() => {
    if (!open) return;
    let active = true;
    setTracks(null);
    setError("");
    setVolume(preferences.music);
    game.command<{ tracks: { id: string; title: string }[]; error?: string }>({ cmd: "music-list" }).then(reply => {
      if (reply.error) throw new Error(reply.error);
      if (active) setTracks(reply.tracks ?? []);
    }).catch(() => { if (active) setError("Couldn't load the soundtrack. Close and reopen the player to retry."); });
    return () => { active = false; };
  }, [game, open]);
  useEffect(() => {
    const timer = window.setInterval(() => setPlayback(game.audio.musicPlayback()), 250);
    return () => window.clearInterval(timer);
  }, [game]);
  const duration = track?.duration || playback.duration;
  const elapsed = duration ? Math.min(duration, playback.elapsed) : playback.elapsed;
  const status = busy && seekTo !== null ? "Seeking…" : paused ? "Match paused" : playback.paused ? "Music paused" : playback.muted ? "Music muted" : playback.suspended ? "Click to enable audio" : playback.active ? "Now playing" : track ? "Loading music…" : "Choose a track";
  const playing = playback.active && !playback.paused;
  async function seek(seconds: number) {
    setSeekTo(seconds);
    setBusy(true);
    setError("");
    try {
      const reply = await game.command({ cmd: "music-seek", seconds });
      if (reply.error) throw new Error(String(reply.error));
    } catch { setError("Couldn't move to that position. Please try again."); }
    finally { setSeekTo(null); setBusy(false); setPlayback(game.audio.musicPlayback()); }
  }
  async function command(cmd: string, id?: string) {
    setBusy(true);
    setError("");
    try {
      const reply = await game.command({ cmd, ...(id ? { id } : {}) });
      if (reply.error) throw new Error(String(reply.error));
    }
    catch { setError("Couldn't change the music. Please try again."); }
    finally { setBusy(false); }
  }
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger className="np-trigger" aria-label="Now playing music" title={track ? `${track.title} · ${status}` : status}>
      <Music2 size={16} aria-hidden="true" />
      <span className="np-indicator" data-active={playing && !playback.muted && !paused && !playback.suspended || undefined} aria-hidden="true" />
    </PopoverTrigger>
    <PopoverContent align="start" sideOffset={10} className="np-panel" onKeyDown={(event) => event.stopPropagation()}>
      <div className="np-eyebrow"><Music2 size={14} aria-hidden="true" /><span>{status}</span></div>
      <PopoverTitle className="np-title">{track?.title || "Battlefield soundtrack"}</PopoverTitle>
      <p className="np-subtitle">{paused ? "Resume the match to change or play music." : "Pick any track. The soundtrack continues automatically."}</p>
      {track && <div className="np-timeline">
        {duration > 0 ? <input className="np-seek" type="range" aria-label="Track position" aria-valuetext={`${time(seekTo ?? elapsed)} of ${time(duration)}`} min={0} max={Math.max(0, duration - .25)} step="0.1" value={seekTo ?? elapsed} disabled={busy || paused || !playback.active}
          style={{ "--progress": `${Math.min(100, (seekTo ?? elapsed) / duration * 100)}%` } as React.CSSProperties}
          onChange={event => setSeekTo(Number(event.target.value))}
          onPointerUp={event => { if (!busy) void seek(Number(event.currentTarget.value)); }}
          onPointerCancel={() => setSeekTo(null)}
          onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key) && !busy) void seek(Number(event.currentTarget.value)); }}
          onBlur={() => { if (seekTo !== null && !busy) void seek(seekTo); }} /> : <div className="np-progress" />}
        <div className="np-times"><span>{time(seekTo ?? elapsed)}</span><span>{duration > 0 ? time(duration) : "Streaming"}</span></div>
        <p className="np-seek-hint">Click or drag to jump to any part.</p>
      </div>}
      <div className="np-transport" role="group" aria-label="Music playback">
        <button type="button" aria-label="Previous track" disabled={busy || paused || !tracks?.length} onClick={() => void command("music-previous")}><SkipBack size={19} /></button>
        <button type="button" className="np-play" aria-label={playing ? "Pause music" : "Play music"} disabled={busy || paused || !tracks?.length} onClick={() => void command(playing ? "music-pause" : "music-play")}>
          {playing ? <Pause size={20} /> : <Play size={20} />}{playing ? "Pause" : "Play"}
        </button>
        <button type="button" aria-label="Next track" disabled={busy || paused || !tracks?.length} onClick={() => void command("music-next")}><SkipForward size={19} /></button>
      </div>
      <div className="np-volume">
        <button type="button" aria-label={game.audio.musicOn ? "Mute music" : "Unmute music"} aria-pressed={!game.audio.musicOn} onClick={() => { game.audio.setMusicOn(!game.audio.musicOn); setPlayback(game.audio.musicPlayback()); }}>
          {game.audio.musicOn ? <Volume2 size={18} aria-hidden="true" /> : <VolumeX size={18} aria-hidden="true" />}
        </button>
        <label htmlFor="music-volume">Music volume</label>
        <input id="music-volume" type="range" min={0} max={100} value={Math.round(volume * 100)} onChange={event => {
          const value = Number(event.target.value) / 100;
          setVolume(value); savePreferences({ music: value }); game.audio.applyVolumes(); setPlayback(game.audio.musicPlayback());
        }} />
        <output htmlFor="music-volume">{Math.round(volume * 100)}%</output>
      </div>
      {playback.muted && game.audio.musicOn && <p className="np-hint">Master mute or a volume setting is silencing the music.</p>}
      <div className="np-library-heading">Soundtrack <span>{tracks ? `${tracks.length} tracks` : ""}</span></div>
      {error && <p className="np-hint" role="alert">{error}</p>}
      {!tracks && !error && <p className="np-hint" role="status">Loading track list…</p>}
      {tracks?.length === 0 && <p className="np-hint">No soundtrack is available for this game.</p>}
      {!!tracks?.length && <ol className="np-tracks" aria-label="Soundtrack tracks">
        {tracks.map((song, index) => <li key={song.id}>
          <button type="button" aria-current={song.id === track?.id ? "true" : undefined} aria-label={`Play ${song.title}`} disabled={busy || paused} onClick={() => void command("music-play", song.id)}>
            <span className="np-track-number" aria-hidden="true">{song.id === track?.id ? <Check size={14} /> : String(index + 1).padStart(2, "0")}</span><span>{song.title}</span>
          </button>
        </li>)}
      </ol>}
    </PopoverContent>
  </Popover>;
}
