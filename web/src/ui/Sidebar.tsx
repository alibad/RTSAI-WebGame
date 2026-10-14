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
import { PowerMeter } from "./PowerMeter";
import { UnitPortrait } from "./UnitPortrait";
import { ReplaySidePanel, replayOf } from "./Replay";
import { keyFor } from "../preferences";

function SupportPowers({ game }: { game: Game }) {
  const powers = useStore((s) => s.ui?.supportPowers) ?? [];
  const icons = useStore((s) => s.icons);
  useEffect(() => { game.client.send({ type: "icons", names: powers.map((p) => `$power:${p.key}`) }); }, [game, powers.map((p) => p.key).join("|")]);
  if (!powers.length) return null;
  return <div className="flex max-h-[140px] shrink-0 flex-wrap gap-1 overflow-y-auto" aria-label="Support powers">
    {powers.map((p) => <button type="button" key={p.key} disabled={!p.ready}
      title={`${p.name}\n${p.description}`}
      onClick={() => game.command({ cmd: "supportpower", key: p.key })}
      className="hud-inset flex w-[70px] flex-col items-center overflow-hidden text-[9px] disabled:opacity-60">
      {icons[`$power:${p.key}`] && <img src={icons[`$power:${p.key}`]!} alt="" className="h-[42px] w-full object-contain" />}
      <span className="w-full truncate px-1">{p.name}</span>
      <span className="digits text-[var(--hud-gold)]">{p.ready ? "READY" : p.active ? formatTime(p.remaining) : "ON HOLD"}</span>
      <progress aria-label={`${p.name} charge`} value={Math.max(0, p.total - p.remaining)} max={Math.max(1, p.total)} className="h-1 w-full" />
    </button>)}
  </div>;
}

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

// The cameo overlays of the mod's ProductionPalette (OpenRA ProductionPaletteWidget with chrome/ingame-player.yaml):
// the build clock, READY / ON HOLD / remaining time centred, and the queued count at QueuedOffset (left aligned).
const READY_TEXT = "READY"; // supportpowers-support-powers-palette.ready (mods/common/fluent/chrome.ftl)
const HOLD_TEXT = "ON HOLD"; // supportpowers-support-powers-palette.hold
const CLOCK_FRAMES = 55; // sequences/misc.yaml clock: clock-rtsai.png, 55 frames
const TICK_MS = 40; // the web sim's GameTimestep (SimHost.BuildSession)
const READY_BLINK_MS = 360; // ReadyTextStyle AlternatingColor: TextColor / ReadyTextAltColor every 360 ms of game time

/** The clock frame for this progress, as the cleared angle of clock-rtsai.png (frame i shades angles >= 360 * i / 55). */
function clockAngle(progress: number) {
  const frame = Math.min(CLOCK_FRAMES - 1, Math.floor(progress * (CLOCK_FRAMES - 1) + 1e-6));
  return (360 * frame) / CLOCK_FRAMES;
}

