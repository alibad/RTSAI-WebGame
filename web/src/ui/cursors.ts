// Project-drawn cursor set (no game assets), rasterised to 32 px PNG data URLs once at startup and applied as CSS
// cursors (hardware cursors: no added latency). The engine decides which cursor applies (OrderGenerator.GetCursor);
// this maps its names onto the set.

const S = 32;
const OUT = `stroke="#050605" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"`;

function svg(body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${body}</svg>`;
}

// Each shape is drawn twice: a dark outline pass, then the colour pass.
function twice(shape: (stroke: string) => string, color: string, width = 1.6) {
  return shape(OUT) + shape(`stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"`);
}

const arrow = svg(`<path d="M3 2 L3 24 L9 18.5 L13.5 28 L17 26.4 L12.6 17 L20.5 17 Z" fill="#f1d28b" stroke="#050605" stroke-width="1.6" stroke-linejoin="round"/>`);

const brackets = (c: string) => svg(twice((st) => `<path ${st} fill="none" d="M7 12 V7 H12 M20 7 H25 V12 M25 20 V25 H20 M12 25 H7 V20"/>`, c) +
  `<circle cx="16" cy="16" r="1.8" fill="${c}" stroke="#050605" stroke-width="1"/>`);

const move = svg(twice((st) => `<path ${st} fill="none" d="M16 3 L16 10 M12.5 7 L16 10.5 L19.5 7 M16 29 L16 22 M12.5 25 L16 21.5 L19.5 25 M3 16 L10 16 M7 12.5 L10.5 16 L7 19.5 M29 16 L22 16 M25 12.5 L21.5 16 L25 19.5"/>`, "#57d36b") +
  `<circle cx="16" cy="16" r="1.6" fill="#57d36b" stroke="#050605" stroke-width="1"/>`);

const blocked = svg(twice((st) => `<circle ${st} cx="16" cy="16" r="10" fill="none"/><path ${st} d="M9 23 L23 9"/>`, "#ef5b3f", 2.4));

const crosshair = (c: string, dashed = false) => svg(twice((st) => `<circle ${st} cx="16" cy="16" r="9.5" fill="none" ${dashed ? 'stroke-dasharray="3 3"' : ""}/>` +
  `<path ${st} d="M16 2 V10 M16 22 V30 M2 16 H10 M22 16 H30"/>`, c) +
  `<circle cx="16" cy="16" r="1.8" fill="${c}" stroke="#050605" stroke-width="1"/>`);

const attackMove = svg(twice((st) => `<circle ${st} cx="16" cy="16" r="8" fill="none"/>` +
  `<path ${st} fill="none" d="M16 2 V8 M16 24 V30 M2 16 H8 M24 16 H30 M12.5 4.5 L16 8 L19.5 4.5 M12.5 27.5 L16 24 L19.5 27.5"/>`, "#f39a3c"));

const deploy = svg(twice((st) => `<path ${st} fill="none" d="M8 13 A9 9 0 0 1 23.5 9.5 M24 19 A9 9 0 0 1 8.5 22.5"/>` +
  `<path ${st} fill="none" d="M23.8 4.8 L23.8 10.2 L18.4 10.2 M8.2 27.2 L8.2 21.8 L13.6 21.8"/>`, "#57d36b"));

const enter = svg(twice((st) => `<rect ${st} x="9" y="9" width="14" height="14" fill="none"/>` +
  `<path ${st} fill="none" d="M2 16 H12 M8.5 12.5 L12 16 L8.5 19.5"/>`, "#57d36b"));

const capture = svg(twice((st) => `<path ${st} fill="none" d="M10 28 V5 M10 6 H24 L20.5 10.5 L24 15 H10"/>`, "#49c4f2"));

const sell = svg(twice((st) => `<path ${st} fill="none" d="M21 9.5 C19.5 7.5 12 7 12 11.5 C12 16 21 15 21 20.5 C21 25 13 25 11 22.5 M16.5 5 V27"/>`, "#f1d28b", 2));

const repair = svg(twice((st) => `<path ${st} fill="none" d="M7 25 L17.5 14.5 M20.5 5.5 A5.5 5.5 0 0 0 16 13 L18.5 15.5 A5.5 5.5 0 0 0 26 11 L22.5 12.5 L19.5 9.5 Z"/>`, "#49c4f2", 2));

