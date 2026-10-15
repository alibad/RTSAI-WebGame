import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";

// The game's own UI kit: every menu, dialog and panel is built from these so they share one look (ui/kit/game.css):
// dark bevelled panels, gold for what matters, the mod's cursors, hover and press feedback with sound ([data-ui-sfx],
// ui/feel.ts). Keep text short; put the content (maps, units, flags, pictures) first.

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

/** A game button. Primary is the screen's main action (one per view); secondary and ghost for the rest. */
export function GameButton({ variant = "secondary", size = "md", icon, className, children, ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <button type="button" {...props} className={`gbtn gbtn-${variant} gbtn-${size}${className ? ` ${className}` : ""}`}>
      {icon}{children}
    </button>
  );
}

/** A dialog over the game: eyebrow and title, a close button, Escape and a click outside close it. */
export function GameDialog({ title, eyebrow, onClose, footer, size = "md", label, children }: {
  title: ReactNode; eyebrow?: string; onClose: () => void; footer?: ReactNode; size?: "sm" | "md" | "lg" | "xl"; label?: string; children: ReactNode;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Portaled pickers get the first Escape; keep this dialog open while they restore focus.
      if (e.key !== "Escape" || document.querySelector('[aria-haspopup="listbox"][aria-expanded="true"], [role="combobox"][aria-expanded="true"]')) return;
      e.stopPropagation(); close.current();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);
  const name = label ?? (typeof title === "string" ? title : undefined);
  return (
    <div className="gd-overlay" role="dialog" aria-modal="true" aria-label={name} data-ui-sfx onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`gd-panel gd-${size}`}>
        <header className="gd-header">
          <div className="min-w-0">{eyebrow && <span className="menu-eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>
          <button type="button" className="gd-close" aria-label={name ? `Close ${name.toLowerCase()}` : "Close"} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="gd-body">{children}</div>
        {footer && <footer className="gd-footer">{footer}</footer>}
      </div>
    </div>
  );
}

/** A titled group inside a dialog or panel (small gold caps heading with an icon). */
export function GameSection({ icon, title, children, className }: { icon?: ReactNode; title: string; children: ReactNode; className?: string }) {
  return <section className={`gd-section${className ? ` ${className}` : ""}`}><h3>{icon}{title}</h3>{children}</section>;
}

/** Nothing to show yet: an icon, one line of title, one line of help, optionally an action. */
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="g-empty">
      {icon && <span className="g-empty-icon" aria-hidden="true">{icon}</span>}
      <b>{title}</b>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** A button that opens the file chooser (never the browser's raw "Choose File" control). */
export function FilePickButton({ accept, onFile, icon, children, variant = "secondary", size = "md" }: {
  accept?: string; onFile: (file: File) => void; icon?: ReactNode; children: ReactNode; variant?: ButtonVariant; size?: ButtonSize;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <GameButton variant={variant} size={size} icon={icon} onClick={() => input.current?.click()}>{children}</GameButton>
      <input ref={input} type="file" accept={accept} hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) onFile(f); }} />
    </>
  );
}

/** A small key hint, as on a keyboard ("G", "Esc"). */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="g-kbd">{children}</kbd>;
}