/** WidgetUtils.FormatTime(ticks, leadingMinuteZero: true). */
function formatTime(ticks: number) {
  const seconds = Math.ceil((ticks * TICK_MS) / 1000);
  const minutes = Math.floor(seconds / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (minutes >= 60) return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
  return `${pad(minutes)}:${pad(seconds % 60)}`;
}

interface CameoProps {
  item: CatalogItem;
  queue: string;
  icon: string | null | undefined;
  progress: number; // 0..1 of the first queued copy, -1 when not queued
  count: number;
  paused: boolean;
  done: boolean;
  /** Queued but not the one the queue is building (ProductionQueue.IsProducing is false). */
  waiting: boolean;
  /** RemainingTimeActual of the first queued copy in ticks (0 until it starts). */
  remaining: number;
  /** READY in its alternate colour (gold) this frame. */
  readyAlt: boolean;
  placing: boolean;
  onPress: (item: string, e: { button: number; shiftKey: boolean; ctrlKey: boolean }) => void;
  onHover: (item: CatalogItem | null, top: number) => void;
}

const LONG_PRESS_MS = 450;

const Cameo = memo(function Cameo({ item, queue, icon, progress, count, paused, done, waiting, remaining, readyAlt, placing, onPress, onHover }: CameoProps) {
  const label = done ? READY_TEXT : paused ? HOLD_TEXT : !waiting && remaining > 0 ? formatTime(remaining) : "";
  // Touch: tap builds, a long press holds (and cancels) like a right-click.
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; held: boolean }>({ timer: null, held: false });
  return (
    <button
      type="button"
      className={cn("cameo hud-inset group", placing && "ring-2 ring-[var(--hud-gold)]")}
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
      <UnitPortrait type={item.name} label={item.label} icon={icon} />
      {count > 0 && !done && <div className="wipe clock" style={{ "--clock": `${clockAngle(progress)}deg` } as React.CSSProperties} />}
      {label && <span className={cn("cameo-text cameo-label", done && readyAlt && "alt")}>{label}</span>}
      {count > 0 && <span className="cameo-text cameo-count">{count}</span>}
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
            aria-pressed={tab === q.type && enabled}
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
  const tick = useStore((s) => s.ui?.tick ?? 0);
  const readyAlt = Math.floor((tick * TICK_MS) / READY_BLINK_MS) % 2 !== 0;
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
    <div className="no-scrollbar grid content-start grid-cols-2 gap-[3px] overflow-y-auto pr-[1px]" style={{ height, gridAutoRows: "max-content" }}>
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
            // ClassicProductionQueue builds only the front of the queue.
            waiting={!!first && !first.done && state?.items[0] !== first}
            remaining={first?.remaining ?? 0}
            readyAlt={!!first?.done && readyAlt}
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

function ModeButton({ active, title, hotkey, onClick, children, disabled }: { active: boolean; title: string; hotkey: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={`${title} (${hotkey})`}
      disabled={disabled}
      onClick={onClick}
      className={cn("hud-inset relative grid size-[30px] place-items-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-35",
        active && "text-[var(--hud-gold)] shadow-[inset_0_0_0_1px_var(--hud-gold),inset_0_0_10px_rgba(241,210,139,0.35)]")}
    >
      {children}
      <span className="digits absolute bottom-0 right-[2px] text-[9px] text-[var(--hud-gold-dim)]">{hotkey}</span>
    </button>
  );
}

export function Sidebar({ game }: { game: Game }) {
  const mode = useStore((s) => s.ui?.mode ?? "");
  // Watching a replay: nothing to build or order; the sidebar shows the sides instead (Replay.tsx).
  const replay = !!replayOf(game);
  const paletteSpace = useRef<HTMLDivElement>(null);
  const [availableHeight, setAvailableHeight] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setAvailableHeight(Math.floor(entry.contentRect.height)));
    if (paletteSpace.current) observer.observe(paletteSpace.current);
    return () => observer.disconnect();
  }, []);
  const [[w, h], setSize] = useState([window.innerWidth, window.innerHeight]);
  useEffect(() => {
    const r = () => setSize([window.innerWidth, window.innerHeight]);
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, []);
  // Compact sidebar on phones and small tablets (styles.css narrows --sidebar-w to match).
  const compact = h < 600 || w < 900;
  const radarSize = compact ? Math.max(96, Math.min(168, Math.floor(h * 0.3))) : 232;
  const paletteH = Math.max(80, availableHeight || h - radarSize - 8 - 44 - 36 - 28);
  return (
    <aside className="hud-panel absolute right-0 top-0 flex h-full flex-col gap-[6px] p-[8px]" style={{ width: "var(--sidebar-w)" }} onContextMenu={(e) => e.preventDefault()}>
      <Minimap game={game} size={radarSize} />
      <div className="flex items-center justify-between gap-2 px-[2px]">
        <Credits />
        <div className="flex gap-[3px]">
          <ModeButton active={mode === "repair"} title="Repair" hotkey={keyFor("repair").toUpperCase()} disabled={replay} onClick={() => game.setMode("repair")}><RepairIcon width={18} height={18} /></ModeButton>
          <ModeButton active={mode === "sell"} title="Sell" hotkey={keyFor("sell").toUpperCase()} disabled={replay} onClick={() => game.setMode("sell")}><SellIcon width={18} height={18} /></ModeButton>
        </div>
      </div>
      {replay ? <ReplaySidePanel game={game} /> : <>
        <Tabs />
        <SupportPowers game={game} />
        <div ref={paletteSpace} className="flex min-h-0 flex-1 gap-[5px]">
          <div className="flex flex-col items-center gap-1">
            <PowerIcon width={12} height={12} className="text-[var(--hud-power)]" />
            <PowerMeter height={paletteH - 16} pitch={compact ? 3 : 5} />
          </div>
          <div className="min-w-0 flex-1"><Palette game={game} height={paletteH} /></div>
        </div>
      </>}
    </aside>
  );
}
