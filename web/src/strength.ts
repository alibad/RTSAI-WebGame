// How strong armies are against each other, from the engine's rules (sim Ui.AppendCombat: each unit's health, armor,
// target types, and its weapons' damage per second against every armor type with the target types they can hit).
// Lanchester's square law: an army's fighting strength is its damage rate times its health, so two armies are even
// when those products match. Missions use it to field armies that are even in strength, not just in price: a classic
// country's Grizzly is worth $700 but nowhere near a Karrar.
import type { SimUnit } from "./sandbox";

export type Army = [SimUnit, number][];

/** Damage per second one unit deals another, with every weapon that can target it. */
export function dps(a: SimUnit, b: SimUnit): number {
  const targets = b.targets?.length ? b.targets : ["Ground"];
  return (a.weapons ?? [])
    .filter((w) => w.valid.some((t) => targets.includes(t)) && !w.invalid.some((t) => targets.includes(t)))
    .reduce((sum, w) => sum + (w.dps[b.armor ?? ""] ?? w.dps[""] ?? 0), 0);
}

const health = (army: Army) => army.reduce((sum, [u, n]) => sum + (u.hp ?? 0) * n, 0);

/** An army's damage per second against another, its fire spread over the enemy by their share of its health. */
export function damageRate(army: Army, enemy: Army): number {
  const total = health(enemy);
  if (!total) return 0;
  return army.reduce((sum, [u, n]) => sum + (n * enemy.reduce((s, [e, m]) => s + dps(u, e) * (e.hp ?? 0) * m, 0)) / total, 0);
}

/** Fighting strength against an enemy: damage rate times health. */
export const strength = (army: Army, enemy: Army) => damageRate(army, enemy) * health(army);

/**
 * How many times the defender's army (the same mix) must grow to be as strong as the attacker's: scaling it by k
 * scales both its damage rate and its health, so k = sqrt(attacker / defender). Null when the rules give no stats.
 */
export function evenScale(defend: Army, attack: Army): number | null {
  const d = strength(defend, attack);
  const a = strength(attack, defend);
  return d > 0 && a > 0 ? Math.sqrt(a / d) : null;
}