const guard = svg(twice((st) => `<path ${st} fill="none" d="M16 4 L26 8 V15 C26 21 21.5 25.5 16 28 C10.5 25.5 6 21 6 15 V8 Z"/>`, "#57d36b"));

const bomb = svg(twice((st) => `<circle ${st} cx="14" cy="19" r="8" fill="none"/><path ${st} fill="none" d="M19.5 13.5 L23 10 M23 10 C24 6 27 6 28 4"/>`, "#ef5b3f", 2));

const harvest = svg(twice((st) => `<path ${st} fill="none" d="M6 26 L18 14 M14 7 C19 5 25 8 27 14 C22 12 18 13 15.5 16.5"/>`, "#57d36b", 2));

interface Cursor { svg: string; hx: number; hy: number }

const SET: Record<string, Cursor> = {
  default: { svg: arrow, hx: 3, hy: 2 },
  select: { svg: brackets("#f1d28b"), hx: 16, hy: 16 },
  move: { svg: move, hx: 16, hy: 16 },
  "move-rough": { svg: move, hx: 16, hy: 16 },
  "move-blocked": { svg: blocked, hx: 16, hy: 16 },
  blocked: { svg: blocked, hx: 16, hy: 16 },
  attack: { svg: crosshair("#ef5b3f"), hx: 16, hy: 16 },
  attackoutsiderange: { svg: crosshair("#ef8a72", true), hx: 16, hy: 16 },
  "attack-move": { svg: attackMove, hx: 16, hy: 16 },
  "assault-move": { svg: attackMove, hx: 16, hy: 16 },
  deploy: { svg: deploy, hx: 16, hy: 16 },
  enter: { svg: enter, hx: 16, hy: 16 },
  capture: { svg: capture, hx: 10, hy: 28 },
  sell: { svg: sell, hx: 16, hy: 16 },
  repair: { svg: repair, hx: 16, hy: 16 },
  guard: { svg: guard, hx: 16, hy: 16 },
  c4: { svg: bomb, hx: 16, hy: 16 },
  harvest: { svg: harvest, hx: 16, hy: 16 },
  ability: { svg: brackets("#49c4f2"), hx: 16, hy: 16 },
};

// Engine cursor names with a suffix ("-blocked", "-minimap") fall back to their family.
function family(name: string): string {
  if (SET[name]) return name;
  if (name.endsWith("-blocked") || name.startsWith("generic-blocked") || name === "nopower") return "blocked";
  if (name.endsWith("-minimap")) return family(name.slice(0, -8));
  if (name.startsWith("attack")) return "attack";
  if (name.startsWith("move")) return "move";
  if (name.startsWith("enter") || name === "goldwrench" || name.startsWith("dock")) return "enter";
  if (name.startsWith("capture") || name.startsWith("infiltrate")) return "capture";
  if (name.startsWith("sell")) return "sell";
  if (name.startsWith("repair") || name.startsWith("heal")) return "repair";
  if (name.startsWith("deploy") || name.startsWith("undeploy")) return "deploy";
  if (name.startsWith("guard")) return "guard";
  if (name.startsWith("c4") || name.startsWith("sabotage") || name.startsWith("demolish")) return "c4";
  if (name.startsWith("harvest")) return "harvest";
  if (name === "select" || name.startsWith("ability")) return "select";
  return "select";
}

const css = new Map<string, string>();

async function rasterise(c: Cursor): Promise<string> {
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(c.svg);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  return `url("${canvas.toDataURL("image/png")}") ${c.hx} ${c.hy}, auto`;
}

/** Builds the CSS cursor values. Until it resolves, cursorFor() returns plain CSS fallbacks. */
export async function loadCursors() {
  await Promise.all(Object.entries(SET).map(async ([name, c]) => css.set(name, await rasterise(c))));
}

export function cursorFor(engineName: string): string {
  const f = family(engineName || "default");
  return css.get(f) ?? (f === "default" ? "default" : f === "blocked" ? "not-allowed" : "crosshair");
}

/** For previews (the setup screen and tests): the raw SVG of a cursor. */
export function cursorSvg(engineName: string) {
  return SET[family(engineName)].svg;
}
