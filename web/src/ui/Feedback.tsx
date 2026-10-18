import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Crosshair, ImagePlus, Loader2, MessageSquareHeart, Mic, MonitorUp, Paperclip, Send, Star, X } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { OptionSelect, type Option } from "../components/ui/fields";
import { kitPopupOpen } from "../components/ui/layers";
import { accountsConfigured, currentUser, firestore, onAccountChange, signInUrl, siteApi } from "../net/account";
import { track } from "../net/track";
import { useFeedbackDraft } from "./feedback/draft";
import { DropZone, FileChips, RecordingBar, ShotStrip, usePastedFiles, VoicePlayer } from "./feedback/FeedbackMedia";
import {
  ATTACH_ACCEPT, canCaptureTab, canRecordVoice, captureTab, checkAttachment, FEEDBACK_ROOT_ID, isCoarsePointer,
  MAX_FILES, MAX_SCREENSHOTS, toJpeg, useVoiceRecorder, withWidgetHidden,
} from "./feedback/media";
import { createFeedbackReport, FEEDBACK_REPORT_REUSE_MS, storeFeedbackFile, type FeedbackFileKind } from "./feedback/report-files";
import { captureScreen, FEEDBACK_LAUNCHER_CLASS } from "./feedback/screen";
import { ScreenshotAnnotator } from "./feedback/ScreenshotAnnotator";
import { GameButton } from "./kit/game";
import { DictationButton, useFeedbackDictation } from "./feedback/useFeedbackDictation";
import "./feedback/feedback-game.css";

// The website's feedback flow (RTSAI-Web app/components/FeedbackPanel.tsx, the feedback skill's Full mode) in the
// game: a screenshot of the screen the player is on to mark up, dictation, a voice note and files, sent with the
// player's account to the site's /api/feedback (same origin at rtsai.net/play). The files go first, straight into
// Firestore (feedbackReports/<id>, readable only by the team; see feedback/report-files.ts); the private issue links them.
// One launcher for the whole game (App mounts it once): over the visible screen's FeedbackSlot, else in its own
// corner, and above the menus, the HUD and open dialogs such as Settings.
const CATEGORIES: Option<string>[] = ["Bug", "Gameplay", "UI/UX", "Feature Request", "AI Companion", "General"].map(c => ({ value: c, label: c }));
const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"];

function playing() { return useStore.getState().phase === "playing"; }

/** Mode, match and tick for the issue's context (no player text, no network details). */
function gameContext(game: Game) {
  const s = useStore.getState();
  let scenario: { map?: string; mission?: string; multiplayer?: boolean } = {};
  try { scenario = JSON.parse(game.scenarioJson || "{}"); } catch { /* none */ }
  const entries = [{ label: "Game", value: s.profile === "public-classic" ? "Classic" : "Red Alert 2" }];
  if (s.phase === "playing") {
    entries.push({ label: "Match", value: `${scenario.multiplayer ? "Multiplayer" : scenario.mission ? "Campaign" : "Skirmish"} on ${scenario.mission ?? scenario.map ?? "unknown map"}` });
    entries.push({ label: "Tick", value: String(s.ui?.tick ?? "unknown") });
  } else entries.push({ label: "Screen", value: s.phase === "setup" ? "Menus" : s.phase });
  return entries;
}

type Slot = { kind: string; left: number; top: number; width: number; height: number };

/** The visible slot's place on screen (checked a few times a second: the HUD and the menus change under it). */
function useSlot() {
  const [slot, setSlot] = useState<Slot | null>(null);
  useEffect(() => {
    const find = () => {
      const el = [...document.querySelectorAll<HTMLElement>("[data-feedback-slot]")].filter((e) => e.getClientRects().length > 0).at(-1);
      const r = el?.getBoundingClientRect();
      const next = el && r ? { kind: el.dataset.feedbackSlot ?? "menu", left: r.left, top: r.top, width: r.width, height: r.height } : null;
      setSlot((prev) => prev && next && (Object.keys(next) as (keyof Slot)[]).every((k) => prev[k] === next[k]) ? prev : next);
    };
    find();
    const timer = setInterval(find, 200);
    addEventListener("resize", find);
    return () => { clearInterval(timer); removeEventListener("resize", find); };
  }, []);
  return slot;
}

async function canvasToPng(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not encode the screenshot");
  return blob;
}

