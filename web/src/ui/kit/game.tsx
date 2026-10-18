import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { FeedbackSlot } from "../feedback/slot";
import { FEEDBACK_ROOT_ID } from "../feedback/media";

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
  const panel = useRef<HTMLDivElement>(null);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"], a[href]') ?? [])].filter(el => el.getClientRects().length > 0);
    focusable()[0]?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      // Portaled pickers get the first Escape; keep this dialog open while they restore focus. So does feedback opened
      // over this dialog (its launcher stays above every dialog).
      if (document.querySelector('[aria-haspopup="listbox"][aria-expanded="true"], [role="combobox"][aria-expanded="true"]')) return;
      if (document.getElementById(FEEDBACK_ROOT_ID)) return;
      if (e.key === "Tab") {
        const elements = focusable(), first = elements[0], last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        return;
      }
      if (e.key !== "Escape") return;
      e.stopPropagation(); close.current();
    };
    addEventListener("keydown", onKey, true);
    return () => { removeEventListener("keydown", onKey, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const name = label ?? (typeof title === "string" ? title : undefined);
  return createPortal(
    <div ref={panel} className="gd-overlay" role="dialog" aria-modal="true" aria-label={name} data-ui-sfx onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`gd-panel gd-${size}`}>
        <header className="gd-header">
          <div className="min-w-0">{eyebrow && <span className="menu-eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>
          <div className="gd-header-actions">
            <FeedbackSlot kind="dialog" />
            <button type="button" className="gd-close" aria-label={name ? `Close ${name.toLowerCase()}` : "Close"} onClick={onClose}><X size={18} /></button>
          </div>
        </header>
        <div className="gd-body">{children}</div>
        {footer && <footer className="gd-footer">{footer}</footer>}
      </div>
    </div>, document.body
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
