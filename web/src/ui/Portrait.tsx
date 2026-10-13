import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { castInitials, castMember, castPortrait } from "../campaign";

// Campaign pictures that load only once they are on screen (posters, cast portraits): the campaign screen lists eleven
// chapters and the CDN should see a request only for what the player can actually see.

/** True once the element has been on screen (and stays true). */
export function useOnScreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setSeen(true); });
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

/** An image whose request waits until it is on screen; `fallback` shows until it loads, and instead of it if it fails. */
export function LazyImage({ src, fallback, className, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { src: string | null; fallback?: ReactNode }) {
  const [ref, seen] = useOnScreen<HTMLSpanElement>();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => setState("loading"), [src]);
  return (
    <span ref={ref} className={`lazy-img${className ? ` ${className}` : ""}`} data-state={src ? state : "failed"}>
      {seen && src && state !== "failed" && <img src={src} alt="" draggable={false} decoding="async" {...props} onLoad={() => setState("ready")} onError={() => setState("failed")} />}
      {(state !== "ready" || !src) && fallback}
    </span>
  );
}

/** A cast member's portrait (cast/<id>.webp on the CDN), or their initials until one is published. Decorative: the
 * name is always written beside it. */
export function CastPortrait({ id, className }: { id: string; className?: string }) {
  return (
    <span className={`cast-portrait${className ? ` ${className}` : ""}`} data-cast={id} title={castMember(id)?.name} aria-hidden="true">
      <LazyImage src={castPortrait(id)} crossOrigin="anonymous" fallback={<b className="cast-initials">{castInitials(id)}</b>} />
    </span>
  );
}
