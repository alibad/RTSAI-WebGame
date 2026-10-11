// The radar: terrain colours from the engine (Map.GetTerrainColorPair), blips from IRadarSignature, the render
// player's shroud, and the camera frame. Left click/drag moves the camera, right click orders the selection.
// Offline (static) until the player owns a working radar building, as in the desktop game.

import { useEffect, useRef } from "react";
import type { Game } from "../game";
import { useStore } from "../store";

export function Minimap({ game, size }: { game: Game; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const online = useStore((s) => s.ui?.radar ?? false);
  const info = useStore((s) => s.info);
  const publicShot = useStore((s) => s.publicShot);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !info) return;
    const radar = game.radar;
    const [L, T, R, B] = info.mapBounds;
    const iso = info.gridType !== "Rectangular";
    const sx = iso ? 2 * L : L, sw = iso ? 2 * (R - L) + 1 : R - L, sy = T, sh = B - T;
    const scale = Math.min(size / sw, size / sh);
    const cw = Math.round(sw * scale), ch = Math.round(sh * scale);
    const offX = Math.round((size - cw) / 2), offY = Math.round((size - ch) / 2);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext("2d")!;
    const base = document.createElement("canvas");
    let raf = 0;
    let drawnVersion = -1;
    let lastView = "";
    const [ox, oy] = info.cellOrigin;
    const hw = info.tileSize[0] / (iso ? 2 : 1), hh = info.tileSize[1] / (iso ? 2 : 1);
    const toCanvas = (wx: number, wy: number): [number, number] => [
      offX + ((wx - ox) / hw + (iso ? 1 : 0.5) - sx) * scale,
      offY + ((wy - oy) / hh + 0.5 - sy) * scale,
    ];
    const toWorld = (cx: number, cy: number): [number, number] => [
      ox + ((cx - offX) / scale + sx - (iso ? 1 : 0.5)) * hw,
      oy + ((cy - offY) / scale + sy - 0.5) * hh,
    ];

    const rebuild = () => {
      if (!radar.terrain) return;
      base.width = radar.width;
      base.height = radar.height;
      const img = new ImageData(new Uint8ClampedArray(radar.terrain.data), radar.width, radar.height);
      const px = img.data;
      const W = radar.width;
      // Blips (each cell is two pixels wide on the isometric radar).
      const b = radar.blips;
      for (let i = 0; i + 2 < b.length; i += 3) {
        const u = b[i], v = b[i + 1], argb = b[i + 2] >>> 0;
        const x = iso ? 2 * u + (v & 1) : u;
        for (const xx of (iso ? [x, x + 1] : [x])) {
          const o = (v * W + xx) * 4;
          if (o < 0 || o + 3 >= px.length) continue;
          px[o] = (argb >> 16) & 255; px[o + 1] = (argb >> 8) & 255; px[o + 2] = argb & 255; px[o + 3] = 255;
        }
      }
      // Shroud: black where unexplored, half dark where fogged.
      const sh = radar.shroud;
      if (sh) {
        const cols = radar.cols;
        for (let v = 0; v < radar.height; v++)
          for (let u = 0; u < cols; u++) {
            const s = sh[v * cols + u];
            if (s === 2) continue;
            const x = iso ? 2 * u + (v & 1) : u;
            for (const xx of (iso ? [x, x + 1] : [x])) {
              const o = (v * W + xx) * 4;
              if (s === 0) { px[o] = px[o + 1] = px[o + 2] = 0; }
              else { px[o] >>= 1; px[o + 1] >>= 1; px[o + 2] >>= 1; }
            }
          }
      }
      base.getContext("2d")!.putImageData(img, 0, 0);
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const [x0, y0, x1, y1] = game.viewRect();
      const viewKey = `${x0 | 0},${y0 | 0},${x1 | 0},${y1 | 0}`;
      if (drawnVersion === radar.version && viewKey === lastView) return;
      if (drawnVersion !== radar.version) rebuild();
      drawnVersion = radar.version;
      lastView = viewKey;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#020302";
      ctx.fillRect(0, 0, size, size);
      ctx.imageSmoothingEnabled = scale < 2;
      ctx.drawImage(base, sx, sy, sw, sh, offX, offY, cw, ch);
      const [ax, ay] = toCanvas(x0, y0);
      const [bx, by] = toCanvas(x1, y1);
      ctx.strokeStyle = "rgba(241, 210, 139, 0.95)";
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(ax) + 0.5, Math.round(ay) + 0.5, Math.round(bx - ax), Math.round(by - ay));
    };
    draw();
    const unsub = radar.subscribe(() => { /* drawn on the next frame */ });

    let dragging = false;
    const at = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return toWorld(e.clientX - r.left, e.clientY - r.top);
    };
    const down = (e: PointerEvent) => {
      if (!game.ui?.radar) return;
      e.preventDefault();
      const [wx, wy] = at(e);
      if (e.button === 2) game.orderAt(wx, wy);
      else if (e.button === 0) {
        dragging = true;
        try { canvas.setPointerCapture(e.pointerId); } catch { /* the mouse lock's drawn pointer has no capture */ }
        game.lookAt(wx, wy);
      }
    };
    // The cursor over the minimap is the engine's too (RadarWidget.GetCursor, its "-minimap" variants).
    const move = (e: PointerEvent) => {
      const [wx, wy] = at(e);
      game.minimapHover = game.ui?.radar && e.pointerType !== "touch" ? { wx, wy, el: canvas } : null;
      if (dragging) game.lookAt(wx, wy);
    };
    const leave = () => { game.minimapHover = null; canvas.style.cursor = ""; };
    const up = () => { dragging = false; };
    const menu = (e: Event) => e.preventDefault();
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("contextmenu", menu);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointerleave", leave);
      game.minimapHover = null;
      canvas.removeEventListener("contextmenu", menu);
    };
  }, [game, info, size]);

  return (
    <div className="hud-inset relative" style={{ width: size, height: size }}>
      <canvas ref={ref} style={{ width: size, height: size, display: "block", opacity: online && !publicShot ? 1 : 0, transition: "opacity 600ms" }} />
      {!online && (
        <div className="absolute inset-0 grid place-items-center overflow-hidden">
          <div className="absolute inset-0 opacity-30" style={{ background: "repeating-linear-gradient(0deg, rgba(255,255,255,0.06) 0 1px, transparent 1px 3px)" }} />
          <svg viewBox="0 0 48 48" width={56} height={56} className="text-[var(--hud-edge-hi)]" aria-label="Radar offline">
            <circle cx="24" cy="24" r="19" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="24" cy="24" r="11" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.7" />
            <path d="M24 24 L38 12" stroke="currentColor" strokeWidth="2" />
            <path d="M8 40 L40 8" stroke="var(--hud-red)" strokeWidth="2.5" opacity="0.8" />
          </svg>
        </div>
      )}
    </div>
  );
}
