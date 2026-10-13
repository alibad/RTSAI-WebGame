// Feedback files in Firestore, shared verbatim by RTSAI-Web (app/components/feedback) and RTSAI-WebGame
// (web/src/ui/feedback). Keep the two copies identical; RTSAI-Web firestore.rules enforces the same shape:
//
//   feedbackReports/{reportId}            { owner, created, source }
//     chunks/{fileId}_{index}             { data: Bytes, at most 900 KiB }       written first
//     files/{fileId}                      { name, kind, contentType, bytes, chunks, durationSeconds?, created }
//
// The reporter's signed-in browser creates them (never updates), within 30 minutes of the report. Only the team
// (admins/{uid}) can read them, in the website's /feedback/<reportId> viewer. Firestore on the free plan: no
// Storage bucket, so the bytes live in documents (1 MiB each at most).

import type { Bytes, Firestore } from "firebase/firestore";

export const FEEDBACK_CHUNK_BYTES = 900 * 1024;
export const FEEDBACK_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FEEDBACK_MAX_CHUNKS = Math.ceil(FEEDBACK_MAX_FILE_BYTES / FEEDBACK_CHUNK_BYTES);
/** The rules accept writes for 30 minutes; a draft older than this starts a new report. */
export const FEEDBACK_REPORT_REUSE_MS = 25 * 60_000;

export type FeedbackFileKind = "screenshot" | "voice" | "file";
/** What a feedback request carries about a stored file: no bytes, no link. */
export type StoredFile = { id: string; name: string; kind: FeedbackFileKind; contentType: string; size: number; durationSeconds?: number };
export type LoadedFile = StoredFile & { blob: Blob; complete: boolean };
export type LoadedReport = { id: string; owner: string; source: string; created: Date | null; files: LoadedFile[] };

export function chunkCount(bytes: number) {
  return Math.max(1, Math.ceil(bytes / FEEDBACK_CHUNK_BYTES));
}

export function chunkId(fileId: string, index: number) {
  return `${fileId}_${index}`;
}

/** The byte ranges a file is written in. */
export function chunkRanges(bytes: number) {
  return Array.from({ length: chunkCount(bytes) }, (_, index) => ({ index, start: index * FEEDBACK_CHUNK_BYTES, end: Math.min(bytes, (index + 1) * FEEDBACK_CHUNK_BYTES) }));
}

/** 16 random lowercase letters and digits: a new id for every attempt, so a failed upload never blocks a retry. */
export function newFileId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789", random = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(random, (value) => alphabet[value % alphabet.length]).join("");
}

/** The report document; its id is the feedback's clientSubmissionId (a UUID). */
export async function createFeedbackReport(db: Firestore, input: { reportId: string; owner: string; source: "web" | "game" }) {
  const F = await import("firebase/firestore");
  await F.setDoc(F.doc(db, "feedbackReports", input.reportId), { owner: input.owner, created: F.serverTimestamp(), source: input.source });
}

/** Writes one file: its chunks in order, then its record. Resolves when Firestore has accepted every write. */
export async function storeFeedbackFile(db: Firestore, input: {
  reportId: string;
  blob: Blob;
  name: string;
  kind: FeedbackFileKind;
  contentType: string;
  durationSeconds?: number;
}): Promise<StoredFile> {
  const F = await import("firebase/firestore");
  const bytes = new Uint8Array(await input.blob.arrayBuffer());
  if (!bytes.length || bytes.length > FEEDBACK_MAX_FILE_BYTES) throw new Error("Files must be between 1 byte and 10 MB");
  const id = newFileId(), name = input.name.trim().slice(0, 120) || "file";
  for (const range of chunkRanges(bytes.length))
    await F.setDoc(F.doc(db, "feedbackReports", input.reportId, "chunks", chunkId(id, range.index)), { data: F.Bytes.fromUint8Array(bytes.slice(range.start, range.end)) });
  const durationSeconds = input.durationSeconds === undefined ? undefined : Math.max(0, Math.min(600, Math.round(input.durationSeconds)));
  await F.setDoc(F.doc(db, "feedbackReports", input.reportId, "files", id), {
    name, kind: input.kind, contentType: input.contentType, bytes: bytes.length, chunks: chunkCount(bytes.length),
    ...(durationSeconds === undefined ? {} : { durationSeconds }), created: F.serverTimestamp(),
  });
  return { id, name, kind: input.kind, contentType: input.contentType, size: bytes.length, ...(durationSeconds === undefined ? {} : { durationSeconds }) };
}

/** The whole report with every file's bytes (admins only; anyone else gets Firestore's permission-denied). */
export async function readFeedbackReport(db: Firestore, reportId: string): Promise<LoadedReport | null> {
  const F = await import("firebase/firestore");
  const report = await F.getDoc(F.doc(db, "feedbackReports", reportId));
  if (!report.exists()) return null;
  const records = await F.getDocs(F.collection(db, "feedbackReports", reportId, "files"));
  const files = await Promise.all(records.docs.map(async (record) => {
    const data = record.data() as { name: string; kind: FeedbackFileKind; contentType: string; bytes: number; chunks: number; durationSeconds?: number; created?: { toMillis(): number } };
    const parts = await Promise.all(Array.from({ length: data.chunks }, (_, index) => F.getDoc(F.doc(db, "feedbackReports", reportId, "chunks", chunkId(record.id, index)))));
    const pieces = parts.map((part) => (part.exists() ? (part.data().data as Bytes).toUint8Array() : new Uint8Array(0)));
    const file: LoadedFile = {
      id: record.id, name: data.name, kind: data.kind, contentType: data.contentType, size: data.bytes,
      ...(data.durationSeconds === undefined ? {} : { durationSeconds: data.durationSeconds }),
      blob: new Blob(pieces as BlobPart[], { type: data.contentType }),
      complete: parts.every((part) => part.exists()) && pieces.reduce((total, piece) => total + piece.length, 0) === data.bytes,
    };
    return { file, order: data.created?.toMillis() ?? 0 };
  }));
  const kindOrder: Record<string, number> = { screenshot: 0, voice: 1, file: 2 };
  files.sort((a, b) => (kindOrder[a.file.kind] ?? 3) - (kindOrder[b.file.kind] ?? 3) || a.order - b.order);
  const data = report.data() as { owner: string; source: string; created?: { toDate(): Date } };
  return { id: reportId, owner: data.owner, source: data.source, created: data.created?.toDate() ?? null, files: files.map((entry) => entry.file) };
}
