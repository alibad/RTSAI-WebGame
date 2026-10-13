# Browser AI roadmap

Owner direction, 9 October 2026. Keep implementation and verification local; no deployment is authorized by this plan.

The browser runs OpenRA's deterministic simulation. Models interpret intent and explain strategy; native game systems execute recorded orders. Read only the player's fog-respecting observation. Never put a model in the tick loop.

## 1. Persistent goals and contextual strategy choices — implemented locally

During a skirmish with the co-commander enabled, the Strategy strip shows the selected approach. Open it for three context-based choices with intent and tradeoffs, or browse all eight approaches: economy, scouting, pressure, economy protection, regrouping, anti-air, anti-armor, and combined arms.

Choices use visible contacts, discovered structures, own forces, income, and recorded combat trades. Recommendations hold for at least 250 simulation ticks (10 seconds at normal speed); urgent pressure and match completion update immediately. The player decides whether to switch. No automatic strategy switch occurs.

The selection persists for the match and changes next-step advice and proposals. It exposes progress, current next step, optional credit reserve (0–10,000), automatic proposal offers, a manual Prepare next step button, and Release strategy. The reserve bounds strategy-funded production and is checked again against the fresh observation at confirmation. Explicit player orders can override the plan. Strategy switching withdraws only that strategy's pending steps.

Execution remains through accepted action cards, rather than AUTO. Automatic offers never issue an order, never displace existing player proposals, and do not keep reoffering a dismissed identical step until relevant state changes. Economy targets map-scaled harvesters; counters use the faction catalog and live buildable actors; pressure uses discovered positions and keeps two idle fighters in reserve; scouting and regrouping reuse spatial planning helpers. Survival, power, and completed building placement take priority. Unsupported counters and regrouping positions are reported rather than invented.

Voice/text accepts the displayed strategy names, optionally prefixed with Choose, Select, Use, or Switch to. “What strategy are we using?” and next-step questions reflect the selected plan.

The companion owns match-local goals through `/v1/strategies` and `/v1/strategies/step`. The existing observation relay and engine order stream are reused. This needs the local companion; static public builds still require hosted session infrastructure before AI can be enabled.

Verification: companion scenario/API tests, browser build, local browser acceptance, desktop and compact viewport screenshots, and native replay parity. Evidence and results belong in CO-COMMANDER.md.

Later extensions within this feature: replay-safe automatic execution with explicitly scoped authority, user-drawn areas and no-chase boundaries, richer income/technology goals, and spending ceilings. These need engine contracts beyond the current confirmed-action scope.

## 2. Battlefield communication — implemented locally

Connect advice and proposal cards to highlights of owned units, observed contacts, approach arrows, and proposed action previews. Clicking an explanation should reveal its referenced location. Show uncertainty for remembered contacts. Dismiss overlays without interrupting gameplay.

Acceptance: every annotation refers to observed or owned data; previews distinguish proposals from issued orders; desktop/touch controls stay usable; cancelling leaves no order behind.

Delivery: real companion proposals expose their validated commands to the browser. Owned units receive rings and proposed destinations receive dashed intent arrows. Focus jumps to the referenced units; dismissal is local and leaves the pending proposal intact. A previously visible target can retain a faded, explicitly uncertain location for at most 30 simulation seconds. Intent arrows are not pathfinding claims. Preview data never issues orders. The overlay accounts for camera zoom and display pixel density.

## 3. Replay coaching and practice — implemented locally

Explain specific turning points with links to their replay times. Start with deterministic evidence: power outages, production idle time, losses, and income interruptions. Build short practice scenarios from those findings. Arbitrary replay branching requires snapshot/restore support and is separate from replay scrubbing.

Acceptance: claims link to actual replay events; practice scenarios are reproducible and validated; comparisons show measured outcomes and avoid invented counterfactual results.

Delivery: Battlefield review records up to six minutes of visible rendering snapshots, roughly every two seconds, with the recorded camera. Native own-player telemetry supplies army counts, confirmed unit losses and earned income; panning cannot create a loss. Power transitions, 30-second idle production periods and income interruptions create timestamped evidence cards. Seeking pauses local single-player play and blocks mouse, touch, command and co-commander orders; Return live restores the prior camera/pause state. Multiplayer keeps a read-only evidence timeline without pausing or seeking. Evidence and the exact scenario can be exported. Practice links open a separate workshop so the current game remains available. Native objective results store survivors, damage and shots at completion and compare against the prior identical scenario. Arbitrary world-state branching remains a separate extension.

## 4. Adaptive opponent personalities — implemented locally

Add persistent opponent doctrines and bounded adaptation to scouting evidence. Keep combat execution native, expose difficulty and any assistance rules, and avoid hidden-state advantages. Establish baseline bot behavior and repeatable matchup evaluations before adding model decisions.

Acceptance: no hidden enemy data reaches the director; decisions are recorded; model outages preserve playable opponents; match quality is evaluated across factions, maps, and seeds.

Delivery: each skirmish opponent has a separately persisted Standard, Raider, Sentinel or Adaptive tactical personality. The existing native bot retains production, economy and difficulty. A shared browser/native director considers at most eight idle mobile combat units every five seconds and observes only enemies currently visible to that bot. Raider pressures observed contacts, Sentinel intercepts within 16 cells of home, and Adaptive regroups when visible enemy fighters exceed its own by more than 50%. It uses native movement checks and ordinary recorded orders, with no extra resources or model dependency. The review panel and evidence export show the bounded decision log. This is tactical adaptation, not model-driven opponent production or long-term learning.

## 5. Conversational scenario creation — implemented locally

Turn a request into a typed, editable mission plan with map, forces, duration, and objectives. Preview it, validate routes and victory conditions, then launch it directly. Reuse existing catalog, map/mission tooling, and sandbox rather than creating incompatible formats.

Acceptance: generated scenarios pass deterministic playability validation; user can revise the plan before play; fictional story and generated assets have clear provenance; sharing/publishing remains a separate authorized action.

Delivery: Scenario workshop accepts a request and revises a typed, editable practice plan. The local interpreter recognizes catalog unit names, unit-class words (tanks, infantry, aircraft, artillery...), faction IDs and names, force counts, duration and survival/elimination intent; the text before "against"/"vs" is your side. Units come from each faction's production roster, and only units the engine counts as combat units are offered or picked: a generic "8 units" mirrors your side's class from the opponent's roster, never a construction vehicle or harvester. All inferred fields remain visible and editable, and problems show beside the field that causes them. This release targets the flat combat arena: two forces of 1–24 units in ranks spaced by each unit's on-screen size (no overlap at any size), 30–600 seconds, a fixed seed and explicit opponent orders. Every valid change rebuilds the battle as a paused native world behind the panel and checks combat forces, legal terrain and ground connectivity (over terrain: an older runtime pathed into the enemy's own cell, so no armour ever validated); Start battle unpauses that same world. Native objectives handle success, loss of own forces and timeout. These are fictional combat drills using existing project assets. Multi-stage campaign scripting, mixed-force plans and arbitrary generated maps remain future extensions; no model or generated asset is claimed.

## Delivery sequence

All five features have local implementations. Verify and iterate on the local product before authorizing any hosted companion sessions or production deployment. See AI-FEATURES.md for launch instructions, verification and current scope.
