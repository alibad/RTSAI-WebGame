// One AI Arena match in the live game's sign-in-free twin page: our seat (Multi0) is played by a brain, the other
// seat by the engine's own AI at the chosen skill. Orders go through the same native co-commander path the public
// game's adviser uses (adviserObserve / adviserExecute), so they are ordinary synchronized player orders.
import { plan, scriptedAnswers } from "./brain.mjs";
import { decide, PROVIDERS } from "./providers.mjs";

/** The opponent skills of the game's Battle simulator (web/src/sandbox.ts AI_SKILLS), as skirmish seats. Veteran
 * rank there applies to pre-placed units only; a skirmish has none, so Brutal here is the Rush AI with 15,000 extra. */
export const OPPONENTS = {
  easy: { label: "Easy", bot: "normal", handicap: 50, cash: 0, hint: "Normal AI with weaker weapons, armour and building" },
  normal: { label: "Normal", bot: "normal", handicap: 0, cash: 0, hint: "The standard AI on equal terms" },
  rush: { label: "Rush", bot: "rush", handicap: 0, cash: 0, hint: "The aggressive Rush AI on equal terms" },
  hard: { label: "Hard", bot: "rush", handicap: 0, cash: 5000, hint: "Rush AI with 5,000 extra credits" },
  brutal: { label: "Brutal", bot: "rush", handicap: 0, cash: 15000, hint: "Rush AI with 15,000 extra credits" },
};

