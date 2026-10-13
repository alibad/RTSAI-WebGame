import { useEffect, useRef, useState } from "react";
import { Camera, Crosshair, ImagePlus, Loader2, MessageSquareHeart, Mic, MonitorUp, Paperclip, Send, Star, X } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { Button } from "../components/ui/button";
import { OptionSelect, type Option } from "../components/ui/fields";
import { kitPopupOpen } from "../components/ui/layers";
import { accountsConfigured, currentUser, onAccountChange, signInUrl, siteApi, siteOrigin } from "../net/account";
import { track } from "../net/track";
import { useFeedbackDraft } from "./feedback/draft";
import { DropZone, FileChips, RecordingBar, ShotStrip, usePastedFiles, VoicePlayer } from "./feedback/FeedbackMedia";
import {
  ATTACH_ACCEPT, canCaptureTab, canRecordVoice, captureTab, checkAttachment, FEEDBACK_ROOT_ID, isCoarsePointer,
  MAX_FILES, MAX_SCREENSHOTS, toJpeg, uploadFeedbackFile, useVoiceRecorder, withWidgetHidden,
} from "./feedback/media";
import { ScreenshotAnnotator } from "./feedback/ScreenshotAnnotator";
import { DictationButton, useFeedbackDictation } from "./feedback/useFeedbackDictation";
import "./feedback/feedback-game.css";

// The website's feedback flow (RTSAI-Web app/components/FeedbackPanel.tsx, the feedback skill's Full mode) in the
// game's HUD: a screenshot of the battlefield to mark up, dictation, a voice note and files, sent with the player's
// account to the site's /api/feedback (same origin at rtsai.net/play). Files upload first, straight to the feedback
// Blob store, through the site's /api/feedback/upload token route; the private issue links them.
const CATEGORIES: Option<string>[] = ["Bug", "Gameplay", "UI/UX", "Feature Request", "AI Companion", "General"].map(c => ({ value: c, label: c }));
const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"];

function playing() { return useStore.getState().phase === "playing"; }

/** Mode, match and tick for the issue's context (no player text, no network details). */
function gameContext(game: Game) {
  const s = useStore.getState();
  let scenario: { map?: string; mission?: string; multiplayer?: boolean } = {};
  try { scenario = JSON.parse(game.scenarioJson || "{}"); } catch { /* none */ }
  const entries = [{ label: "Mode", value: s.profile === "public-classic" ? "Classic / top-down" : "Isometric" }];
  if (s.phase === "playing") {
    entries.push({ label: "Match", value: `${scenario.multiplayer ? "Multiplayer" : scenario.mission ? "Campaign" : "Skirmish"} on ${scenario.mission ?? scenario.map ?? "unknown map"}` });
    entries.push({ label: "Tick", value: String(s.ui?.tick ?? "unknown") });
  } else entries.push({ label: "Screen", value: s.phase === "setup" ? "Menus" : s.phase });
  return entries;
}

async function canvasToPng(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not encode the screenshot");
  return blob;
}