export function Feedback({ game }: { game: Game }) {
  const draft = useFeedbackDraft();
  const [open, setOpen] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState(""), [receipt, setReceipt] = useState("");
  const [annotating, setAnnotating] = useState<{ src: string; shotId?: string; owned: boolean } | null>(null);
  const [capturing, setCapturing] = useState(false), [opening, setOpening] = useState(false);
  const [media] = useState(() => ({ tab: canCaptureTab(), voice: canRecordVoice(), touch: isCoarsePointer() }));
  const slot = useSlot();
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
  // Escape closes feedback wherever focus is: opened over a dialog, focus can still be outside it (the dialog kit
  // leaves Escape to feedback while it is open). Open pickers and the markup screen take their own Escape.
  const closeRef = useRef(() => {});
  useEffect(() => {
    if (!open || annotating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || kitPopupOpen()) return;
      e.stopPropagation();
      closeRef.current();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [open, annotating]);

  if (!accountsConfigured) return null;

  /** The battlefield as drawn this frame, as an editable PNG. */
  async function battlefieldPng() {
    return canvasToPng(await game.captureFrame());
  }

  async function openFeedback() {
    if (opening) return;
    setOpening(true);
    setError(""); setNotice(""); setReceipt("");
    const state = useFeedbackDraft.getState();
    if (!state.category || state.autoCategory) state.set({ category: playing() ? "Gameplay" : "General", autoCategory: true });
    // What the player is looking at now, grabbed before the dialog covers it. It replaces the one from an earlier
    // opening (another screen, an earlier moment) unless the player marked that one up.
    if (state.autoShot) state.removeShot(state.autoShot);
    if (useFeedbackDraft.getState().shots.length < MAX_SCREENSHOTS) {
      try { useFeedbackDraft.getState().addShot((await toJpeg(await captureScreen(game))).blob, true); } catch { /* nothing drawn: the player can add one */ }
    }
    setOpening(false);
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
      // The page as drawn, without a prompt; the browser's own tab capture (one "Share" click) when that fails.
      const shot = await captureScreen(game).catch(() => media.tab ? withWidgetHidden(captureTab) : Promise.reject());
      if (media.touch) draft.addShot((await toJpeg(shot)).blob);
      else setAnnotating({ src: URL.createObjectURL(await canvasToPng(shot)), owned: true });
    } catch { setNotice("The screen couldn't be captured. Attach a screenshot file instead."); }
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

  /** Stores what the draft hasn't stored yet in Firestore; returns the report id and the payload parts naming the files. */
  async function storeDraft(uid: string) {
    let s = useFeedbackDraft.getState();
    const hasFiles = s.shots.length > 0 || !!s.voice || s.files.length > 0;
    // The rules take a report's files for 30 minutes; an older draft starts over with a new report.
    const stale = s.reportCreatedAt !== null && Date.now() - s.reportCreatedAt > FEEDBACK_REPORT_REUSE_MS;
    const reportId = !s.submissionId || stale ? s.startReport() : s.submissionId;
    if (hasFiles) {
      const db = await firestore();
      if (useFeedbackDraft.getState().reportCreatedAt === null) {
        setProgress("Preparing…");
        try { await createFeedbackReport(db, { reportId, owner: uid, source: "game" }); s.markReportCreated(); }
        catch { s.startReport(); throw new Error("Your files couldn't be sent. Check your connection and try again."); }
      }
      const store = (blob: Blob, name: string, contentType: string, kind: FeedbackFileKind, durationSeconds?: number) => storeFeedbackFile(db, { reportId, blob, name, contentType, kind, durationSeconds });
      s = useFeedbackDraft.getState();
      const pending = [
        ...s.shots.filter((shot) => !shot.uploaded).map((shot, i) => ({ label: "screenshot", run: async () => s.markUploaded({ shot: shot.id }, await store(shot.blob, `screenshot-${i + 1}.jpg`, "image/jpeg", "screenshot")) })),
        ...(s.voice && !s.voice.uploaded ? [{ label: "voice note", run: async () => { const note = useFeedbackDraft.getState().voice!; s.markUploaded("voice", await store(note.blob, `voice-note.${note.contentType === "audio/mp4" ? "m4a" : note.contentType === "audio/ogg" ? "ogg" : "webm"}`, note.contentType, "voice", note.seconds)); } }] : []),
        ...s.files.filter((file) => !file.uploaded).map((file) => ({ label: `“${file.name}”`, run: async () => s.markUploaded({ file: file.id }, await store(file.blob, file.name, file.contentType, "file")) })),
      ];
      for (const [i, item] of pending.entries()) {
        setProgress(`Sending file ${i + 1} of ${pending.length}…`);
        try { await item.run(); } catch { throw new Error(`Couldn't send the ${item.label}. Check your connection and try again, or remove it.`); }
      }
    }
    const done = useFeedbackDraft.getState();
    return {
      reportId,
      captures: done.shots.map((shot) => ({ id: shot.id, screenshot: shot.uploaded })),
      attachments: [
        ...(done.voice?.uploaded ? [{ ...done.voice.uploaded, kind: "voice" }] : []),
        ...done.files.flatMap((file) => (file.uploaded ? [{ ...file.uploaded, kind: "file" }] : [])),
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
      const { reportId, ...files } = await storeDraft(user.uid);
      setProgress("Sending…");
      const response = await siteApi("/api/feedback", {
        category: s.category || "General", title: "", description: s.text.trim(), rating: s.rating || null,
        clientSubmissionId: reportId, pagePath: "/play/", source: "game", context: gameContext(game), ...files,
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
  closeRef.current = close;

  const shots = draft.shots.map((shot) => ({ id: shot.id, url: shot.previewUrl }));
  const files = draft.files.map((file) => ({ id: file.id, name: file.name, size: file.blob.size, contentType: file.contentType, previewUrl: file.previewUrl }));
  const markUp = media.touch ? undefined : (id: string) => { const shot = draft.shots.find((s) => s.id === id); if (shot) setAnnotating({ src: shot.previewUrl, shotId: id, owned: false }); };
  const inMatch = playing();
  const full = draft.shots.length >= MAX_SCREENSHOTS;

  // The page's top layer (document.body), above the HUD, the menus and open dialogs such as Settings.
  return createPortal(<>
    {!open && <button type="button" className={FEEDBACK_LAUNCHER_CLASS} data-variant={slot?.kind ?? "corner"} data-ui-sfx aria-label="Feedback" title="Send feedback (a screenshot of this screen is attached)" aria-busy={opening || undefined}
      style={slot ? { left: slot.left, top: slot.top, width: slot.width, height: slot.height, bottom: "auto" } : undefined} onClick={() => void openFeedback()}>
      {opening ? <Loader2 size={15} className="gfb-spin" aria-hidden="true" /> : <MessageSquareHeart size={15} aria-hidden="true" />}<span>Feedback</span>
    </button>}
    {open && <div id={FEEDBACK_ROOT_ID}>
      {/* Stays mounted (hidden) under the annotator, so returning from markup keeps the draft view as it was. */}
      <div className="gfb-overlay" role="presentation" data-ui-sfx style={annotating ? { visibility: "hidden" } : undefined} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }} onKeyDown={(e) => { if (e.key === "Escape" && !kitPopupOpen()) close(); e.stopPropagation(); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="feedback-title" className="hud-panel gfb-dialog">
          <header className="gfb-head">
            <div><span className="gfb-eyebrow">RTS AI · Feedback</span><h1 id="feedback-title">{receipt ? "Thank you, commander" : "What did you see?"}</h1></div>
            <button type="button" className="gd-close" aria-label="Close feedback" onClick={close}><X size={18} /></button>
          </header>
          {receipt ? <>
            <p className="gfb-thanks">Your report reached the team. Receipt <strong>{receipt}</strong>.</p>
            <div className="gfb-footer"><span /><GameButton variant="primary" size="lg" onClick={close}>Back to the game</GameButton></div>
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
              <button type="button" className="gfb-chip" onClick={() => void takeScreen()} disabled={capturing || full} title="The whole game screen, HUD included">{inMatch ? <MonitorUp size={15} /> : <Camera size={15} />} {inMatch ? "Full screen" : "Screenshot"}</button>
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
                <OptionSelect aria-label="Feedback topic" className="gfb-topic" value={draft.category || "General"} options={CATEGORIES} onValueChange={(category) => draft.set({ category, autoCategory: false })} />
                <div className="gfb-rating" role="radiogroup" aria-label="How’s the game so far? (optional)">{[1, 2, 3, 4, 5].map(n => <button key={n} type="button" role="radio" aria-checked={draft.rating === n} aria-label={`${n} of 5`} className={n <= draft.rating ? "on" : ""} onClick={() => draft.set({ rating: draft.rating === n ? 0 : n })}><Star size={17} /></button>)}</div>
              </div>
              <button type="button" className="gfb-send" disabled={busy || voice.recording || draft.text.trim().length < 10} onClick={() => void send()}>{busy ? <><Loader2 size={15} className="gfb-spin" /> {progress || "Sending…"}</> : <><Send size={15} /> Send</>}</button>
            </div>
          </>}
        </section>
      </div>
      {annotating && <ScreenshotAnnotator src={annotating.src} onSave={({ blob }) => finishMarkup(blob)} onCancel={() => finishMarkup(null)} />}
    </div>}
  </>, document.body);
}