export const BRAINS = {
  bot: { label: "Built-in Normal AI", hint: "The engine's own AI in our seat: the baseline" },
  adviser: { label: "Built-in adviser", hint: "The public game's co-commander on Auto" },
  decision: { label: "Decision brain", hint: "Closed questions answered by a decision model" },
  you: { label: "You", hint: "You play in a window; the result is recorded" },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/**
 * spec: { id, brain, provider?, opponent, ours, theirs, map, seed, speed, limit (game seconds), pauseWhileThinking }
 * env:  { browser, url, key, charge(usd) -> bool (false: a cap is reached), stopped() -> bool, progress(info) }
 */
export async function runMatch(spec, env) {
  const t0 = Date.now();
  const decisions = [], errors = [];
  const page = await env.browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("pageerror", (e) => errors.push(`page: ${String(e).slice(0, 300)}`));
  page.on("crash", () => errors.push("page crashed"));
  const opp = OPPONENTS[spec.opponent];
  let stats = null, outcome = "error", stopReason = "";
  try {
    await page.goto(`${env.url}?profile=public&mode=skirmish`);
    await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 300000, polling: 500 });
    const defaults = await page.evaluate(() => Object.fromEntries((window.store.getState().setup.options ?? []).map((o) => [o.id, o.default])));
    const assisted = spec.brain === "decision" || spec.brain === "adviser";
    const options = { ...defaults, cheats: "False", crates: "False", "rtsai-cocommander": assisted ? "True" : "False" };
    const scenario = { map: spec.map, seed: spec.seed, options, players: [
      { slot: "Multi0", faction: spec.ours, color: "4F80FF", ...(spec.brain === "bot" ? { bot: "normal" } : {}) },
      { slot: "Multi1", faction: spec.theirs, color: "FF4848", bot: opp.bot, handicap: opp.handicap, cash: opp.cash },
    ] };
    await page.evaluate(([on, auto]) => { const cc = window.game.cc; cc.setEnabled(on); cc.setMode("browser"); cc.setAuto(auto); }, [assisted, spec.brain === "adviser"]);
    await page.evaluate((s) => window.game.start(JSON.stringify(s)), scenario);
    await page.waitForFunction(() => ["playing", "error"].includes(window.store.getState().phase), null, { timeout: 300000, polling: 250 });
    const phase = await page.evaluate(() => `${window.store.getState().phase} ${window.store.getState().error ?? ""}`);
    if (!phase.startsWith("playing")) throw new Error(`did not start: ${phase}`);
    if (spec.brain !== "you") await page.evaluate((v) => window.game.client.send({ type: "speed", speed: v }), spec.speed);

    const memory = { lastArmyTick: -1e9, notBefore: 0 };
    const seenAdvice = new Set();
    // The engine takes 1 to 12 commands per order: larger groups (the whole army) go as several orders.
    const execute = async (label, commands, tick) => {
      let accepted = true, detail = "";
      for (let i = 0; i < commands.length; i += 12) {
        const r = await page.evaluate(([id, c, t]) => window.game.client.adviserExecute(id, c, t), [`arena-${spec.id}-${decisions.length}-${label}-${i}`, commands.slice(i, i + 12), tick])
          .catch((e) => ({ accepted: false, detail: String(e).slice(0, 200) }));
        if (!r.accepted) { accepted = false; detail = r.detail; }
      }
      return { accepted, detail };
    };
    let lastStats = 0;
    for (;;) {
      if (env.stopped()) { outcome = "stopped"; stopReason = "Run stopped"; break; }
      if (page.isClosed()) { outcome = spec.brain === "you" ? "abandoned" : "error"; break; }
      if (Date.now() - lastStats >= 1000) {
        lastStats = Date.now();
        stats = await page.evaluate(() => window.game.command({ cmd: "stats" })).catch(() => stats);
        const st = await page.evaluate(() => window.store.getState().phase).catch(() => "closed");
        if (!stats?.players) { await sleep(500); continue; }
        const me = stats.players[0], gs = (stats.tick * stats.timestep) / 1000;
        env.progress?.({ gameSeconds: Math.round(gs), decisions: decisions.length });
        if (me.win === "Won") { outcome = "win"; break; }
        if (me.win === "Lost") { outcome = "loss"; break; }
        if (st !== "playing") { outcome = spec.brain === "you" ? "abandoned" : "error"; errors.push(`phase ${st}`); break; }
        if (spec.limit && gs >= spec.limit) { outcome = "draw"; break; }
      }
      if (spec.brain === "adviser") {
        // The adviser applies its own cards; read them back from its feed as decisions.
        const feed = await page.evaluate(() => window.store.getState().cc.feed.filter((f) => f.kind === "proposal" && f.state === "accepted").map((f) => ({ id: f.id, text: f.text, at: f.at })));
        for (const f of feed) if (!seenAdvice.has(f.id)) {
          seenAdvice.add(f.id);
          decisions.push({ tick: stats?.tick ?? 0, auto: [], questions: [{ name: "advice", instructions: "Built-in adviser's next step", choice: f.text, options: [{ value: f.text, label: f.text, p: 1 }] }], ms: 0, usd: 0, inputTokens: 0 });
        }
        await sleep(1000);
        continue;
      }
      if (spec.brain !== "decision") { await sleep(1000); continue; }

      const obs = await page.evaluate(() => window.game.client.adviserObserve()).catch((e) => ({ error: String(e) }));
      if (obs.error) { await sleep(400); continue; }
      if (obs.done) { await sleep(400); continue; }
      if (obs.tick < memory.notBefore) { await sleep(150); continue; }
      const { auto, questions } = plan(obs, memory);
      const entry = { tick: obs.tick, auto: [], questions: [], ms: 0, usd: 0, inputTokens: 0 };
      for (const a of auto) { const r = await execute("auto", a.commands, obs.tick); entry.auto.push({ label: a.label, accepted: !!r.accepted }); }
      if (questions.length) {
        const think = spec.pauseWhileThinking && PROVIDERS[spec.provider]?.label && spec.provider !== "scripted";
        if (think) await page.evaluate(() => window.game.client.send({ type: "pause", paused: true }));
        let result;
        try { result = await decide(spec.provider, obs, questions, env.credential ?? {}); }
        catch (e) {
          // A failed call still has to move the game on: the scripted scorer answers this turn, flagged as a fallback.
          errors.push(`decide: ${String(e.message ?? e).slice(0, 300)}`);
          result = { answers: scriptedAnswers(obs, questions), ms: 0, inputTokens: 0, usd: 0, fallback: true };
        } finally { if (think) await page.evaluate(() => window.game.client.send({ type: "pause", paused: false })); }
        Object.assign(entry, { ms: result.ms, usd: result.usd, inputTokens: result.inputTokens, fallback: !!result.fallback });
        if (result.usd && !env.charge(result.usd)) { outcome = "stopped"; stopReason = "Spending cap reached"; decisions.push(entry); break; }
        for (const q of questions) {
          const answer = result.answers[q.name];
          const option = q.options.find((o) => o.value === answer?.choice);
          const record = { name: q.name, instructions: q.instructions, choice: option?.value ?? null, confidence: answer?.confidence,
            options: q.options.map((o) => ({ value: o.value, label: o.label, p: Math.round(1000 * (answer?.probabilities?.[o.value] ?? 0)) / 1000 })) };
          if (option?.commands.length) { const r = await execute(q.name, option.commands, obs.tick); record.accepted = !!r.accepted; if (!r.accepted) record.detail = r.detail; }
          if (q.name === "army") memory.lastArmyTick = obs.tick;
          if (option?.value === "scout") memory.lastScoutTick = obs.tick;
          entry.questions.push(record);
        }
        if (questions.some((q) => q.name !== "army")) memory.lastAskTick = obs.tick;
      }
      if (entry.auto.length || entry.questions.length) { decisions.push(entry); memory.notBefore = obs.tick + 12; }
      await sleep(250);
    }
  } catch (e) {
    errors.push(String(e.stack ?? e).slice(0, 800));
    outcome = outcome === "error" ? "error" : outcome;
  }
  let replay = null;
  try { if (!page.isClosed() && stats) replay = await page.evaluate((m) => window.game.client.request({ type: "record", map: m }), spec.map); } catch { /* no replay */ }
  try { if (!page.isClosed()) await page.close(); } catch { /* already closed */ }
  const ms = decisions.filter((d) => d.questions.length && !d.fallback).map((d) => d.ms);
  const side = (p) => p && ({ killsCost: p.killsCost, deathsCost: p.deathsCost, unitsKilled: p.unitsKilled, buildingsKilled: p.buildingsKilled, earned: p.earned, armyPeak: Math.max(0, ...(p.army ?? [0])) });
  const result = {
    ...spec, result: outcome, stopReason,
    gameSeconds: stats ? Math.round((stats.tick * stats.timestep) / 1000) : 0, wallSeconds: Math.round((Date.now() - t0) / 1000),
    us: side(stats?.players?.[0]), them: side(stats?.players?.[1]),
    decisionCount: decisions.length, questionCount: decisions.reduce((s, d) => s + d.questions.length, 0),
    ms: { p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: Math.max(0, ...ms) },
    inputTokens: decisions.reduce((s, d) => s + (d.inputTokens ?? 0), 0), usd: decisions.reduce((s, d) => s + (d.usd ?? 0), 0),
    fallbacks: decisions.filter((d) => d.fallback).length, errors: errors.slice(0, 20), finishedAt: new Date().toISOString(),
  };
  return { result, decisions, replay: replay ? { scenario: spec, log: replay.log, tick: replay.tick } : null };
}
