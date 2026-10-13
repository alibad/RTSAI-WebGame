"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export type DictationField = string;

type RecognitionAlternative = { transcript: string };
type RecognitionResult = { isFinal: boolean; 0: RecognitionAlternative };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type RecognitionErrorEvent = { error: string };

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
};

function recognitionConstructor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const subscribeToNothing = () => () => {};

const MESSAGES: Record<string, string> = {
  "not-allowed": "Microphone access was not allowed. You can still type.",
  "service-not-allowed": "The speech service was not allowed. You can still type.",
  "no-speech": "No speech was detected. Your text is safe — tap the mic to resume.",
  "audio-capture": "No microphone is available. You can still type.",
  network: "The speech service is offline. Your text is safe.",
};

/**
 * Dictation into a specific text box.
 *
 * Fills the field; never attaches audio. Typing is always the guaranteed
 * path, so an unsupported browser or a denied microphone leaves the form
 * completely usable and only reports what happened.
 *
 * Field-agnostic on purpose: pass whatever keys the host form uses and the
 * hook tracks which one is listening. Only one may hold the microphone.
 */
export function useFeedbackDictation(options: {
  getText: (field: DictationField) => string;
  setText: (field: DictationField, value: string) => void;
  onNotice?: (message: string) => void;
  limits?: Record<string, number>;
}) {
  const { getText, setText, onNotice, limits } = options;
  const [field, setField] = useState<DictationField | null>(null);
  // Browser capability, read without a setState-in-effect: false on the server.
  const supported = useSyncExternalStore(
    subscribeToNothing,
    () => Boolean(recognitionConstructor()),
    () => false,
  );

  const recognition = useRef<Recognition | null>(null);
  const prefix = useRef("");
  const finalWords = useRef("");
  const deliberate = useRef(false);
  // Kept in a ref so a re-render never tears down a running session.
  const latest = useRef({ getText, setText, onNotice, limits });
  useEffect(() => {
    latest.current = { getText, setText, onNotice, limits };
  });

  const stop = useCallback(() => {
    deliberate.current = true;
    recognition.current?.stop();
    recognition.current = null;
    setField(null);
  }, []);

  // Never leave the microphone running behind a closed dialog.
  useEffect(
    () => () => {
      deliberate.current = true;
      recognition.current?.stop();
      recognition.current = null;
    },
    [],
  );

  const start = useCallback((next: DictationField) => {
    const Ctor = recognitionConstructor();
    if (!Ctor) {
      latest.current.onNotice?.(
        "Dictation is not supported in this browser. You can still type.",
      );
      return;
    }

    const instance = new Ctor();
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;
    instance.lang =
      (typeof document !== "undefined" && document.documentElement.lang) ||
      (typeof navigator !== "undefined" ? navigator.language : "en-US");

    // Whatever is already typed is kept: dictation appends to it, so speaking
    // never destroys a half-written sentence.
    prefix.current = latest.current.getText(next).trimEnd();
    finalWords.current = "";
    deliberate.current = false;

    instance.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const words = result?.[0]?.transcript ?? "";
        if (result?.isFinal) finalWords.current = `${finalWords.current} ${words}`.trim();
        else interim += words;
      }
      const spoken = `${finalWords.current} ${interim}`.trim();
      const joined = [prefix.current, spoken].filter(Boolean).join(" ");
      const limit = latest.current.limits?.[next];
      latest.current.setText(next, limit ? joined.slice(0, limit) : joined);
    };

    instance.onerror = (event) => {
      deliberate.current = true;
      recognition.current = null;
      setField(null);
      if (event.error === "aborted") return;
      latest.current.onNotice?.(
        MESSAGES[event.error] ?? "Dictation stopped. Your text is safe.",
      );
    };

    instance.onend = () => {
      recognition.current = null;
      setField(null);
      if (!deliberate.current) {
        latest.current.onNotice?.(
          "Dictation paused after a quiet moment. Tap the mic to continue.",
        );
      }
    };

    try {
      instance.start();
    } catch {
      latest.current.onNotice?.("Dictation could not start. You can still type.");
      return;
    }
    recognition.current = instance;
    setField(next);
  }, []);

  const toggle = useCallback(
    (next: DictationField) => {
      if (field === next) {
        stop();
        return;
      }
      // One microphone consumer at a time.
      if (field) stop();
      start(next);
    },
    [field, start, stop],
  );

  return { supported, listening: field, toggle, stop };
}

/**
 * The mic that lives inside a text box.
 *
 * Styled inline rather than through a design system so it drops into any of
 * these widgets unchanged, and coloured with `currentColor` so it inherits
 * whatever the surrounding field already uses in either theme.
 *
 * Small on purpose: the listening state must not take over the field, so the
 * stop square carries the same visual weight as the mic it replaces. The 44px
 * button is the tap target; the glyph inside it is 18px.
 */
export function DictationButton(props: {
  field: DictationField;
  listening: DictationField | null;
  onToggle: (field: DictationField) => void;
  disabled?: boolean;
  /** Distance from the field's top edge. Raise it for a multi-line box. */
  top?: number;
}) {
  const active = props.listening === props.field;
  return (
    <button
      type="button"
      onClick={() => props.onToggle(props.field)}
      disabled={props.disabled}
      aria-label={active ? "Stop dictating" : "Dictate this field"}
      aria-pressed={active}
      title={active ? "Stop dictating" : "Speak instead of typing"}
      style={{
        position: "absolute",
        top: props.top ?? 0,
        right: 0,
        width: 44,
        height: 44,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "none",
        border: "none",
        padding: 0,
        cursor: props.disabled ? "default" : "pointer",
        opacity: props.disabled ? 0.4 : 0.75,
        color: "currentColor",
      }}
    >
      {active ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 30,
            height: 30,
            borderRadius: "50%",
            background: "rgba(220,38,38,0.16)",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4" y="4" width="16" height="16" rx="2" fill="#dc2626" />
          </svg>
        </span>
      ) : (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </svg>
      )}
    </button>
  );
}
