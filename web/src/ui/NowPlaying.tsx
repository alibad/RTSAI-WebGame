import { useEffect, useState } from "react";
import { Music2, Volume2, VolumeX } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import "./now-playing.css";

const time = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, "0")}`;

export function NowPlaying({ game }: { game: Game }) {
  const track = useStore((s) => s.ui?.music);
  const paused = useStore((s) => s.paused);
  const [playback, setPlayback] = useState(() => game.audio.musicPlayback());
  useEffect(() => {
    const timer = window.setInterval(() => setPlayback(game.audio.musicPlayback()), 250);
    return () => window.clearInterval(timer);
  }, [game]);
  const duration = track?.duration || playback.duration;
  const elapsed = duration ? Math.min(duration, playback.elapsed) : playback.elapsed;
  const status = playback.muted ? "Music muted" : paused ? "Match paused" : playback.suspended ? "Click to enable audio" : playback.active ? "Now playing" : track ? "Loading music…" : "No music playing";
  return <Popover>
    <PopoverTrigger className="np-trigger" aria-label="Now playing music" title={track ? `${track.title} · ${status}` : status}>
      <Music2 size={16} aria-hidden="true" />
      <span className="np-indicator" data-active={playback.active && !playback.muted && !paused && !playback.suspended || undefined} aria-hidden="true" />
    </PopoverTrigger>
    <PopoverContent align="start" sideOffset={10} className="np-panel" onKeyDown={(event) => event.stopPropagation()}>
      <div className="np-eyebrow"><Music2 size={14} aria-hidden="true" /><span>{status}</span></div>
      <PopoverTitle className="np-title">{track?.title || "Battlefield soundtrack"}</PopoverTitle>
      <p className="np-subtitle">{track ? "In-game music" : "Track details appear when the soundtrack starts."}</p>
      {track && <div className="np-timeline">
        {duration > 0 ? <div className="np-progress" role="progressbar" aria-label="Track playback" aria-valuemin={0} aria-valuemax={Math.ceil(duration)} aria-valuenow={Math.floor(elapsed)} aria-valuetext={`${time(elapsed)} of ${time(duration)}`}><span style={{ width: `${Math.min(100, elapsed / duration * 100)}%` }} /></div> : <div className="np-progress" />}
        <div className="np-times"><span>{time(elapsed)}</span><span>{duration > 0 ? time(duration) : "Streaming"}</span></div>
      </div>}
      <button type="button" className="np-mute" aria-pressed={!game.audio.musicOn} onClick={() => { game.audio.setMusicOn(!game.audio.musicOn); setPlayback(game.audio.musicPlayback()); }}>
        {game.audio.musicOn ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
        {game.audio.musicOn ? "Mute music" : "Unmute music"}
      </button>
      {playback.muted && game.audio.musicOn && <p className="np-hint">Master mute or a volume setting is silencing the music.</p>}
    </PopoverContent>
  </Popover>;
}
