// The player's unsent feedback. Module state (not component state): the HUD and the menus each mount their own
// Feedback button, and hiding the HUD unmounts it, so the draft lives here until it is sent or discarded.
import { create } from "zustand";
import type { UploadedFile } from "./media";

export type DraftShot = { id: string; blob: Blob; previewUrl: string; uploaded?: UploadedFile };
export type DraftVoice = { blob: Blob; contentType: string; seconds: number; previewUrl: string; uploaded?: UploadedFile };
export type DraftFile = { id: string; blob: Blob; name: string; contentType: string; previewUrl?: string; uploaded?: UploadedFile };

type Draft = {
  text: string;
  category: string;
  rating: number;
  shots: DraftShot[];
  voice: DraftVoice | null;
  files: DraftFile[];
  /** Fixed at the first send so a retry reuses its uploads; the files live under feedback/<id>/. */
  submissionId: string | null;
  set: (patch: Partial<Pick<Draft, "text" | "category" | "rating">>) => void;
  addShot: (blob: Blob) => string;
  replaceShot: (id: string, blob: Blob) => void;
  removeShot: (id: string) => void;
  setVoice: (note: { blob: Blob; contentType: string; seconds: number } | null) => void;
  addFile: (file: { blob: Blob; name: string; contentType: string }) => void;
  removeFile: (id: string) => void;
  markUploaded: (target: { shot: string } | { file: string } | "voice", uploaded: UploadedFile) => void;
  ensureSubmissionId: () => string;
  reset: () => void;
};

let localId = 0;
const nextId = (prefix: string) => `${prefix}_${++localId}_${Date.now()}`;
const revoke = (url?: string) => { if (url) URL.revokeObjectURL(url); };

export const useFeedbackDraft = create<Draft>((set, get) => ({
  text: "",
  category: "",
  rating: 0,
  shots: [],
  voice: null,
  files: [],
  submissionId: null,
  set: (patch) => set(patch),
  addShot: (blob) => {
    const id = nextId("shot");
    set((s) => ({ shots: [...s.shots, { id, blob, previewUrl: URL.createObjectURL(blob) }] }));
    return id;
  },
  replaceShot: (id, blob) => set((s) => ({
    shots: s.shots.map((shot) => {
      if (shot.id !== id) return shot;
      revoke(shot.previewUrl);
      return { id, blob, previewUrl: URL.createObjectURL(blob) };
    }),
  })),
  removeShot: (id) => set((s) => {
    revoke(s.shots.find((shot) => shot.id === id)?.previewUrl);
    return { shots: s.shots.filter((shot) => shot.id !== id) };
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
  ensureSubmissionId: () => {
    const existing = get().submissionId;
    if (existing) return existing;
    const id = crypto.randomUUID();
    set({ submissionId: id });
    return id;
  },
  reset: () => {
    const s = get();
    s.shots.forEach((shot) => revoke(shot.previewUrl));
    revoke(s.voice?.previewUrl);
    s.files.forEach((file) => revoke(file.previewUrl));
    set({ text: "", category: "", rating: 0, shots: [], voice: null, files: [], submissionId: null });
  },
}));
