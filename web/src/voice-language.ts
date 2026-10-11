export type VoiceLanguage = "faction" | "en";
export const voiceLanguageKey = "rtsai.voiceLanguage.v1";
export function normalizeVoiceLanguage(value: unknown): VoiceLanguage { return value === "en" ? "en" : "faction"; }
export function readVoiceLanguage(): VoiceLanguage {
  try { return normalizeVoiceLanguage(localStorage.getItem(voiceLanguageKey)); } catch { return "faction"; }
}
export function saveVoiceLanguage(value: unknown): VoiceLanguage {
  const language = normalizeVoiceLanguage(value);
  try { localStorage.setItem(voiceLanguageKey, language); } catch { }
  return language;
}
