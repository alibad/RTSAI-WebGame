// RA2-style sidebar: radar, credits, power, repair/sell, build tabs and the cameo palette. Every action is an
// engine command with the desktop palette's rules (left: build / place / resume, Shift: x5; right: hold, then
// cancel; Ctrl+right: cancel all).

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Game } from "../game";
import type { CatalogItem, QueuedItem } from "../sim/protocol";
import { useStore } from "../store";
import { Minimap } from "./Minimap";
import { PowerIcon, QUEUE_ICONS, RepairIcon, SellIcon } from "./icons";
import { cn } from "../lib/utils";
import { CameoTip } from "./CameoTip";

function Credits() {
  const cash = useStore((s) => s.ui?.cash ?? 0);
  const [shown, setShown] = useState(cash);
  const target = useRef(cash);
  target.current = cash;
  // Count towards the real value like the desktop counter (fast for big jumps).
  useEffect(() => {
    let raf = 0;
    const step = () => {
      setShown((v) => {
        const d = target.current - v;
        if (d === 0) return v;
        const s = Math.sign(d) * Math.max(1, Math.ceil(Math.abs(d) / 8));
        return Math.abs(s) >= Math.abs(d) ? target.current : v + s;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="digits text-[19px] font-semibold tracking-wide text-[var(--hud-gold)] drop-shadow-[0_1px_0_#000]" title="Credits">
      <span className="mr-1 text-[var(--hud-gold-dim)]">$</span>{shown.toLocaleString("en-US")}
    </div>
  );
}

function PowerBar({ height }: { height: number }) {
  const power = useStore((s) => s.ui?.power);
  const provided = power?.provided ?? 0;
  const drained = power?.drained ?? 0;
  const max = Math.max(100, provided, drained) * 1.1;
  const color = power?.state === "Critical" ? "var(--hud-red)" : power?.state === "Low" ? "var(--hud-yellow)" : "var(--hud-green)";
  const segs = Math.floor(height / 5);
  const lit = Math.round((provided / max) * segs);
  const drainAt = height - (drained / max) * height;
  return (
    <div className="hud-inset relative shrink-0" style={{ width: 12, height }} title={`Power ${provided} / ${drained}`}>
      <div className="absolute inset-x-[2px] bottom-[2px] top-[2px] flex flex-col-reverse gap-[1px]">
        {Array.from({ length: segs - 1 }, (_, i) => (
          <div key={i} className="h-[4px] rounded-[1px]" style={{ background: i < lit ? color : "#141814", boxShadow: i < lit ? `0 0 4px ${color}` : undefined }} />
        ))}
      </div>
      <div className="absolute inset-x-[-2px] h-[2px] bg-white/90 shadow-[0_0_3px_#fff]" style={{ top: Math.max(0, Math.min(height - 2, drainAt)) }} />
    </div>
  );
}

interface CameoProps {
  item: CatalogItem;
  queue: string;
  icon: string | null | undefined;
  progress: number; // 0..1 of the first queued copy, -1 when not queued
  count: number;
  paused: boolean;
  done: boolean;
  placing: boolean;
  onPress: (item: string, e: { button: number; shiftKey: boolean; ctrlKey: boolean }) => void;
  onHover: (item: CatalogItem | null, top: number) => void;
}

const LONG_PRESS_MS = 450;

const Cameo = memo(function Cameo({ item, queue, icon, progress, count, paused, done, placing, onPress, onHover }: CameoProps) {
  const deg = progress >= 0 ? progress * 360 : 0;
  // Touch: tap builds, a long press holds (and cancels) like a right-click.
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; held: boolean }>({ timer: null, held: false });
  return (
    <button
      type="button"
      className={cn("cameo hud-inset group", done && "ring-1 ring-[var(--hud-gold)]", placing && "ring-2 ring-[var(--hud-gold)]")}
      data-disabled={!item.buildable && count === 0}
      onPointerDown={(e) => {
        e.preventDefault();
        if (e.pointerType !== "touch") { onPress(item.name, e); return; }
        press.current.held = false;
        press.current.timer = setTimeout(() => {
          press.current.held = true;
          onPress(item.name, { button: 2, shiftKey: false, ctrlKey: false });
          navigator.vibrate?.(12);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={(e) => {
        if (e.pointerType !== "touch") return;
        if (press.current.timer) clearTimeout(press.current.timer);
        press.current.timer = null;
        if (!press.current.held) onPress(item.name, { button: 0, shiftKey: false, ctrlKey: false });
      }}
      onPointerCancel={() => { if (press.current.timer) clearTimeout(press.current.timer); press.current.timer = null; }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerEnter={(e) => { if (e.pointerType === "mouse") onHover(item, e.currentTarget.getBoundingClientRect().top); }}
      onPointerLeave={() => onHover(null, 0)}
      aria-label={item.label}
      data-queue={queue}
      data-item={item.name}
    >
      {icon ? <img src={icon} alt="" draggable={false} /> : <div className="grid h-full w-full place-items-center bg-[#111] px-1 text-center text-[10px] leading-tight text-[var(--muted-foreground)]">{item.label}</div>}
      {progress >= 0 && !done && (
        <div className="wipe" style={{ background: `conic-gradient(transparent 0deg ${deg}deg, rgba(0, 0, 0, 0.62) ${deg}deg 360deg)` }} />
      )}
      {done && <div className="wipe ready-pulse" style={{ boxShadow: "inset 0 0 0 2px var(--hud-gold), inset 0 0 16px rgba(241,210,139,0.45)" }} />}
      {paused && (
        <div className="wipe grid place-items-center bg-black/35">
          <svg viewBox="0 0 24 24" width={20} height={20} fill="var(--hud-gold)"><path d="M7 5h4v14H7Zm6 0h4v14h-4Z" /></svg>
        </div>
      )}
      {count > 1 && <span className="digits absolute left-[3px] top-[1px] text-[12px] font-bold text-white drop-shadow-[0_1px_1px_#000]">{count}</span>}
    </button>
  );
});

function Tabs() {
  const catalog = useStore((s) => s.catalog);
  const queues = useStore((s) => s.ui?.queues);
  const tab = useStore((s) => s.tab);
  const set = useStore((s) => s.set);
  return (
    <div className="grid grid-cols-6 gap-[3px]">
      {catalog.map((q) => {
        const Icon = QUEUE_ICONS[q.type] ?? QUEUE_ICONS.Building;
        const state = queues?.find((x) => x.type === q.type);
        const enabled = (state?.enabled ?? false) && q.items.length > 0;
        const ready = state?.items.some((i) => i.done);
        const busy = state?.items.some((i) => !i.done && !i.paused);
        return (
          <button
            key={q.type}
            type="button"
            title={q.type}
            disabled={!enabled}
            onClick={() => set({ tab: q.type })}
            className={cn(
              "hud-inset relative grid h-[30px] place-items-center text-[var(--muted-foreground)] transition-colors disabled:opacity-30",
              tab === q.type && enabled && "text-[var(--hud-gold)] shadow-[inset_0_0_0_1px_var(--hud-gold-dim),inset_0_0_10px_rgba(241,210,139,0.25)]",
              enabled && tab !== q.type && "hover:text-[var(--foreground)]",
            )}
          >
            <Icon />
            {ready && <span className="ready-pulse absolute right-[2px] top-[2px] size-[6px] rounded-full bg-[var(--hud-gold)]" />}
            {!ready && busy && <span className="absolute right-[2px] top-[2px] size-[6px] rounded-full bg-[var(--hud-green)]" />}
          </button>
        );
      })}
    </div>
  );
}

function Palette({ game, height }: { game: Game; height: number }) {
  const tab = useStore((s) => s.tab);
  const catalog = useStore((s) => s.catalog);
  const queues = useStore((s) => s.ui?.queues);
  const icons = useStore((s) => s.icons);
  const mode = useStore((s) => s.ui?.mode ?? "");
  const q = catalog.find((c) => c.type === tab);
  const state = queues?.find((x) => x.type === tab);
  const [hover, setHover] = useState<{ name: string; top: number } | null>(null);
  const onHover = useCallback((item: CatalogItem | null, top: number) => setHover(item ? { name: item.name, top } : null), []);
  // The live catalog entry (buildable and requirements change while hovering).
  const hovered = hover ? q?.items.find((i) => i.name === hover.name) : undefined;

  const onPress = (item: string, e: { button: number; shiftKey: boolean; ctrlKey: boolean }) => {
    if (e.button === 0) game.command({ cmd: "produce", queue: tab, item, count: e.shiftKey ? 5 : 1, front: e.ctrlKey });
    else if (e.button === 2) game.command({ cmd: "hold", queue: tab, item, count: e.shiftKey ? 5 : 1, all: e.ctrlKey });
  };

  const byItem = new Map<string, QueuedItem[]>();
  for (const it of state?.items ?? []) byItem.set(it.name, [...(byItem.get(it.name) ?? []), it]);

  return (
    <div className="no-scrollbar grid content-start grid-cols-2 gap-[3px] overflow-y-auto pr-[1px]" style={{ height }}>
      {q?.items.map((item) => {
        const queued = byItem.get(item.name) ?? [];
        const first = queued[0];
        return (
          <Cameo
            key={item.name}
            item={item}
            queue={tab}
            icon={icons[item.name]}
            progress={first ? first.progress : -1}
            count={queued.length}
            paused={!!first?.paused}
            done={!!first?.done}
            placing={mode === "place" && !!first?.done}
            onPress={onPress}
            onHover={onHover}
          />
        );
      })}
      {hovered && <CameoTip item={hovered} top={hover!.top} />}
    </div>
  );
}

function ModeButton({ active, title, hotkey, onClick, children }: { active: boolean; title: string; hotkey: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={`${title} (${hotkey})`}
      onClick={onClick}
      className={cn("hud-inset relative grid size-[30px] place-items-center text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
        active && "text-[var(--hud-gold)] shadow-[inset_0_0_0_1px_var(--hud-gold),inset_0_0_10px_rgba(241,210,139,0.35)]")}
    >
      {children}
      <span className="digits absolute bottom-0 right-[2px] text-[9px] text-[var(--hud-gold-dim)]">{hotkey}</span>
    </button>
  );
}

export function Sidebar({ game }: { game: Game }) {
  const mode = useStore((s) => s.ui?.mode ?? "");
  const [[w, h], setSize] = useState([window.innerWidth, window.innerHeight]);
  useEffect(() => {
    const r = () => setSize([window.innerWidth, window.innerHeight]);
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, []);
  // Compact sidebar on phones and small tablets (styles.css narrows --sidebar-w to match).
  const compact = h < 600 || w < 900;
  const radarSize = compact ? Math.max(96, Math.min(168, Math.floor(h * 0.3))) : 232;
  const paletteH = Math.max(150, h - radarSize - 8 - 44 - 36 - 28);
  return (
    <aside className="hud-panel absolute right-0 top-0 flex h-full flex-col gap-[6px] p-[8px]" style={{ width: "var(--sidebar-w)" }} onContextMenu={(e) => e.preventDefault()}>
      <Minimap game={game} size={radarSize} />
      <div className="flex items-center justify-between gap-2 px-[2px]">
        <Credits />
        <div className="flex gap-[3px]">
          <ModeButton active={mode === "repair"} title="Repair" hotkey="Z" onClick={() => game.setMode("repair")}><RepairIcon width={18} height={18} /></ModeButton>
          <ModeButton active={mode === "sell"} title="Sell" hotkey="Q" onClick={() => game.setMode("sell")}><SellIcon width={18} height={18} /></ModeButton>
        </div>
      </div>
      <Tabs />
      <div className="flex min-h-0 flex-1 gap-[5px]">
        <div className="flex flex-col items-center gap-1">
          <PowerIcon width={12} height={12} className="text-[var(--hud-power)]" />
          <PowerBar height={paletteH - 16} />
        </div>
        <div className="min-w-0 flex-1"><Palette game={game} height={paletteH} /></div>
      </div>
    </aside>
  );
}
