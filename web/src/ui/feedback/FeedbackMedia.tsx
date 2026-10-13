"use client";

// Feedback media tray, shared verbatim by RTSAI-Web (app/components/feedback) and RTSAI-WebGame (web/src/ui/feedback):
// screenshot thumbnails, the voice-note recorder bar and player, attached files and the drop zone. Each host themes it
// with the --fbk-* variables (see feedback-kit.css).

import { Check, FileAudio, FileText, FileVideo, Image as ImageIcon, Paperclip, Pause, PenLine, Play, Square, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { ATTACH_ACCEPT, formatBytes, formatClock, MAX_VOICE_SECONDS } from "./media";
import "./feedback-kit.css";

export type TrayShot = { id: string; url: string };
export type TrayFile = { id: string; name: string; size: number; contentType: string; previewUrl?: string };

/** Files pasted anywhere while the dialog is open (screenshots from the clipboard, mostly). */
export function usePastedFiles(enabled: boolean, onFiles: (files: File[]) => void) {
  const latest = useRef(onFiles);
  useEffect(() => { latest.current = onFiles; });
  useEffect(() => {
    if (!enabled) return;
    const paste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (!files.length) return;
      event.preventDefault();
      latest.current(files);
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [enabled]);
}

export function ShotStrip({ shots, onMarkUp, onRemove }: { shots: TrayShot[]; onMarkUp?: (id: string) => void; onRemove: (id: string) => void }) {
  if (!shots.length) return null;
  return (
    <div className="fbk-shots" aria-label="Screenshots">
      {shots.map((shot, index) => (
        <figure key={shot.id} className="fbk-shot">
          {onMarkUp ? (
            <button type="button" className="fbk-shot-image" onClick={() => onMarkUp(shot.id)} aria-label={`Mark up screenshot ${index + 1}`} title="Mark up">
              <img src={shot.url} alt={`Screenshot ${index + 1}`} />
              <span className="fbk-shot-hint"><PenLine size={14} /> Mark up</span>
            </button>
          ) : (
            <span className="fbk-shot-image"><img src={shot.url} alt={`Screenshot ${index + 1}`} /></span>
          )}
          <button type="button" className="fbk-remove" onClick={() => onRemove(shot.id)} aria-label={`Remove screenshot ${index + 1}`} title="Remove"><X size={14} /></button>
        </figure>
      ))}
    </div>
  );
}

export function RecordingBar({ remaining, onStop }: { remaining: number; onStop: () => void }) {
  return (
    <div className="fbk-recording" role="status" aria-live="polite">
      <span className="fbk-rec-dot" aria-hidden="true" />
      <span className="fbk-rec-label">Recording</span>
      <span className="fbk-rec-track" aria-hidden="true"><span style={{ width: `${(remaining / MAX_VOICE_SECONDS) * 100}%` }} /></span>
      <span className="fbk-rec-time">{formatClock(remaining)}</span>
      <button type="button" className="fbk-rec-stop" onClick={onStop}><Square size={12} fill="currentColor" /> Stop</button>
    </div>
  );
}

/** A compact player for the recorded note (recordings carry no duration header, so the recorded length is shown). */
export function VoicePlayer({ url, seconds, onRemove }: { url: string; seconds: number; onRemove?: () => void }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [confirming, setConfirming] = useState(false);
  // A detached Audio element: the player draws its own controls.
  useEffect(() => {
    const element = new Audio(url);
    element.preload = "auto";
    const update = () => setPosition(element.currentTime);
    const ended = () => { setPlaying(false); setPosition(0); };
    const play = () => setPlaying(true), pause = () => setPlaying(false);
    element.addEventListener("timeupdate", update);
    element.addEventListener("ended", ended);
    element.addEventListener("play", play);
    element.addEventListener("pause", pause);
    audio.current = element;
    return () => {
      element.pause();
      element.removeEventListener("timeupdate", update);
      element.removeEventListener("ended", ended);
      element.removeEventListener("play", play);
      element.removeEventListener("pause", pause);
      audio.current = null;
    };
  }, [url]);
  const toggle = () => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void element.play(); else element.pause();
  };
  return (
    <div className="fbk-voice" role="group" aria-label="Voice note">
      <button type="button" className="fbk-voice-play" onClick={toggle} aria-label={playing ? "Pause voice note" : "Play voice note"}>{playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button>
      <span className="fbk-voice-wave" aria-hidden="true"><span style={{ width: `${Math.min(100, (position / Math.max(1, seconds)) * 100)}%` }} /></span>
      <span className="fbk-voice-time">{formatClock(playing || position ? position : seconds)}</span>
      {!onRemove ? null : confirming ? (
        <span className="fbk-confirm" role="group" aria-label="Delete voice note?">
          <span>Delete?</span>
          <button type="button" onClick={onRemove} aria-label="Delete voice note"><Check size={14} /></button>
          <button type="button" onClick={() => setConfirming(false)} aria-label="Keep voice note"><X size={14} /></button>
        </span>
      ) : (
        <button type="button" className="fbk-remove-inline" onClick={() => setConfirming(true)} aria-label="Remove voice note" title="Remove"><Trash2 size={14} /></button>
      )}
    </div>
  );
}

function FileIcon({ type }: { type: string }) {
  if (type.startsWith("image/")) return <ImageIcon size={15} />;
  if (type.startsWith("video/")) return <FileVideo size={15} />;
  if (type.startsWith("audio/")) return <FileAudio size={15} />;
  return <FileText size={15} />;
}

export function FileChips({ files, onRemove }: { files: TrayFile[]; onRemove: (id: string) => void }) {
  if (!files.length) return null;
  return (
    <ul className="fbk-files" aria-label="Attached files">
      {files.map((file) => (
        <li key={file.id} className="fbk-file">
          {file.previewUrl ? <img src={file.previewUrl} alt="" /> : <FileIcon type={file.contentType} />}
          <span className="fbk-file-name" title={file.name}>{file.name}</span>
          <small>{formatBytes(file.size)}</small>
          <button type="button" className="fbk-remove-inline" onClick={() => onRemove(file.id)} aria-label={`Remove ${file.name}`} title="Remove"><X size={14} /></button>
        </li>
      ))}
    </ul>
  );
}

/** Always visible and clickable; also takes drops anywhere on it. Images, video, audio and text, 10 MB each. */
export function DropZone({ onFiles, label = "Drop or paste files, or click to attach", disabled = false }: { onFiles: (files: File[]) => void; label?: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (!disabled && event.dataTransfer.files.length) onFiles([...event.dataTransfer.files]);
  };
  return (
    <>
      <button
        type="button"
        className="fbk-drop"
        data-over={over || undefined}
        disabled={disabled}
        onClick={() => input.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <Paperclip size={15} /> <span>{label}</span> <small>10 MB</small>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ATTACH_ACCEPT}
        hidden
        onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; if (files.length) onFiles(files); }}
      />
    </>
  );
}
