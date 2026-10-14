/** Web Audio is optional (some embedded WebKit builds omit it; older Safari uses the prefixed constructor). */
export function createAudioContext(options?: AudioContextOptions): AudioContext | null {
  const host = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const Constructor = host.AudioContext ?? host.webkitAudioContext;
  if (!Constructor) return null;
  try { return new Constructor(options); } catch { return null; }
}
