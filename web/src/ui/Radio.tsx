import { X } from "lucide-react";
import type { Game } from "../game";
import { castMember } from "../campaign";
import { useRadio } from "../radio";
import { useStore } from "../store";
import { CastPortrait } from "./Portrait";

/**
 * The radio call on air (radio.ts), docked under the operation's objectives: the speaker's portrait, name and line.
 * Only the dismiss button takes clicks; the rest lets them through to the battlefield.
 */
export function RadioPanel({ game }: { game: Game }) {
  const call = useRadio((s) => s.call);
  const waiting = useRadio((s) => s.waiting);
  const voice = useRadio((s) => s.voice);
  const paused = useStore((s) => s.paused);
  if (!call) return null;
  const who = castMember(call.speaker);
  return (
    <section key={call.key} className="rd-call" data-speaker={call.speaker} data-voice={voice} data-paused={paused || undefined} role="status" aria-live="polite" aria-label="Radio">
      <CastPortrait id={call.speaker} className="rd-portrait" />
      <div className="rd-text">
        <span className="rd-who">
          <span className="rd-waves" aria-hidden="true"><i /><i /><i /><i /></span>
          <b>{who?.name ?? call.speaker}</b>
          {waiting > 0 && <span className="rd-waiting digits" aria-label={`${waiting} more`}>+{waiting}</span>}
        </span>
        <p className="rd-line">{call.line}</p>
      </div>
      <button type="button" className="rd-skip" aria-label="Dismiss radio call" onClick={() => game.radio.skip()}><X size={13} aria-hidden="true" /></button>
    </section>
  );
}
