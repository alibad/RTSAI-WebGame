import { useEffect, useRef, useState } from "react";
import type { Game } from "../game";
import { ACTOR_REPAIR_ACTIVE, ACTOR_REPAIR_REQUESTED, type Actor } from "../sim/protocol";
import { store } from "../store";
import { RepairIcon } from "./icons";

type RepairBadge = { id: number; label: string; active: boolean };

export function RepairIndicators({ game }: { game: Game }) {
  const [badges, setBadges] = useState<RepairBadge[]>([]);
  const layer = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<number, HTMLDivElement>());

  useEffect(() => {
    let frame = 0;
    let snapshot = game.client.cur;
    let actors = new Map<number, Actor>();
    let signature = "";
    let lastPaused: boolean | undefined;
    let lastCash: number | undefined;
    let initialized = false;
    const update = () => {
      const current = game.client.cur;
      const state = store.get();
      if (!initialized || current !== snapshot || state.paused !== lastPaused || state.ui?.cash !== lastCash) {
        initialized = true;
        snapshot = current;
        lastPaused = state.paused;
        lastCash = state.ui?.cash;
        actors = new Map();
        const next: RepairBadge[] = [];
        for (const actor of current?.actors ?? []) {
          if (!(actor.flags & ACTOR_REPAIR_REQUESTED) || !(actor.flags & 8) || (actor.flags & 16)
            || actor.hp <= 0 || actor.maxHp <= 0 || actor.hp >= actor.maxHp || actor.bw <= 0 || actor.bh <= 0) continue;
          const active = !!(actor.flags & ACTOR_REPAIR_ACTIVE);
          const own = current!.header.localPlayer >= 0 && actor.owner === current!.header.localPlayer;
          const label = state.paused ? "Repair paused" : active ? "Repairing"
            : own && lastCash !== undefined && lastCash <= 0 ? "Waiting for credits" : "Repair queued";
          actors.set(actor.id, actor);
          next.push({ id: actor.id, label, active: active && !state.paused });
        }
        const nextSignature = next.map(badge => `${badge.id}:${badge.label}:${badge.active}`).join("|");
        if (nextSignature !== signature) {
          signature = nextSignature;
          setBadges(next);
        }
      }
      const container = layer.current;
      if (container) {
        const rect = game.canvas.getBoundingClientRect();
        container.style.left = `${rect.left}px`;
        container.style.top = `${rect.top}px`;
        container.style.width = `${rect.width}px`;
        container.style.height = `${rect.height}px`;
        const dpr = window.devicePixelRatio || 1;
        const width = game.canvas.width || rect.width * dpr;
        const height = game.canvas.height || rect.height * dpr;
        const scaleX = rect.width / width;
        const scaleY = rect.height / height;
        for (const [id, element] of elements.current) {
          const actor = actors.get(id);
          if (!actor || rect.width <= 0 || rect.height <= 0 || state.phase !== "playing" || game.coach.review) {
            element.style.display = "none";
            continue;
          }
          const left = ((Math.round(actor.sx) + actor.bx - game.cam.x) * game.cam.zoom + width / 2) * scaleX;
          const top = ((Math.round(actor.sy) + actor.by - game.cam.y) * game.cam.zoom + height / 2) * scaleY;
          const right = left + actor.bw * game.cam.zoom * scaleX;
          const bottom = top + actor.bh * game.cam.zoom * scaleY;
          const x = (left + right) / 2;
          const y = top - 9;
          const visible = right > 0 && left < rect.width && bottom > 0 && top < rect.height
            && x > 0 && x < rect.width && y > 0 && y < rect.height;
          element.style.display = visible ? "flex" : "none";
          if (visible) {
            const transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
            if (element.style.transform !== transform) element.style.transform = transform;
          }
        }
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [game]);

  return (
    <div ref={layer} className="pointer-events-none fixed overflow-hidden" aria-label="Building repair status">
      {badges.map(badge => (
        <div key={badge.id} ref={element => { if (element) elements.current.set(badge.id, element); else elements.current.delete(badge.id); }}
          data-repair-actor={badge.id} data-repair-status={badge.label}
          className="pointer-events-none absolute left-0 top-0 hidden items-center gap-1.5 whitespace-nowrap rounded-full border border-[#d8b760]/70 bg-[#17190f]/95 px-2 py-1 text-[10px] font-semibold leading-none text-[#f2d58a] shadow-[0_2px_8px_#0009]">
          <RepairIcon width={13} height={13} aria-hidden="true" />
          <span>{badge.label}</span>
          {badge.active && <span className="size-1 rounded-full bg-[#f2d58a] shadow-[0_0_4px_#eac367]" aria-hidden="true" />}
        </div>
      ))}
    </div>
  );
}
