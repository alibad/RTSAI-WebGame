// The player's unsent feedback. Module state (not component state): it outlives closing the dialog and lives here
// until it is sent or discarded.
import { create } from "zustand";
import type { StoredFile } from "./report-files";

/** A file of this draft already stored in Firestore (kept so a retry never stores it twice). */
export type UploadedFile = StoredFile;

export type DraftShot = { id: string; blob: Blob; previewUrl: string; uploaded?: UploadedFile };
export type DraftVoice = { blob: Blob; contentType: string; seconds: number; previewUrl: string; uploaded?: UploadedFile };
export type DraftFile = { id: string; blob: Blob; name: string; contentType: string; previewUrl?: string; uploaded?: UploadedFile };

type Draft = {
  text: string;
  category: string;
  /** The topic was picked for the screen feedback was opened on, not by the player: the next opening picks again. */
  autoCategory: boolean;
  rating: number;
  shots: DraftShot[];
  /** The screenshot taken as the dialog opened: the next opening replaces it, unless the player marked it up. */
  autoShot: string | null;
  voice: DraftVoice | null;
  files: DraftFile[];
  /** The report's id (feedbackReports/<id> in Firestore), fixed at the first send so a retry reuses its files. */
  submissionId: string | null;
  /** When this browser created the report document; null until it has files to store. */
  reportCreatedAt: number | null;
  set: (patch: Partial<Pick<Draft, "text" | "category" | "autoCategory" | "rating">>) => void;
  addShot: (blob: Blob, auto?: boolean) => string;
  replaceShot: (id: string, blob: Blob) => void;
  removeShot: (id: string) => void;
  setVoice: (note: { blob: Blob; contentType: string; seconds: number } | null) => void;
  addFile: (file: { blob: Blob; name: string; contentType: string }) => void;
  removeFile: (id: string) => void;
  markUploaded: (target: { shot: string } | { file: string } | "voice", uploaded: UploadedFile) => void;
  /** A fresh report id: nothing of the draft counts as stored any more. */
  startReport: () => string;
  markReportCreated: () => void;
  reset: () => void;
};

let localId = 0;
const nextId = (prefix: string) => `${prefix}_${++localId}_${Date.now()}`;
const revoke = (url?: string) => { if (url) URL.revokeObjectURL(url); };

export const useFeedbackDraft = create<Draft>((set, get) => ({
  text: "",
  category: "",
  autoCategory: false,
  rating: 0,
  shots: [],
  autoShot: null,
  voice: null,
  files: [],
  submissionId: null,
  reportCreatedAt: null,
  set: (patch) => set(patch),
  addShot: (blob, auto = false) => {
    const id = nextId("shot");
    set((s) => ({ shots: [...s.shots, { id, blob, previewUrl: URL.createObjectURL(blob) }], ...(auto ? { autoShot: id } : {}) }));
    return id;
  },
  replaceShot: (id, blob) => set((s) => ({
    autoShot: s.autoShot === id ? null : s.autoShot,
    shots: s.shots.map((shot) => {
      if (shot.id !== id) return shot;
      revoke(shot.previewUrl);
      return { id, blob, previewUrl: URL.createObjectURL(blob) };
    }),
  })),
  removeShot: (id) => set((s) => {
    revoke(s.shots.find((shot) => shot.id === id)?.previewUrl);
    return { shots: s.shots.filter((shot) => shot.id !== id), autoShot: s.autoShot === id ? null : s.autoShot };
  }),
  setVoice: (note) => set((s) => {
    revoke(s.voice?.previewUrl);
    return { voice: note ? { ...note, previewUrl: URL.createObjectURL(note.blob) } : null };
  }),
  addFile: ({ blob, name, contentType }) => set((s) => ({
    files: [...s.files, { id: nextId("file"), blob, name, contentType, previewUrl: contentType.startsWith("image/") ? URL.createObjectURL(blob) : undefined }],
  })),
  removeFile: (id) => set((s) => {
    revoke(s.files.find((file) => file.id === id)?.previewUrl);
    return { files: s.files.filter((file) => file.id !== id) };
  }),
  markUploaded: (target, uploaded) => set((s) => {
    if (target === "voice") return s.voice ? { voice: { ...s.voice, uploaded } } : {};
    if ("shot" in target) return { shots: s.shots.map((shot) => (shot.id === target.shot ? { ...shot, uploaded } : shot)) };
    return { files: s.files.map((file) => (file.id === target.file ? { ...file, uploaded } : file)) };
  }),
  startReport: () => {
    const id = crypto.randomUUID();
    set((s) => ({
      submissionId: id,
      reportCreatedAt: null,
      shots: s.shots.map((shot) => ({ ...shot, uploaded: undefined })),
      voice: s.voice ? { ...s.voice, uploaded: undefined } : null,
      files: s.files.map((file) => ({ ...file, uploaded: undefined })),
    }));
    return id;
  },
  markReportCreated: () => set({ reportCreatedAt: Date.now() }),
  reset: () => {
    const s = get();
    s.shots.forEach((shot) => revoke(shot.previewUrl));
    revoke(s.voice?.previewUrl);
    s.files.forEach((file) => revoke(file.previewUrl));
    set({ text: "", category: "", autoCategory: false, rating: 0, shots: [], autoShot: null, voice: null, files: [], submissionId: null, reportCreatedAt: null });
  },
}));
