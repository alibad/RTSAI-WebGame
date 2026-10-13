"use client";

// Feedback media, shared verbatim by RTSAI-Web (app/components/feedback) and RTSAI-WebGame (web/src/ui/feedback):
// screenshots, JPEG compression, voice notes and attachment checks. Files are stored with report-files.ts.
// Keep the two copies identical; firestore.rules and the server (RTSAI-Web lib/feedback.ts) check everything again.

import { useCallback, useEffect, useRef, useState } from "react";

export const FEEDBACK_ROOT_ID = "feedback-widget-root";
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_VOICE_SECONDS = 600;
export const MAX_FILES = 6;
export const MAX_SCREENSHOTS = 4;

/** Content type → allowed extensions. Mirrors feedbackFileTypes in RTSAI-Web lib/feedback.ts and firestore.rules. */
const UPLOAD_TYPES: Readonly<Record<string, readonly string[]>> = {
  "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"], "image/webp": ["webp"], "image/gif": ["gif"],
  "video/webm": ["webm"], "video/mp4": ["mp4", "m4v"], "video/quicktime": ["mov"],
  "audio/webm": ["webm", "weba"], "audio/ogg": ["ogg", "oga", "opus"], "audio/mpeg": ["mp3"], "audio/mp4": ["m4a", "mp4"],
  "audio/x-m4a": ["m4a"], "audio/aac": ["aac"], "audio/wav": ["wav"], "audio/x-wav": ["wav"],
  "text/plain": ["txt", "log"], "text/markdown": ["md"], "text/csv": ["csv"], "application/json": ["json"],
};

export const ATTACH_ACCEPT = [...Object.keys(UPLOAD_TYPES), ...[...new Set(Object.values(UPLOAD_TYPES).flat())].map((ext) => `.${ext}`)].join(",");


function extension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isCoarsePointer() {
  return typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
}

/** The browser's own tab capture: desktop browsers only (phones have no screen capture API). */
export function canCaptureTab() {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function" && !isCoarsePointer();
}

export function canRecordVoice() {
  return typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

/** The content type the feedback store accepts for this file, or null when it can't be attached. */
export function attachmentType(file: { name: string; type: string }): string | null {
  const ext = extension(file.name);
  const declared = file.type.split(";")[0].trim().toLowerCase();
  if (UPLOAD_TYPES[declared]?.includes(ext)) return declared;
  const generic = !declared || declared === "application/octet-stream";
  return Object.keys(UPLOAD_TYPES).find((type) => UPLOAD_TYPES[type].includes(ext) && (generic || declared.split("/")[0] === type.split("/")[0])) ?? null;
}

export function checkAttachment(file: File): { ok: true; contentType: string } | { ok: false; error: string } {
  const contentType = attachmentType(file);
  if (!contentType) return { ok: false, error: `“${file.name}” can’t be attached: images, video, audio and text files only.` };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: `“${file.name}” is over 10 MB.` };
  if (file.size === 0) return { ok: false, error: `“${file.name}” is empty.` };
  return { ok: true, contentType };
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatClock(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- screenshots

/** Hides the feedback UI while the browser captures the tab, so the widget is never in its own screenshot. */
export async function withWidgetHidden<T>(fn: () => Promise<T>): Promise<T> {
  const root = document.getElementById(FEEDBACK_ROOT_ID);
  if (root) root.style.visibility = "hidden";
  await new Promise((resolve) => setTimeout(resolve, 120));
  try {
    return await fn();
  } finally {
    if (root) root.style.visibility = "";
  }
}

/**
 * One frame of this tab through the browser's screen capture (pixel-exact, including WebGL and fixed UI).
 * Chrome and Edge preselect the current tab; the player confirms once with "Share".
 */
export async function captureTab(): Promise<HTMLCanvasElement> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // The first decoded frame can still be blank; give the capture one more frame.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    return canvas;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

type Drawable = HTMLCanvasElement | HTMLImageElement | ImageBitmap;
const sizeOf = (source: Drawable) => source instanceof HTMLImageElement
  ? { width: source.naturalWidth, height: source.naturalHeight }
  : { width: source.width, height: source.height };

/** JPEG, at most 1920 px wide, quality 0.8 (the feedback skill's screenshot budget). */
export async function toJpeg(source: Drawable, maxWidth = 1920, quality = 0.8) {
  const { width, height } = sizeOf(source);
  const scale = Math.min(1, maxWidth / Math.max(1, width));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("Could not encode the screenshot");
  return { blob, width: canvas.width, height: canvas.height };
}

export function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read the image"));
    image.src = url;
  });
}

// ---------------------------------------------------------------- voice notes

export type VoiceNote = { blob: Blob; contentType: string; seconds: number };

/**
 * A voice note through MediaRecorder: up to ten minutes, stops itself at the limit. The microphone is requested
 * directly (never pre-checked with permissions.query) and released as soon as recording stops or the host unmounts.
 */
export function useVoiceRecorder(onRecorded: (note: VoiceNote) => void, onError: (message: string) => void) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const latest = useRef({ onRecorded, onError });
  useEffect(() => { latest.current = { onRecorded, onError }; });

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
    setRecording(false);
  }, []);

  const start = useCallback(async () => {
    if (recorder.current?.state === "recording") return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      latest.current.onError("Microphone access was not allowed. You can still type or attach a recording.");
      return;
    }
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
    const media = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 48_000 } : undefined);
    const chunks: Blob[] = [];
    const startedAt = performance.now();
    media.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
    media.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      recorder.current = null;
      const type = (media.mimeType || mimeType || "audio/webm").split(";")[0];
      const blob = new Blob(chunks, { type });
      if (blob.size > 0) latest.current.onRecorded({ blob, contentType: type, seconds: Math.max(1, Math.round((performance.now() - startedAt) / 1000)) });
    };
    recorder.current = media;
    media.start(1000);
    setSeconds(0);
    setRecording(true);
    timer.current = setInterval(() => {
      const elapsed = (performance.now() - startedAt) / 1000;
      setSeconds(Math.floor(elapsed));
      if (elapsed >= MAX_VOICE_SECONDS) stop();
    }, 250);
  }, [stop]);

  // Closing the dialog mid-recording discards the take and frees the microphone.
  useEffect(() => () => {
    latest.current = { onRecorded: () => {}, onError: () => {} };
    if (timer.current) clearInterval(timer.current);
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
  }, []);

  return { recording, seconds, remaining: MAX_VOICE_SECONDS - seconds, start, stop };
}
