import { useEffect, useState } from "react";
import { ImageOff, LoaderCircle, RotateCcw } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { GameButton } from "./kit/game";
import { ScreenBackdrop } from "./screen-parts";
import { keepRecord, recordMatch, RESUME_AFTER_RELOAD } from "./MatchLibrary";

/**
 * The WebGL context is gone (game.ts contextLost: a phone dropped the tab's GPU memory, the GPU reset). While the
 * browser gives it back the match waits behind "Restoring graphics"; if it never does, or a sheet cannot be had again,
 * the match is saved on this device and a reload resumes it (App.tsx, RESUME_AFTER_RELOAD).
 */
export function GraphicsState({ game }: { game: Game }) {
  const graphics = useStore((s) => s.graphics);
  const [saved, setSaved] = useState<"saving" | "saved" | "none">("saving");
  useEffect(() => {
    if (graphics !== "failed") return;
    let alive = true;
    const { phase } = useStore.getState();
    if (phase !== "playing" || game.multiplayer || game.replayMatch || game.sandbox || game.editor?.active) { setSaved("none"); return; }
    void (async () => {
      try {
        const record = await recordMatch(game);
        keepRecord(record);
        try { sessionStorage.setItem(RESUME_AFTER_RELOAD, record.id); } catch { /* the save is still in the list */ }
        if (alive) setSaved("saved");
      } catch (e) {
        console.warn("graphics: could not save the match", e);
        if (alive) setSaved("none");
      }
    })();
    return () => { alive = false; };
  }, [graphics, game]);

  if (graphics === "ok") return null;
  if (graphics === "failed") {
    return (
      <div className="er-root" data-ui-sfx role="alertdialog" aria-modal="true" aria-labelledby="gx-title" aria-describedby="gx-text">
        <ScreenBackdrop />
        <section className="er-panel">
          <span className="er-icon" aria-hidden="true"><ImageOff size={26} /></span>
          <h1 id="gx-title">The graphics were reset</h1>
          <p id="gx-text">{saved === "saving" ? "Saving your match on this device…"
            : saved === "saved" ? "Your match is saved on this device. Reload to carry on where you left off."
            : "The browser took the game's graphics away. Reload to play again."}</p>
          <div className="er-actions">
            <GameButton variant="primary" size="lg" icon={<RotateCcw size={16} />} disabled={saved === "saving"} onClick={() => location.reload()}>Reload</GameButton>
          </div>
        </section>
      </div>
    );
  }
  return (
    <div className="gx-restoring" role="status" aria-live="polite" data-graphics={graphics}>
      <div>
        <LoaderCircle className="menu-spin" size={22} aria-hidden="true" />
        <b>Restoring graphics…</b>
        <span>{game.multiplayer ? "The match goes on meanwhile." : game.editor?.active ? "Your map stays as it is meanwhile." : "The match is paused until they are back."}</span>
      </div>
    </div>
  );
}
