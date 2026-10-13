import type { CSSProperties, ReactNode } from "react";

// Shared pieces of the out-of-match screens (ui/screens.css), on top of the game kit (ui/kit/game.tsx): the battlefield
// drifting behind a screen, gold targeting brackets, an on/off switch, a row of choices and a progress bar.

/** The battlefield behind a screen, as the main menu draws it: drifting art under a dark shade. */
export function ScreenBackdrop({ image = "menu/backdrop.webp", soft = false }: { image?: string; soft?: boolean }) {
  return <>
    <div className={soft ? "scr-backdrop soft" : "scr-backdrop"} style={{ backgroundImage: `url("${image}")` }} aria-hidden="true" />
    <div className="scr-shade" aria-hidden="true" />
  </>;
}

/** Gold corner brackets around the parent (which must be positioned): shown on hover, focus and selection. */
export function Brackets({ className }: { className?: string }) {
  return <span className={`scr-brackets${className ? ` ${className}` : ""}`} aria-hidden="true"><i /><i /><i /><i /></span>;
}

/** An on/off switch with its label (accessible as a switch named by the label). */
export function Toggle({ label, checked, onChange, disabled, title }: { label: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="scr-switch" disabled={disabled} title={title} onClick={() => onChange(!checked)}>
      <span className="scr-switch-label">{label}</span>
      <span className="scr-switch-track" aria-hidden="true"><i /></span>
    </button>
  );
}

/** A few mutually exclusive choices side by side (difficulty, mode). */
export function Segmented<V extends string>({ label, value, options, onChange }: { label: string; value: V; options: readonly { value: V; label: string }[]; onChange: (value: V) => void }) {
  return (
    <div className="scr-segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** A gold progress bar (0..1). */
export function Meter({ value, label, className }: { value: number; label?: string; className?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={`scr-meter${className ? ` ${className}` : ""}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <i style={{ "--fill": `${pct}%` } as CSSProperties} />
    </div>
  );
}
