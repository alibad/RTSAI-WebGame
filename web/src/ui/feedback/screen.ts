// The screen as the player sees it (menus, dialogs, the HUD and the battlefield), without the browser's share prompt:
// the page is drawn by modern-screenshot (DOM to SVG to canvas, loaded only when feedback needs it). A WebGL canvas
// reads back blank outside its own frame, so the battlefield's last drawn frame is laid over it while the page is drawn.
import type { Game } from "../../game";
import { FEEDBACK_ROOT_ID } from "./media";

/** Elements never in the screenshot: the feedback dialog and its launcher. */
export const FEEDBACK_LAUNCHER_CLASS = "gfb-launcher";

export async function captureScreen(game: Game): Promise<HTMLCanvasElement> {
  const stage = game.canvas;
  let still: HTMLCanvasElement | null = null;
  if (stage.isConnected && getComputedStyle(stage).visibility !== "hidden") {
    try {
      still = await game.captureFrame();
      still.className = stage.className;
      still.style.cssText = stage.style.cssText;
      still.setAttribute("aria-hidden", "true");
      stage.after(still);
    } catch { /* no frame drawn in time: the battlefield stays dark in the screenshot */ }
  }
  try {
    const { domToCanvas } = await import("modern-screenshot");
    const width = innerWidth, height = innerHeight;
    return await domToCanvas(document.body, {
      width, height,
      // At most 1920 px wide: the screenshot is sent as a JPEG of that size anyway (toJpeg).
      scale: Math.min(devicePixelRatio || 1, 1920 / width),
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      timeout: 4000,
      filter: (node) => !(node instanceof Element) || (node.id !== FEEDBACK_ROOT_ID && !node.classList.contains(FEEDBACK_LAUNCHER_CLASS)),
    });
  } finally {
    still?.remove();
  }
}
