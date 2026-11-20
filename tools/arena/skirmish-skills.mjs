/**
 * The difficulties a computer player can have, as skirmish seats. The skirmish screen offers the engine's five AI
 * profiles (web/src/ui/Setup.tsx, "AI profile"); the Battle simulator offers Easy, Normal, Hard and Brutal
 * (web/src/sandbox.ts AI_SKILLS), which are the Normal and Rush profiles with a handicap or extra credits.
 */
export const SKILLS = {
  normal: { label: "Normal AI", where: "skirmish and simulator", bot: "normal" },
  easy60: { label: "Easy AI (60% firepower)", where: "skirmish", bot: "medium" },
  rush: { label: "Rush AI", where: "skirmish", bot: "rush" },
  turtle: { label: "Turtle AI", where: "skirmish", bot: "turtle" },
  naval: { label: "Naval AI", where: "skirmish", bot: "naval" },
  easy: { label: "Easy", where: "simulator", bot: "normal", handicap: 50 },
  hard: { label: "Hard", where: "simulator", bot: "rush", cash: 5000 },
  brutal: { label: "Brutal", where: "simulator", bot: "rush", cash: 15000 },
};
