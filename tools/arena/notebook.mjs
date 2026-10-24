// The AI Arena's experiment notebook (tools/arena/notebook.json) with its results counted from the games: for each
// brain version an entry compares, the scripted brain's wins, draws and losses per opponent. Games from before brain
// versions were recorded are matched by a time window (a version's `after` and `before`). Shared by the runner's
// /notebook and the story films (story.mjs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "notebook.json");

export function readNotebook(dir) {
  const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).entries : [];
  const gamesFile = path.join(dir, "games.jsonl");
  const games = fs.existsSync(gamesFile) ? fs.readFileSync(gamesFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const finished = games.filter((g) => ["win", "draw", "loss"].includes(g.result) && g.brain === "decision" && g.provider === "scripted");
  const filmsDir = path.join(dir, "films");
  const films = new Set(fs.existsSync(filmsDir) ? fs.readdirSync(filmsDir) : []);
  return entries.map((e) => ({
    ...e,
    results: (e.versions ?? []).map((v) => {
      const mine = finished.filter((g) => (v.before ? !g.version && g.finishedAt >= v.after && g.finishedAt < v.before : g.version === v.version));
      const byOpponent = {};
      for (const g of mine) { const c = (byOpponent[g.opponent] ??= { win: 0, draw: 0, loss: 0, minutes: [] }); c[g.result]++; c.minutes.push(Math.round(g.gameSeconds / 60)); }
      return { ...v, games: mine.length, byOpponent };
    }),
    story: films.has(`story-${e.id}.mp4`) ? `story-${e.id}.mp4` : null,
    films: (e.films ?? []).map((f) => {
      const name = `${f.game}-${f.shot ?? "fight"}`;
      return { ...f, file: `${name}.mp4`, poster: `${name}.jpg`, ready: films.has(`${name}.mp4`) };
    }),
  }));
}
