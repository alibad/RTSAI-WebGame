// The battlefield's cell grid (the Grid button: ui/GridToggle.tsx). The owner liked the old website Workshop's map
// for its grid: the battle reads as a board you can count and measure (16 Nov 2026). Here every cell is outlined where
// the engine put it: the terrain the engine laid out (TerrainSpriteLayer: four vertices per cell, rows of map cells in
// MPos order) gives each cell's height, so on hills and cliffs the outlines step up and down with the ground. Drawn
// over the terrain and under every unit, building and the shroud.

import { COLOR_FS, LINE_VS } from "./shaders";
import type { StartInfo } from "../sim/protocol";

const LINE_FLOATS = 8; // x0, y0, x1, y1, then premultiplied r, g, b, a
const FLOATS_PER_VERTEX = 12; // OpenRA.Graphics.Vertex: 48 bytes
/** The line colour: dark and see-through, like the Workshop's grid over its ground. */
const INK = [0.03, 0.05, 0.04, 0.34] as const;
/** Where the ground steps (cliffs, slopes, a raised plateau's rim): a little stronger, so the levels read. */
const STEP = [0.02, 0.03, 0.03, 0.5] as const;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
  return p;
}

/**
 * Each cell's outline, from the terrain vertices. A cell's tile sprite ends at the bottom corner of the cell's diamond
 * (raised cells are drawn higher; cliff tiles carry their face above that corner), so the bottom edge of the quad gives
 * the height of that corner. Every other corner is some other cell's bottom corner (the left one the north-west
 * neighbour's, the right one the north-east neighbour's, the top one the cell two rows up), so slopes and ramps come
 * out as one continuous mesh. Across a cliff (more than two height levels) a corner keeps the cell's own height
 * instead, so the levels show as a clean step rather than lines running down the cliff face. Every cell draws its two
 * upper edges; a lower edge only where the neighbour below is missing or its edge does not meet this one.
 */
export function gridLines(info: Pick<StartInfo, "mapSize" | "tileSize" | "cellOrigin" | "gridType">, terrain: ArrayBuffer): Float32Array {
  const [W, H] = info.mapSize;
  const f = new Float32Array(terrain);
  const out: number[] = [];
  const line = (x0: number, y0: number, x1: number, y1: number, c: readonly number[]) =>
    out.push(x0, y0, x1, y1, c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]);
  const cells = Math.min(W * H, Math.floor(f.length / (4 * FLOATS_PER_VERTEX)));
  // Height in world px above the cell's flat position, or NaN where the map has no tile.
  const lift = new Float32Array(W * H).fill(NaN);
  const [ox, oy] = info.cellOrigin;
  const iso = info.gridType !== "Rectangular";
  const [tw, th] = info.tileSize;
  const hw = tw / 2, hh = th / 2;
  const centre = (u: number, v: number): [number, number] => iso ? [ox + (2 * u + (v & 1)) * hw, oy + v * hh] : [ox + u * tw, oy + v * th];
  for (let i = 0; i < cells; i++) {
    const b = i * 4 * FLOATS_PER_VERTEX;
    // Vertex 0 is the quad's top left, vertex 2 its bottom right; an empty cell's vertices are all zero.
    const x0 = f[b], y0 = f[b + 1], x2 = f[b + 2 * FLOATS_PER_VERTEX], y2 = f[b + 2 * FLOATS_PER_VERTEX + 1];
    if (x0 === 0 && y0 === 0 && x2 === 0 && y2 === 0) continue;
    const u = i % W, v = Math.floor(i / W);
    lift[i] = iso ? centre(u, v)[1] + hh - y2 : 0;
  }
  const at = (u: number, v: number) => (u < 0 || v < 0 || u >= W || v >= H ? NaN : lift[v * W + u]);
  if (!iso) {
    // Classic's square cells (no heights): the top and left edges, and the map's own right and bottom edges.
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
      if (Number.isNaN(lift[v * W + u])) continue;
      const [cx, cy] = centre(u, v);
      const x = cx - hw, y = cy - hh;
      line(x, y, x + tw, y, INK);
      line(x, y, x, y + th, INK);
      if (Number.isNaN(at(u + 1, v))) line(x + tw, y, x + tw, y + th, INK);
      if (Number.isNaN(at(u, v + 1))) line(x, y + th, x + tw, y + th, INK);
    }
    return new Float32Array(out);
  }
  // Corner heights (top, right, bottom, left) per cell. A height level is half a tile high.
  const cliff = 2 * hh;
  const corners = new Float32Array(W * H * 4).fill(NaN);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const i = v * W + u, h = lift[i];
    if (Number.isNaN(h)) continue;
    const odd = v & 1;
    const pick = (c: number) => (Number.isNaN(c) || Math.abs(c - h) > cliff ? h : c);
    corners[i * 4] = pick(at(u, v - 2));
    corners[i * 4 + 1] = pick(at(u + odd, v - 1));
    corners[i * 4 + 2] = h;
    corners[i * 4 + 3] = pick(at(u - 1 + odd, v - 1));
  }
  const corner = (u: number, v: number, k: number) => (u < 0 || v < 0 || u >= W || v >= H ? NaN : corners[(v * W + u) * 4 + k]);
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      if (Number.isNaN(lift[i])) continue;
      const [cx, cy] = centre(u, v);
      const [t, r, b, l] = corners.subarray(i * 4, i * 4 + 4);
      const top: [number, number] = [cx, cy - hh - t], right: [number, number] = [cx + hw, cy - r];
      const bottom: [number, number] = [cx, cy + hh - b], left: [number, number] = [cx - hw, cy - l];
      line(left[0], left[1], top[0], top[1], INK);
      line(top[0], top[1], right[0], right[1], INK);
      // The neighbours below draw these edges as their upper ones, unless their corners sit elsewhere (a cliff).
      const odd = v & 1, se = [u + odd, v + 1] as const, sw = [u - 1 + odd, v + 1] as const;
      if (corner(se[0], se[1], 3) !== b || corner(se[0], se[1], 0) !== r) line(right[0], right[1], bottom[0], bottom[1], STEP);
      if (corner(sw[0], sw[1], 1) !== b || corner(sw[0], sw[1], 0) !== l) line(bottom[0], bottom[1], left[0], left[1], STEP);
    }
  }
  return new Float32Array(out);
}

export class GridPass {
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private buffer: WebGLBuffer;
  private width: WebGLUniformLocation | null;
  private count = 0;
  private dirty = true;

  constructor(private gl: WebGL2RenderingContext) {
    this.prog = compile(gl, LINE_VS, COLOR_FS);
    this.width = gl.getUniformLocation(this.prog, "uWidth");
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (const [loc, off] of [[0, 0], [1, 4]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, LINE_FLOATS * 4, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }

  /** The terrain changed (a new map, an edit in the map editor): the lines are made again before the next draw. */
  invalidate() { this.dirty = true; }

  /** view: sets the program's camera uniforms (Renderer.viewUniforms). */
  draw(info: StartInfo, terrain: ArrayBuffer, view: (prog: WebGLProgram) => void) {
    const gl = this.gl;
    if (this.dirty) {
      const lines = gridLines(info, terrain);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, lines, gl.STATIC_DRAW);
      this.count = lines.length / LINE_FLOATS;
      this.dirty = false;
    }
    if (!this.count) return;
    gl.useProgram(this.prog);
    view(this.prog);
    gl.uniform1f(this.width, Math.max(1, Math.round(window.devicePixelRatio || 1)));
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
  }
}
