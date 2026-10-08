// The sidebar power meter: a port of the mod's PowerMeterWidget (RTSAI-Mod OpenRA.Mods.RA2/Widgets/PowerMeterWidget.cs)
// with the settings of chrome/ingame-player.yaml (PowerMeter: MeterHeight 3, PowerUnitsPerBar 25, TickWait 4) and the
// bar images of chrome.yaml (power-meter, uibits/chrome.png). One bar per 25 power from the bottom up, nothing lit at
// 0 power; drained power red, the spare part green, over-used grey, and the top bar flashes yellow when the total
// changes or power is low. Every TickWait UI ticks at most one bar changes, which animates the meter.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

const POWER_UNITS_PER_BAR = 25;
const TICK_WAIT = 4;
const UI_TIMESTEP_MS = 40; // OpenRA Ui.Timestep

// chrome.yaml power-meter regions (12x2: a light top row over a dark bottom row), sampled from uibits/chrome.png.
type Bar = "none" | "available" | "used" | "danger" | "disabled";
const BAR_COLORS: Record<Bar, [string, string]> = {
  none: ["#4b4e51", "#161a1d"],
  available: ["#7be38b", "#409c50"],
  used: ["#f3d36b", "#a98e34"],
  danger: ["#f16b61", "#a8332b"],
  disabled: ["#7b7d80", "#404246"],
};

// ingame-player.yaml PowerMeter image names.
const NO_POWER: Bar = "none";
const AVAILABLE_POWER: Bar = "available";
const USED_POWER: Bar = "danger";
const OVER_USED_POWER: Bar = "disabled";
const FLASH_POWER: Bar = "used";

interface Power { provided: number; drained: number; state: string }
interface Meter { bars: Bar[]; warningFlash: number; lastTotalPowerDisplay: number; bypassAnimation: boolean }

/** One PowerMeterWidget.Tick after TickWait: returns whether a bar changed. */
function stepMeter(m: Meter, count: number, p: Power): boolean {
  let changed = false;
  if (m.bars.length !== count) {
    // CheckBarNumber / CalculateMeterBarDimensions: new bars start empty and the next update is not animated.
    m.bars = Array.from({ length: count }, () => NO_POWER);
    m.bypassAnimation = true;
    changed = true;
  }

  let totalPowerDisplay = Math.max(p.provided, p.drained);
  let totalPowerStep = Math.floor(totalPowerDisplay / POWER_UNITS_PER_BAR);
  let powerUsedStep = Math.floor(p.drained / POWER_UNITS_PER_BAR);
  let powerAvailableStep = Math.floor(p.provided / POWER_UNITS_PER_BAR);

  // Display a percentage if the bar is maxed out.
  if (totalPowerStep > count) {
    const powerFraction = count / totalPowerStep;
    totalPowerDisplay = Math.trunc(totalPowerDisplay * powerFraction);
    totalPowerStep = Math.trunc(totalPowerStep * powerFraction);
    powerUsedStep = Math.trunc(powerUsedStep * powerFraction);
    powerAvailableStep = Math.trunc(powerAvailableStep * powerFraction);
  }

  // CheckFlash
  let startWarningFlash = p.state !== "Normal";
  if (m.lastTotalPowerDisplay !== totalPowerDisplay) {
    startWarningFlash = true;
    m.lastTotalPowerDisplay = totalPowerDisplay;
  }
  if (startWarningFlash && m.warningFlash <= 0) m.warningFlash = 10;

  for (let i = 0; i < count; i++) {
    if (i > totalPowerStep || totalPowerStep === 0) {
      if (m.bars[i] !== NO_POWER) { m.bars[i] = NO_POWER; changed = true; }
      continue;
    }

    let target = AVAILABLE_POWER;
    if (i < powerUsedStep) target = USED_POWER;
    if (i > powerAvailableStep) target = OVER_USED_POWER;
    if (i === totalPowerStep && p.state === "Low") target = OVER_USED_POWER;

    // Flash the top bar if something is wrong.
    if (i === totalPowerStep) {
      if (m.warningFlash % 2 !== 0) target = FLASH_POWER;
      if (m.warningFlash > 0) m.warningFlash--;
    }

    // Updating one bar per step is what animates the meter.
    if (m.bars[i] !== target) {
      m.bars[i] = target;
      changed = true;
      if (!m.bypassAnimation) return true;
    }
  }

  m.bypassAnimation = false;
  return changed;
}

/** `pitch`: CSS px per bar (the native 3 px MeterHeight, scaled with the sidebar); bars are 2/3 of it like the 2 px art. */
export function PowerMeter({ height, pitch }: { height: number; pitch: number }) {
  const power = useStore((s) => s.ui?.power);
  const inner = Math.max(0, height - 4);
  const count = Math.floor(inner / pitch);
  const barH = Math.max(1, Math.round((pitch * 2) / 3));

  const latest = useRef({ count, power });
  latest.current = { count, power };
  const meter = useRef<Meter>({ bars: [], warningFlash: 0, lastTotalPowerDisplay: 0, bypassAnimation: false });
  const [bars, setBars] = useState<Bar[]>([]);

  useEffect(() => {
    const tick = () => {
      const { count: n, power: p } = latest.current;
      if (stepMeter(meter.current, n, p ?? { provided: 0, drained: 0, state: "Normal" })) setBars([...meter.current.bars]);
    };
    tick();
    const id = setInterval(tick, TICK_WAIT * UI_TIMESTEP_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="hud-inset power-meter relative shrink-0" style={{ width: 12, height }} title={`Power ${power?.provided ?? 0} / ${power?.drained ?? 0}`}>
      {bars.slice(0, count).map((b, i) => {
        const [hi, lo] = BAR_COLORS[b];
        return <div key={i} style={{ bottom: 2 + i * pitch, height: barH, background: `linear-gradient(${hi} 50%, ${lo} 50%)` }} />;
      })}
    </div>
  );
}