export function Feedback({ game, compact = false }: { game: Game; compact?: boolean }) {
  const draft = useFeedbackDraft();
  const [open, setOpen] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState(""), [receipt, setReceipt] = useState("");
  const [annotating, setAnnotating] = useState<{ src: string; shotId?: string; owned: boolean } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [media] = useState(() => ({ tab: canCaptureTab(), voice: canRecordVoice(), touch: isCoarsePointer() }));
  const textRef = useRef<HTMLTextAreaElement>(null);
  const photoInput = useRef<HTMLInputElement>(null), fileInput = useRef<HTMLInputElement>(null);

  const dictation = useFeedbackDictation({
    getText: () => useFeedbackDraft.getState().text,
    setText: (_field, value) => useFeedbackDraft.getState().set({ text: value }),
    onNotice: setNotice,
    limits: { text: 4000 },
  });
  const voice = useVoiceRecorder((note) => useFeedbackDraft.getState().setVoice(note), setNotice);

  useEffect(() => {
    if (!open || !accountsConfigured) return;
    let stop: (() => void) | undefined, alive = true;
    void onAccountChange((user) => setSignedIn(!!user)).then((unsubscribe) => { if (alive) stop = unsubscribe; else unsubscribe(); });
    return () => { alive = false; stop?.(); };
  }, [open]);
  useEffect(() => { if (open && !annotating) requestAnimationFrame(() => textRef.current?.focus()); }, [open, annotating]);
  useEffect(() => { if (!open && voice.recording) voice.stop(); }, [open, voice]);
  usePastedFiles(open && !annotating && !receipt, (files) => void addFiles(files));

  if (!accountsConfigured) return null;

  /** The battlefield as drawn this frame, as an editable PNG. */
  async function battlefieldPng() {
    return canvasToPng(await game.captureFrame());
  }

  async function openFeedback() {
    setError(""); setNotice(""); setReceipt("");
    const state = useFeedbackDraft.getState();
    if (!state.category) state.set({ category: playing() ? "Gameplay" : "General" });
    // What the player was looking at when they pressed Feedback: grabbed before the dialog covers it.
    if (playing() && !state.shots.length) {
      try { state.addShot((await toJpeg(await game.captureFrame())).blob); } catch { /* no frame: the player can add one */ }
    }
    setOpen(true);
  }

  async function takeBattlefield() {
    if (capturing || draft.shots.length >= MAX_SCREENSHOTS) return;
    setCapturing(true);
    try {
      const png = await battlefieldPng();
      if (media.touch) draft.addShot((await toJpeg(await createImageBitmap(png))).blob);
      else setAnnotating({ src: URL.createObjectURL(png), owned: true });
    } catch { setNotice("No battlefield to capture right now."); }
    finally { setCapturing(false); }
  }

  async function takeScreen() {
    if (capturing || draft.shots.length >= MAX_SCREENSHOTS) return;
    setCapturing(true);
    try {
      const png = await canvasToPng(await withWidgetHidden(captureTab));
      setAnnotating({ src: URL.createObjectURL(png), owned: true });
    } catch { setNotice("Screen capture was cancelled or isn't available in this browser."); }
    finally { setCapturing(false); }
  }

  function finishMarkup(blob: Blob | null) {
    if (!annotating) return;
    if (blob) { if (annotating.shotId) draft.replaceShot(annotating.shotId, blob); else draft.addShot(blob); }
    if (annotating.owned) URL.revokeObjectURL(annotating.src);
    setAnnotating(null);
  }

  async function addFiles(files: File[]) {
    const state = useFeedbackDraft.getState();
    let shots = state.shots.length, others = state.files.length, openMarkup = files.length === 1 && !media.touch;
    for (const file of files) {
      const check = checkAttachment(file);
      if (!check.ok) { setNotice(check.error); continue; }
      if (SCREENSHOT_TYPES.includes(check.contentType) && shots < MAX_SCREENSHOTS) {
        shots++;
        if (openMarkup) { setAnnotating({ src: URL.createObjectURL(file), owned: true }); openMarkup = false; continue; }
        try { state.addShot((await toJpeg(await createImageBitmap(file))).blob); } catch { setNotice(`“${file.name}” could not be read.`); }
        continue;
      }
      if (others >= MAX_FILES) { setNotice(`Up to ${MAX_FILES} files per report.`); break; }
      others++;
      state.addFile({ blob: file, name: file.name, contentType: check.contentType });
    }
  }

  async function uploadDraft(idToken: string, submissionId: string) {
    const handleUploadUrl = `${siteOrigin}/api/feedback/upload`;
    const upload = (blob: Blob, name: string, contentType: string, kind: "screenshot" | "voice" | "file") => uploadFeedbackFile({ blob, name, contentType, kind, submissionId, idToken, handleUploadUrl });
    const s = useFeedbackDraft.getState();
    const pending = [
      ...s.shots.filter((shot) => !shot.uploaded).map((shot, i) => ({ label: "screenshot", run: async () => s.markUploaded({ shot: shot.id }, await upload(shot.blob, `screenshot-${i + 1}.jpg`, "image/jpeg", "screenshot")) })),
      ...(s.voice && !s.voice.uploaded ? [{ label: "voice note", run: async () => { const note = useFeedbackDraft.getState().voice!; s.markUploaded("voice", await upload(note.blob, `voice-note.${note.contentType === "audio/mp4" ? "m4a" : note.contentType === "audio/ogg" ? "ogg" : "webm"}`, note.contentType, "voice")); } }] : []),
      ...s.files.filter((file) => !file.uploaded).map((file) => ({ label: `“${file.name}”`, run: async () => s.markUploaded({ file: file.id }, await upload(file.blob, file.name, file.contentType, "file")) })),
    ];
    for (const [i, item] of pending.entries()) {
      setProgress(`Uploading ${i + 1} of ${pending.length}…`);
      try { await item.run(); } catch { throw new Error(`Couldn't upload the ${item.label}. Check your connection and try again, or remove it.`); }
    }
    const done = useFeedbackDraft.getState();
    return {
      captures: done.shots.map((shot) => ({ id: shot.id, screenshot: shot.uploaded })),
      attachments: [
        ...(done.voice?.uploaded ? [{ kind: "voice", ...done.voice.uploaded, durationSeconds: done.voice.seconds }] : []),
        ...done.files.flatMap((file) => (file.uploaded ? [{ kind: "file", ...file.uploaded, name: file.name }] : [])),
      ],
    };
  }

  async function send() {
    const s = useFeedbackDraft.getState();
    if (s.text.trim().length < 10) { setError("Add a little more detail (at least 10 characters)."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const user = await currentUser();
      if (!user) throw new Error("Sign in to send feedback.");
      const submissionId = s.ensureSubmissionId();
      const uploads = await uploadDraft(await user.getIdToken(), submissionId);
      setProgress("Sending…");
      const response = await siteApi("/api/feedback", {
        category: s.category || "General", title: "", description: s.text.trim(), rating: s.rating || null,
        clientSubmissionId: submissionId, pagePath: "/play/", source: "game", context: gameContext(game), ...uploads,
        diagnostics: { metadata: { viewport: { width: innerWidth, height: innerHeight }, screen: { width: screen.width, height: screen.height }, devicePixelRatio, language: navigator.language, platform: navigator.platform, onLine: navigator.onLine } },
      });
      const body = await response?.json().catch(() => null) as { receipt?: string; error?: string } | null;
      if (!response?.ok) throw new Error(body?.error || "Couldn't send your feedback. Check your connection and try again; your note is kept.");
      track("feedback_sent", { category: s.category, screenshots: s.shots.length, voice: !!s.voice, files: s.files.length });
      setReceipt(body?.receipt ?? "sent");
      s.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't send your feedback. Your note is kept.");
    } finally { setBusy(false); setProgress(""); }
  }

  function close() {
    if (busy) return;
    if (voice.recording) voice.stop();
    setOpen(false); setReceipt(""); setError(""); setNotice("");
  }

  const shots = draft.shots.map((shot) => ({ id: shot.id, url: shot.previewUrl }));
  const files = draft.files.map((file) => ({ id: file.id, name: file.name, size: file.blob.size, contentType: file.contentType, previewUrl: file.previewUrl }));
  const markUp = media.touch ? undefined : (id: string) => { const shot = draft.shots.find((s) => s.id === id); if (shot) setAnnotating({ src: shot.previewUrl, shotId: id, owned: false }); };
  const inMatch = playing();
  const full = draft.shots.length >= MAX_SCREENSHOTS;

  return <>
    <Button size="sm" variant="outline" aria-label="Feedback" onClick={() => void openFeedback()}><MessageSquareHeart size={14} />{!compact && " Feedback"}</Button>
    {open && <div id={FEEDBACK_ROOT_ID}>
      {/* Stays mounted (hidden) under the annotator, so returning from markup keeps the draft view as it was. */}
      <div className="gfb-overlay" role="presentation" style={annotating ? { visibility: "hidden" } : undefined} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }} onKeyDown={(e) => { if (e.key === "Escape" && !kitPopupOpen()) close(); e.stopPropagation(); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="feedback-title" className="hud-panel gfb-dialog">
          <header className="gfb-head">
            <div><span className="gfb-eyebrow">RTS AI · Feedback</span><h1 id="feedback-title">{receipt ? "Thank you, commander" : "What did you see?"}</h1></div>
            <Button variant="ghost" size="icon-sm" aria-label="Close feedback" onClick={close}><X size={16} /></Button>
          </header>
          {receipt ? <>
            <p className="gfb-thanks">Your report reached the team. Receipt <strong>{receipt}</strong>.</p>
            <div className="gfb-footer"><span /><Button size="lg" onClick={close}>Back to the game</Button></div>
          </> : signedIn === false ? <>
            <p className="gfb-thanks">Sign in to send feedback with your RTS AI account.</p>
            <div className="gfb-footer"><span /><a className="gfb-send" href={signInUrl()}>Sign in</a></div>
          </> : <>
            <ShotStrip shots={shots} onMarkUp={markUp} onRemove={draft.removeShot} />
            <div className="gfb-text">
              <textarea ref={textRef} aria-label="Your feedback" rows={5} maxLength={4000} value={draft.text} onChange={(e) => draft.set({ text: e.target.value })} placeholder={inMatch ? "What happened on the battlefield, or what would make it better?" : "What happened, or what would make it better?"} />
              {dictation.supported && <DictationButton field="text" listening={dictation.listening} onToggle={dictation.toggle} />}
            </div>
            <div className="gfb-tools" role="group" aria-label="Add to your report">
              {inMatch && <button type="button" className="gfb-chip" onClick={() => void takeBattlefield()} disabled={capturing || full}><Crosshair size={15} /> Battlefield</button>}
              {media.tab && <button type="button" className="gfb-chip" onClick={() => void takeScreen()} disabled={capturing || full} title="The whole game screen, HUD included">{inMatch ? <MonitorUp size={15} /> : <Camera size={15} />} {inMatch ? "Full screen" : "Screenshot"}</button>}
              {media.touch && <button type="button" className="gfb-chip" onClick={() => photoInput.current?.click()} disabled={full}><ImagePlus size={15} /> Photo</button>}
              {media.voice && <button type="button" className="gfb-chip" onClick={() => void voice.start()} disabled={voice.recording || !!draft.voice}><Mic size={15} /> Voice note</button>}
              {media.touch && <button type="button" className="gfb-chip" onClick={() => fileInput.current?.click()}><Paperclip size={15} /> File</button>}
              {capturing && <Loader2 size={15} className="gfb-spin" aria-label="Capturing" />}
            </div>
            {voice.recording && <RecordingBar remaining={voice.remaining} onStop={voice.stop} />}
            {draft.voice && <VoicePlayer url={draft.voice.previewUrl} seconds={draft.voice.seconds} onRemove={() => draft.setVoice(null)} />}
            <FileChips files={files} onRemove={draft.removeFile} />
            {!media.touch && <DropZone onFiles={(list) => void addFiles(list)} />}
            <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ""; void addFiles(list); }} />
            <input ref={fileInput} type="file" accept={ATTACH_ACCEPT} multiple hidden onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ""; void addFiles(list); }} />
            {notice && <p className="gfb-notice" role="status">{notice}</p>}
            {error && <p role="alert" className="gfb-error">{error}</p>}
            <div className="gfb-footer">
              <div className="gfb-meta">
                <OptionSelect aria-label="Feedback topic" className="gfb-topic" value={draft.category || "General"} options={CATEGORIES} onValueChange={(category) => draft.set({ category })} />
                <div className="gfb-rating" role="radiogroup" aria-label="How’s the game so far? (optional)">{[1, 2, 3, 4, 5].map(n => <button key={n} type="button" role="radio" aria-checked={draft.rating === n} aria-label={`${n} of 5`} className={n <= draft.rating ? "on" : ""} onClick={() => draft.set({ rating: draft.rating === n ? 0 : n })}><Star size={17} /></button>)}</div>
              </div>
              <button type="button" className="gfb-send" disabled={busy || voice.recording || draft.text.trim().length < 10} onClick={() => void send()}>{busy ? <><Loader2 size={15} className="gfb-spin" /> {progress || "Sending…"}</> : <><Send size={15} /> Send</>}</button>
            </div>
          </>}
        </section>
      </div>
      {annotating && <ScreenshotAnnotator src={annotating.src} onSave={({ blob }) => finishMarkup(blob)} onCancel={() => finishMarkup(null)} />}
    </div>}
  </>;
}
