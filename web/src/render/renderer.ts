// WebGL2 renderer for engine snapshots: terrain from the engine's TerrainSpriteLayer vertices, then every
// SpriteRenderable the engine produced this tick (instanced, batched like OpenRA's SpriteRenderer: up to
// 8 sheets per batch, split on blend mode), then selection brackets, health bars and the drag box.

import { COLOR_FS, COLOR_VS, COMBINED_FS, SHROUD_FS, SHROUD_VS, SPRITE_VS, TERRAIN_VS } from "./shaders";
import { DRAW_BYTES, type Actor, type Snapshot, type SpriteInfo, type StartInfo } from "../sim/protocol";
import { ModelPass } from "./models";
import { IconRaster, type IconSprite } from "./icons";

export interface Camera {
  x: number; // world px at the canvas centre
  y: number;
  zoom: number;
}

export interface Overlay {
  selected: Set<number>;
  hover: number | null;
  dragBox: [number, number, number, number] | null; // world px
  orderFlash: { x: number; y: number; t: number; color: [number, number, number] } | null;
  ownPlayer: number;
  markers?: { x: number; y: number; color: [number, number, number] }[];
  /** CycleStatusBars (,): 0 selected and hovered only, 1 also every damaged unit, 2 every unit. */
  statusBars?: number;
}

const INSTANCE_FLOATS = 20;
const MAX_INSTANCES = 65536;
const COLOR_FLOATS = 8;
const MAX_RECTS = 16384;
const TICK_MS = 40;

// OpenRA BlendMode -> WebGL blend state (OpenRA.Platforms.Default.GraphicsContext.SetBlendMode).
function setBlend(gl: WebGL2RenderingContext, mode: number) {
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  switch (mode) {
    case 0: gl.disable(gl.BLEND); break; // None
    case 2: gl.blendFunc(gl.ONE, gl.ONE); break; // Additive
    case 3: gl.blendFunc(gl.ONE, gl.ONE); gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT); break; // Subtractive
    case 4: gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA); break; // Multiply
    case 5: gl.blendFunc(gl.ZERO, gl.SRC_COLOR); break; // Multiplicative
    case 6: gl.blendFunc(gl.DST_COLOR, gl.SRC_COLOR); break; // DoubleMultiplicative
    case 7: gl.blendFunc(gl.DST_COLOR, gl.ONE); break; // LowAdditive
    case 8: gl.blendFunc(gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR); break; // Screen
    case 9: gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR); break; // Translucent
    default: gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); break; // Alpha (premultiplied)
  }
}

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

/** height: rows allocated; rowScale: the engine sheet's full height / height (shipped sheets hold only their used rows). */
interface GLTex { tex: WebGLTexture; width: number; height: number; version: number; rowScale: number }

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private spriteProg: WebGLProgram;
  private terrainProg: WebGLProgram;
  private colorProg: WebGLProgram;
  private shroudProg: WebGLProgram;
  private shroudTex: WebGLTexture | null = null;
  private shroudSize: [number, number] = [0, 0];
  private shroudAllVisible = true;
  readonly models: ModelPass;
  private iconRaster: IconRaster;
  private capVao: WebGLVertexArrayObject;
  private capVbo: WebGLBuffer;
  private capIbo: WebGLBuffer;
  private capQuads = 0;
  private capUploaded: Snapshot | null = null;
  private textures = new Map<number, GLTex>();
  private palette: GLTex | null = null;
  private paletteRows = 1;
  private sprites: SpriteInfo[] = [];
  private terrainVao: WebGLVertexArrayObject | null = null;
  private terrainBuffers: WebGLBuffer[] = [];
  private terrainIndexCount = 0;
  /** Textures the engine disposed: ids are never reused, so a late upload for one (a sheet still in flight) is dropped. */
  private freed = new Set<number>();
  private rowScales = new Float32Array(8);
  private spriteRowScale: WebGLUniformLocation | null;
  private terrainRowScale: WebGLUniformLocation | null;
  private terrainSheets: number[] = [];
  private spriteVao: WebGLVertexArrayObject;
  private instanceBuffer: WebGLBuffer;
  private instanceData = new ArrayBuffer(MAX_INSTANCES * INSTANCE_FLOATS * 4);
  private instanceF32 = new Float32Array(this.instanceData);
  private instanceU32 = new Uint32Array(this.instanceData);
  private colorVao: WebGLVertexArrayObject;
  private colorBuffer: WebGLBuffer;
  private colorData = new Float32Array(MAX_RECTS * COLOR_FLOATS);
  private info: StartInfo | null = null;
  stats = { draws: 0, batches: 0, skipped: 0, frameMs: 0 };
  /** Bumped by every change a frame would show besides the camera and the overlay (the page skips identical frames). */
  version = 0;
  /** A sprite's sheet is not on the GPU (e.g. a faction's sheets not loaded yet): the page fetches it. */
  onMissingTexture: (id: number) => void = () => {};
  /** Debug filter (?only=r2): draw only actors whose type passes, no terrain or effects. */
  actorFilter: ((actorType: number) => boolean) | null = null;
  /** Set to request a pixel readback right after the next frame (verification without screenshots). */
  pixelProbe: ((stats: { nonBackground: number; colors: number; meanRGB: number[] }) => void) | null = null;
  /**
   * Set to receive a copy of the next drawn frame (the feedback screenshot). Copied inside the frame, before the browser
   * presents and clears the drawing buffer, so the context needs no preserveDrawingBuffer.
   */
  frameGrab: ((frame: HTMLCanvasElement) => void) | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false, depth: true, premultipliedAlpha: true, alpha: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.spriteProg = compile(gl, SPRITE_VS, COMBINED_FS);
    this.terrainProg = compile(gl, TERRAIN_VS, COMBINED_FS);
    this.colorProg = compile(gl, COLOR_VS, COLOR_FS);
    this.shroudProg = compile(gl, SHROUD_VS, SHROUD_FS);
    this.models = new ModelPass(gl);
    this.iconRaster = new IconRaster(gl);

    // Captured engine vertices (OpenRA.Graphics.Vertex, the terrain layout) drawn as indexed quads.
    this.capVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.capVao);
    this.capVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.capVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 48, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 48, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 48, 28);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 48, 32);
    this.capIbo = gl.createBuffer()!;
    gl.bindVertexArray(null);

    // Sprite instances
    this.spriteVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.spriteVao);
    this.instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);
    const stride = INSTANCE_FLOATS * 4;
    const f = (loc: number, size: number, offset: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
      gl.vertexAttribDivisor(loc, 1);
    };
    f(0, 4, 0); // dst
    f(1, 2, 4); // z, zsize
    f(2, 4, 6); // uv
    f(3, 4, 10); // uv2
    gl.enableVertexAttribArray(4);
    gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, stride, 14 * 4);
    gl.vertexAttribDivisor(4, 1);
    f(5, 4, 15); // tint
    f(6, 1, 19); // rotation

    // Coloured rects
    this.colorVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.colorVao);
    this.colorBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.colorData.byteLength, gl.DYNAMIC_DRAW);
    for (const [loc, off] of [[0, 0], [1, 4]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, COLOR_FLOATS * 4, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);

    for (const prog of [this.spriteProg, this.terrainProg]) {
      gl.useProgram(prog);
      for (let i = 0; i < 8; i++) gl.uniform1i(gl.getUniformLocation(prog, `Texture${i}`), i);
      gl.uniform1i(gl.getUniformLocation(prog, "Palette"), 8);
      gl.uniform1fv(gl.getUniformLocation(prog, "uRowScale"), new Float32Array(8).fill(1));
    }
    this.spriteRowScale = gl.getUniformLocation(this.spriteProg, "uRowScale");
    this.terrainRowScale = gl.getUniformLocation(this.terrainProg, "uRowScale");
  }

  setStartInfo(info: StartInfo, terrain: ArrayBuffer) {
    const gl = this.gl;
    this.info = info;
    // No sprite reset here: the client resets the table when it requests the start, and the first snapshot
    // (which defines every sprite) can arrive through the shared ring before this message is handled.
    this.terrainSheets = info.terrainSheets;
    this.dropTerrain();
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, terrain, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 48, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 48, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 48, 28);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 48, 32);
    const quads = info.terrainVertexCount / 4;
    const idx = new Uint32Array(quads * 6);
    for (let q = 0; q < quads; q++) {
      const v = q * 4;
      idx.set([v, v + 1, v + 2, v + 2, v + 3, v], q * 6);
    }
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.terrainVao = vao;
    this.terrainBuffers = [vb, ib];
    this.terrainIndexCount = idx.length;
    this.version++;
  }

  /** Map editor: terrain rows the engine redrew (an edit), written over the same rows of the vertex buffer. */
  updateTerrainRows(first: number, data: ArrayBuffer) {
    if (!this.info || !this.terrainBuffers.length) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainBuffers[0]);
    gl.bufferSubData(gl.ARRAY_BUFFER, first * this.info.vertexRowStride * 48, new Uint8Array(data));
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.version++;
  }

  private dropTerrain() {
    const gl = this.gl;
    if (this.terrainVao) gl.deleteVertexArray(this.terrainVao);
    for (const b of this.terrainBuffers) gl.deleteBuffer(b);
    this.terrainVao = null;
    this.terrainBuffers = [];
    this.terrainIndexCount = 0;
  }

  /** The match ended: its world is no longer drawn (the canvas only clears) and its terrain buffers are freed. */
  clearWorld() {
    this.info = null;
    this.dropTerrain();
    this.sprites = [];
    this.capUploaded = null;
    this.version++;
  }

  resetSprites() {
    this.sprites = [];
    this.version++;
  }

  /**
   * Shroud state for the render player: cells[v * cols + u] for projected cell (u, v): 0 unexplored, 1 fogged,
   * 2 visible. Expanded onto the isometric half-tile grid: cell (u, v) sits at texel (2u + (v & 1), v); the texels
   * between cells take the mean of their four neighbours so the bilinear-filtered edges follow the diamonds.
   */
  setShroud(cells: Uint8Array, cols: number, rows: number) {
    const gl = this.gl;
    const iso = this.info?.gridType !== "Rectangular";
    const W = iso ? cols * 2 + 1 : cols;
    const H = rows;
    const tex = new Uint8Array(W * H);
    let all = true;
    for (let v = 0; v < rows; v++) {
      const odd = v & 1;
      for (let u = 0; u < cols; u++) {
        const s = cells[v * cols + u];
        if (s !== 2) all = false;
        tex[v * W + (iso ? 2 * u + odd : u)] = s * 127.5;
      }
    }
    for (let v = 0; iso && v < rows; v++) {
      const odd = v & 1;
      for (let x = 1 - odd; x < W; x += 2) {
        let sum = 0, n = 0;
        if (x > 0) { sum += tex[v * W + x - 1]; n++; }
        if (x < W - 1) { sum += tex[v * W + x + 1]; n++; }
        if (v > 0) { sum += tex[(v - 1) * W + x]; n++; }
        if (v < H - 1) { sum += tex[(v + 1) * W + x]; n++; }
        tex[v * W + x] = n ? sum / n : 0;
      }
    }
    this.shroudAllVisible = all;
    if (!this.shroudTex) this.shroudTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shroudTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, W, H, 0, gl.RED, gl.UNSIGNED_BYTE, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.shroudSize = [W, H];
    this.version++;
  }

  private drawShroud(cam: Camera) {
    const info = this.info;
    if (!info || !this.shroudTex || this.shroudAllVisible || this.actorFilter) return;
    const gl = this.gl;
    gl.useProgram(this.shroudProg);
    this.viewUniforms(this.shroudProg, cam);
    const divisor = info.gridType === "Rectangular" ? 1 : 2;
    const [hw, hh] = [info.tileSize[0] / divisor, info.tileSize[1] / divisor];
    const [ox, oy] = info.cellOrigin;
    const loc = (n: string) => gl.getUniformLocation(this.shroudProg, n);
    // Cover the map plus a margin of shroud around it.
    gl.uniform4f(loc("uRect"), ox - info.tileSize[0], oy - info.tileSize[1], (this.shroudSize[0] + 2) * hw, (this.shroudSize[1] + 3) * hh);
    gl.uniform2f(loc("uOrigin"), ox, oy);
    gl.uniform2f(loc("uHalfTile"), hw, hh);
    gl.uniform2f(loc("uTexSize"), this.shroudSize[0], this.shroudSize[1]);
    gl.uniform1i(loc("uShroud"), 9);
    gl.activeTexture(gl.TEXTURE9);
    gl.bindTexture(gl.TEXTURE_2D, this.shroudTex);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  addSprites(s: SpriteInfo[]) {
    for (const x of s) this.sprites.push(x);
    if (s.length) this.version++;
  }

  uploadTexture(id: number, version: number, width: number, height: number, kind: number, data: ArrayBuffer) {
    if (this.freed.has(id)) return;
    this.version++;
    const gl = this.gl;
    const existing = kind === 1 ? this.palette : this.textures.get(id);
    const tex = existing?.tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (kind === 2) {
      // A render target (voxel sheet): allocated here, drawn into by the model pass.
      if (!existing || existing.width !== width || existing.height !== height)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.models.setTarget(id, tex, width, height);
    } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const entry = { tex, width, height, version, rowScale: 1 };
    if (kind === 1) {
      this.palette = entry;
      this.paletteRows = height;
    } else this.textures.set(id, entry);
  }

  get textureCount() { return this.textures.size; }

  hasTexture(id: number) { return this.textures.has(id); }

  /**
   * A sheet whose first `rows` rows are given (the rest is empty). Only those rows are allocated (shipped sheets are
   * about half empty); the samplers scale v by height / rows, so sprite coordinates stay those of the engine's sheet.
   */
  uploadSheetRows(id: number, width: number, height: number, rows: number, data: Uint8Array) {
    if (this.freed.has(id)) return;
    this.version++;
    const gl = this.gl;
    const allocated = Math.max(1, rows);
    const tex = this.textures.get(id)?.tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, allocated, 0, gl.RGBA, gl.UNSIGNED_BYTE, rows > 0 ? data.subarray(0, width * rows * 4) : null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(id, { tex, width, height: allocated, version: 1, rowScale: height / allocated });
  }

  /** The engine disposed this texture: its ids are never reused, so the GPU copy can go. */
  freeTexture(id: number) {
    this.freed.add(id);
    const t = this.textures.get(id);
    if (!t) return;
    this.version++;
    this.models.freeTarget(id);
    this.gl.deleteTexture(t.tex);
    this.textures.delete(id);
  }

  /** A cameo as a PNG data URL, or null until its sheet and the palette are on the GPU. */
  renderIcon(s: IconSprite): string | null {
    const t = this.textures.get(s.tex);
    if (!t) this.onMissingTexture(s.tex);
    const k = t?.rowScale ?? 1;
    const sprite = k === 1 ? s : { ...s, uv: [s.uv[0], s.uv[1] * k, s.uv[2], s.uv[3] * k] as IconSprite["uv"] };
    return this.iconRaster.render(sprite, t?.tex, this.palette?.tex, this.paletteRows);
  }

  /**
   * A terrain template as a PNG data URL: its tiles' sprites (from the engine's tile sheets) composed at their isometric
   * offsets, the map editor's tile palette. null until the sheets and the palette are on the GPU.
   */
  renderTiles(tiles: (IconSprite & { x: number; y: number })[]): string | null {
    if (!tiles.length) return "";
    const pictures: { c: HTMLCanvasElement; x: number; y: number }[] = [];
    for (const t of tiles) {
      const tex = this.textures.get(t.tex);
      if (!tex) { this.onMissingTexture(t.tex); return null; }
      const k = tex.rowScale ?? 1;
      const s = k === 1 ? t : { ...t, uv: [t.uv[0], t.uv[1] * k, t.uv[2], t.uv[3] * k] as IconSprite["uv"] };
      const c = this.iconRaster.raster(s, tex.tex, this.palette?.tex, this.paletteRows);
      if (!c) return null;
      pictures.push({ c, x: t.x, y: t.y });
    }
    const l = Math.min(...pictures.map((p) => p.x)), t0 = Math.min(...pictures.map((p) => p.y));
    const r = Math.max(...pictures.map((p) => p.x + p.c.width)), b = Math.max(...pictures.map((p) => p.y + p.c.height));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.ceil(r - l));
    out.height = Math.max(1, Math.ceil(b - t0));
    const g = out.getContext("2d")!;
    for (const p of pictures) g.drawImage(p.c, Math.round(p.x - l), Math.round(p.y - t0));
    return out.toDataURL("image/png");
  }

  /**
   * An actor as the battlefield draws it (its own sprites in draw order: shadow, body, overlays; not the selection
   * decorations), fitted on a cameo-shaped plate (120 x 96, twice a 60 x 48 cameo), as a PNG data URL: the HUD's picture
   * of an actor whose art has no cameo. null until its sheets and the palette are on the GPU; "" when it draws no
   * sprites in this snapshot (out of view, or a voxel model).
   */
  renderActor(s: Snapshot, id: number): string | null {
    const parts: { sprite: SpriteInfo; x: number; y: number; w: number; h: number; pal: number }[] = [];
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (let i = 0; i < s.header.drawCount; i++) {
      const o = i * DRAW_BYTES;
      // Decorations (1), rotated sprites (2) and sprites above the shroud (4) are not the actor's body.
      if (s.draws.getUint32(o, true) !== id || (s.draws.getUint16(o + 26, true) & 7) !== 0) continue;
      const sprite = this.sprites[s.draws.getInt32(o + 4, true)];
      if (!sprite) continue;
      const scale = s.draws.getFloat32(o + 20, true);
      const x = s.draws.getFloat32(o + 8, true), y = s.draws.getFloat32(o + 12, true);
      const w = Math.abs(scale * sprite.size[0]), h = Math.abs(scale * sprite.size[1]);
      if (w < 1 || h < 1) continue;
      parts.push({ sprite, x, y, w, h, pal: s.draws.getUint16(o + 24, true) });
      l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x + w); b = Math.max(b, y + h);
    }
    if (!parts.length) return "";
    const W = 120, H = 96, pad = 5;
    const k = Math.min((W - 2 * pad) / (r - l), (H - 2 * pad) / (b - t), 2);
    const out = document.createElement("canvas");
    out.width = W;
    out.height = H;
    const ctx = out.getContext("2d")!;
    const plate = ctx.createLinearGradient(0, 0, 0, H);
    plate.addColorStop(0, "#36432f");
    plate.addColorStop(1, "#11160f");
    ctx.fillStyle = plate;
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const ox = (W - (r - l) * k) / 2, oy = (H - (b - t) * k) / 2;
    for (const p of parts) {
      const sheet = this.textures.get(p.sprite.tex);
      if (!sheet) { this.onMissingTexture(p.sprite.tex); return null; }
      // At the sheet's own resolution, then scaled onto the plate (shipped sheets keep only their used rows).
      const [u0, v0, u1, v1] = p.sprite.uv;
      const pw = Math.max(1, Math.round(Math.abs(u1 - u0) * sheet.width)), ph = Math.max(1, Math.round(Math.abs(v1 - v0) * sheet.height * sheet.rowScale));
      const k2 = sheet.rowScale;
      const pixels = this.iconRaster.raster({ tex: p.sprite.tex, channel: p.sprite.channel, uv: [u0, v0 * k2, u1, v1 * k2], w: pw, h: ph, pal: p.pal },
        sheet.tex, this.palette?.tex, this.paletteRows);
      if (!pixels) return null;
      ctx.drawImage(pixels, ox + (p.x - l) * k, oy + (p.y - t) * k, p.w * k, p.h * k);
    }
    return out.toDataURL("image/png");
  }

  setModelBuffer(id: number, data: ArrayBuffer) {
    this.models.setBuffer(id, data);
    this.version++;
  }

  /** Draws this snapshot's voxel models into their sheets (once per snapshot, not per frame). */
  runModels(s: Snapshot) {
    if (!this.palette || s.header.modelCmds === 0) return;
    this.version++;
    this.models.run(s.captured.modelCmds, s.header.modelCmds, (id) => this.textures.get(id)?.tex ?? null, this.palette.tex, this.paletteRows);
  }

  private drawCaptured(cur: Snapshot, cam: Camera, ground = false, above = false) {
    const cap = cur.captured;
    if (!cap.batches.length || this.actorFilter) return;
    const gl = this.gl;
    if (above && !cap.batches.some((b) => b.above)) return;
    gl.useProgram(this.terrainProg);
    // Annotations come back from UI space flat (z 0): over the shroud, with no depth test, z must not clip them.
    this.viewUniforms(this.terrainProg, cam, above);
    gl.bindVertexArray(this.capVao);
    if (this.capUploaded !== cur) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.capVbo);
      gl.bufferData(gl.ARRAY_BUFFER, cap.vertices, gl.STREAM_DRAW);
      const quads = cap.vertices.length / 48 / 4;
      if (quads > this.capQuads) {
        const n = Math.max(1024, 1 << Math.ceil(Math.log2(quads)));
        const idx = new Uint32Array(n * 6);
        for (let q = 0; q < n; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 3, q * 4], q * 6);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.capIbo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        this.capQuads = n;
      }
      this.capUploaded = cur;
    }
    for (const b of cap.batches) {
      if (b.ground !== ground || b.above !== above) continue;
      let ok = true;
      for (let i = 0; i < 8; i++) {
        const id = b.textures[i];
        const t = id >= 0 ? this.textures.get(id) : undefined;
        // A freed id is a stale sampler the batch does not use (ids are never reused): bound empty, not waited for.
        if (id >= 0 && !t && !this.freed.has(id)) { ok = false; this.onMissingTexture(id); }
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, t?.tex ?? null);
        this.rowScales[i] = t?.rowScale ?? 1;
      }
      if (!ok) continue;
      gl.uniform1fv(this.terrainRowScale, this.rowScales);
      setBlend(gl, b.blend);
      gl.drawElements(gl.TRIANGLES, (b.count / 4) * 6, gl.UNSIGNED_INT, (b.start / 4) * 6 * 4);
      this.stats.batches++;
    }
    gl.bindVertexArray(null);
  }

  /**
   * The world rectangle in view is the canvas's CSS size over the zoom: at zoom 1 a world pixel is a CSS pixel on any
   * display. A Retina or 4K-at-200% screen shows the same battlefield as any other, drawn with more pixels, instead
   * of twice as much world at half the size (which ran past the map's edge into black on smaller maps).
   */
  static viewSize(canvas: HTMLCanvasElement, zoom: number): [number, number] {
    return [Math.max(1, canvas.clientWidth) / zoom, Math.max(1, canvas.clientHeight) / zoom];
  }

  /** The view's projection; flat: no depth (every z maps to 0), for passes drawn without a depth test. */
  private viewUniforms(prog: WebGLProgram, cam: Camera, flat = false) {
    const gl = this.gl;
    const [W, H] = Renderer.viewSize(this.canvas, cam.zoom);
    const depthOn = !flat && !!this.info?.depthBuffer;
    const margin = this.info?.depthMargin ?? 0;
    const sx = cam.x - W / 2;
    const sy = cam.y - H / 2;
    // The depth range starts a little above the view's top edge: a terrain cell whose centre lies just above the
    // screen still draws its lower half there, and without the pad those triangles fall past the far plane (a row
    // of black notches along the top of the view). Below, the engine's margin as before.
    const pad = depthOn ? 2 * (this.info?.tileSize[1] ?? 0) : 0;
    const depth = depthOn ? 2 / (H + margin + pad) : 0;
    gl.uniform3f(gl.getUniformLocation(prog, "uScroll"), sx, sy, depthOn ? sy - pad : 0);
    gl.uniform3f(gl.getUniformLocation(prog, "uP1"), 2 / W, -2 / H, -depth);
    gl.uniform3f(gl.getUniformLocation(prog, "uP2"), -1, 1, depthOn ? 1 : 0);
    // Drawing-buffer pixels per world pixel: the sprite shaders snap to whole pixels of what is actually drawn.
    gl.uniform1f(gl.getUniformLocation(prog, "uZoom"), gl.drawingBufferWidth / W);
    const pr = gl.getUniformLocation(prog, "uPaletteRows");
    if (pr) gl.uniform1f(pr, this.paletteRows);
    const dts = gl.getUniformLocation(prog, "DepthTextureScale");
    if (dts) gl.uniform1f(dts, 128 * depth);
  }

  /** Screen position of an actor between the previous and current tick. */
  static lerpActor(prev: Actor | undefined, cur: Actor, a: number): [number, number, number] {
    if (!prev) return [cur.sx, cur.sy, cur.sz];
    const dx = cur.sx - prev.sx;
    const dy = cur.sy - prev.sy;
    if (dx * dx + dy * dy > 200 * 200) return [cur.sx, cur.sy, cur.sz];
    return [prev.sx + dx * a, prev.sy + dy * a, prev.sz + (cur.sz - prev.sz) * a];
  }

  render(cur: Snapshot | null, prev: Snapshot | null, cam: Camera, overlay: Overlay, now: number) {
    const t0 = performance.now();
    const gl = this.gl;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    // The browser may allocate a smaller drawing buffer than the canvas asks for (a size or memory cap); it is still
    // stretched over the whole element, so draw into all of it rather than the canvas's nominal size.
    const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
    gl.viewport(0, 0, bw, bh);
    gl.clearColor(0.02, 0.03, 0.04, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.stats.draws = 0;
    this.stats.batches = 0;
    this.stats.skipped = 0;
    if (!this.info || !this.palette) return;

    const depthOn = this.info.depthBuffer;
    if (depthOn) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
    }

    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, this.palette.tex);

    // Terrain
    if (this.terrainVao && !this.actorFilter) {
      gl.useProgram(this.terrainProg);
      this.viewUniforms(this.terrainProg, cam);
      for (let i = 0; i < 8; i++) {
        const t = this.textures.get(this.terrainSheets[i]);
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, t?.tex ?? null);
        this.rowScales[i] = t?.rowScale ?? 1;
      }
      gl.uniform1fv(this.terrainRowScale, this.rowScales);
      setBlend(gl, 1);
      gl.bindVertexArray(this.terrainVao);
      gl.drawElements(gl.TRIANGLES, this.terrainIndexCount, gl.UNSIGNED_INT, 0);
    }

    // Flat project terrain is a background pass. Its per-tile depth must not
    // reject foreground pixels as actors cross tile boundaries. Keep depth
    // testing for actors against other actors (including buildings).
    if (depthOn) gl.disable(gl.DEPTH_TEST);
    if (cur) this.drawCaptured(cur, cam, true);
    if (depthOn) { gl.enable(gl.DEPTH_TEST); gl.clear(gl.DEPTH_BUFFER_BIT); }
    if (cur) this.drawSprites(cur, prev, cam, now, false);
    if (cur) this.drawCaptured(cur, cam);
    if (depthOn) gl.disable(gl.DEPTH_TEST);
    this.drawShroud(cam);
    if (cur) this.drawCaptured(cur, cam, false, true); // above the shroud: always-visible range circles (sensor zones)
    if (cur) this.drawSprites(cur, prev, cam, now, true); // above the shroud: placement previews, rally points
    if (cur) this.drawOverlay(cur, prev, cam, overlay, now);
    gl.bindVertexArray(null);
    this.stats.frameMs = performance.now() - t0;

    if (this.pixelProbe) {
      const px = new Uint8Array(bw * bh * 4);
      gl.readPixels(0, 0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let non = 0;
      const sum = [0, 0, 0];
      const colors = new Set<number>();
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        if (r > 12 || g > 12 || b > 14) {
          non++;
          sum[0] += r; sum[1] += g; sum[2] += b;
          if (colors.size < 100000) colors.add((r << 16) | (g << 8) | b);
        }
      }
      const cb = this.pixelProbe;
      this.pixelProbe = null;
      cb({ nonBackground: non / (bw * bh), colors: colors.size, meanRGB: sum.map((s) => Math.round(s / Math.max(1, non))) });
    }
    if (this.frameGrab) {
      const grab = this.frameGrab;
      this.frameGrab = null;
      const copy = document.createElement("canvas");
      copy.width = w;
      copy.height = h;
      copy.getContext("2d")!.drawImage(this.canvas, 0, 0);
      grab(copy);
    }
  }

  private drawSprites(cur: Snapshot, prev: Snapshot | null, cam: Camera, now: number, aboveShroud: boolean) {
    const gl = this.gl;
    gl.useProgram(this.spriteProg);
    this.viewUniforms(this.spriteProg, cam);
    gl.bindVertexArray(this.spriteVao);

    const a = Math.min(1, Math.max(0, (now - cur.receivedAt) / TICK_MS));
    // Effects (projectiles, explosions) have no actor: match them to the previous tick by key + occurrence.
    const prevEffects = new Map<number, number[]>();
    if (prev) {
      const pd = prev.draws;
      for (let i = 0; i < prev.header.drawCount; i++) {
        const o = i * DRAW_BYTES;
        const key = pd.getUint32(o, true);
        if (key < 0x80000000) continue;
        let list = prevEffects.get(key);
        if (!list) prevEffects.set(key, (list = []));
        list.push(pd.getFloat32(o + 8, true), pd.getFloat32(o + 12, true), pd.getFloat32(o + 16, true));
      }
    }
    const effectSeen = new Map<number, number>();
    const actorOffsets = new Map<number, [number, number, number]>();

    const slots = new Map<number, number>();
    let batchStart = 0;
    let n = 0;
    let blend = -1;
    const flush = () => {
      if (n === batchStart) return;
      setBlend(gl, blend);
      this.rowScales.fill(1);
      for (const [texId, slot] of slots) {
        const t = this.textures.get(texId)!;
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        this.rowScales[slot] = t.rowScale;
      }
      gl.uniform1fv(this.spriteRowScale, this.rowScales);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, batchStart * INSTANCE_FLOATS * 4, this.instanceF32, batchStart * INSTANCE_FLOATS, (n - batchStart) * INSTANCE_FLOATS);
      // Instanced attributes start at the batch: rebind with an offset by drawing from a sub-range.
      this.bindInstanceOffset(batchStart);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n - batchStart);
      this.stats.batches++;
      batchStart = n;
      slots.clear();
    };

    const dv = cur.draws;
    for (let i = 0; i < cur.header.drawCount && n < MAX_INSTANCES; i++) {
      const o = i * DRAW_BYTES;
      if (((dv.getUint16(o + 26, true) & 4) !== 0) !== aboveShroud) continue;
      const key = dv.getUint32(o, true);
      if (this.actorFilter) {
        const owner = key !== 0 && key < 0x80000000 ? cur.actorById.get(key) : undefined;
        if (!owner || !this.actorFilter(owner.type)) continue;
      }
      const sprite = this.sprites[dv.getInt32(o + 4, true)];
      if (!sprite || !this.textures.has(sprite.tex) || (sprite.tex2 >= 0 && !this.textures.has(sprite.tex2))) {
        this.stats.skipped++;
        if (sprite) this.onMissingTexture(this.textures.has(sprite.tex) ? sprite.tex2 : sprite.tex);
        continue;
      }

      let x = dv.getFloat32(o + 8, true);
      let y = dv.getFloat32(o + 12, true);
      let z = dv.getFloat32(o + 16, true);
      if (key !== 0 && key < 0x80000000) {
        let off = actorOffsets.get(key);
        if (!off) {
          const ca = cur.actorById.get(key);
          if (ca) {
            const p = Renderer.lerpActor(prev?.actorById.get(key), ca, a);
            off = [p[0] - ca.sx, p[1] - ca.sy, p[2] - ca.sz];
          } else off = [0, 0, 0];
          actorOffsets.set(key, off);
        }
        x += off[0];
        y += off[1];
        z += off[2];
      } else if (key >= 0x80000000) {
        const k = effectSeen.get(key) ?? 0;
        effectSeen.set(key, k + 1);
        const pl = prevEffects.get(key);
        if (pl && pl.length >= (k + 1) * 3) {
          const px = pl[k * 3], py = pl[k * 3 + 1], pz = pl[k * 3 + 2];
          if ((x - px) ** 2 + (y - py) ** 2 < 300 * 300) {
            x = px + (x - px) * a;
            y = py + (y - py) * a;
            z = pz + (z - pz) * a;
          }
        }
      }

      // Sampler slots (OpenRA SpriteRenderer.SetRenderStateForSprite: up to 8 sheets per batch).
      const needed = [sprite.tex, ...(sprite.tex2 >= 0 ? [sprite.tex2] : [])].filter((t) => !slots.has(t));
      if (sprite.blend !== blend || slots.size + needed.length > 8) {
        flush();
        blend = sprite.blend;
      }
      for (const t of [sprite.tex, sprite.tex2]) if (t >= 0 && !slots.has(t)) slots.set(t, slots.size);

      const scale = dv.getFloat32(o + 20, true);
      const pal = dv.getUint16(o + 24, true);
      const base = n * INSTANCE_FLOATS;
      const F = this.instanceF32;
      F[base] = x;
      F[base + 1] = y;
      F[base + 2] = scale * sprite.size[0];
      F[base + 3] = scale * sprite.size[1];
      F[base + 4] = z;
      F[base + 5] = scale * sprite.size[2];
      F[base + 6] = sprite.uv[0];
      F[base + 7] = sprite.uv[1];
      F[base + 8] = sprite.uv[2];
      F[base + 9] = sprite.uv[3];
      F[base + 10] = sprite.uv2[0];
      F[base + 11] = sprite.uv2[1];
      F[base + 12] = sprite.uv2[2];
      F[base + 13] = sprite.uv2[3];
      // Util.FastCreateQuad attribute packing.
      let attr = sprite.channel === 4 ? 0x02 : (sprite.channel << 1) | 0x01;
      attr |= slots.get(sprite.tex)! << 6;
      if (sprite.tex2 >= 0) {
        attr |= (sprite.channel2 << 4) | 0x08;
        attr |= slots.get(sprite.tex2)! << 9;
      }
      // RGBA sprites ignore their palette unless it has a colour shift (SpriteRenderer.ResolveTextureIndex).
      attr |= (sprite.channel === 4 ? 0 : pal & 0xffff) << 16;
      this.instanceU32[base + 14] = attr >>> 0;
      F[base + 15] = dv.getFloat32(o + 28, true);
      F[base + 16] = dv.getFloat32(o + 32, true);
      F[base + 17] = dv.getFloat32(o + 36, true);
      F[base + 18] = dv.getFloat32(o + 40, true);
      F[base + 19] = dv.getFloat32(o + 44, true);
      n++;
      this.stats.draws++;
    }
    flush();
  }

  private bindInstanceOffset(first: number) {
    const gl = this.gl;
    const stride = INSTANCE_FLOATS * 4;
    const base = first * stride;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, base);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, base + 16);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, base + 24);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, base + 40);
    gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, stride, base + 56);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, stride, base + 60);
    gl.vertexAttribPointer(6, 1, gl.FLOAT, false, stride, base + 76);
  }

  private drawOverlay(cur: Snapshot, prev: Snapshot | null, cam: Camera, ov: Overlay, now: number) {
    const gl = this.gl;
    const a = Math.min(1, Math.max(0, (now - cur.receivedAt) / TICK_MS));
    const D = this.colorData;
    let n = 0;
    const px = 1 / cam.zoom;
    const rect = (x: number, y: number, w: number, h: number, r: number, g: number, b: number, al = 1) => {
      if (n >= MAX_RECTS) return;
      const o = n * COLOR_FLOATS;
      D[o] = x; D[o + 1] = y; D[o + 2] = w; D[o + 3] = h;
      D[o + 4] = r * al; D[o + 5] = g * al; D[o + 6] = b * al; D[o + 7] = al;
      n++;
    };

    for (const act of cur.actors) {
      const selected = ov.selected.has(act.id);
      const hovered = ov.hover === act.id;
      const bars = ov.statusBars ?? 0;
      const barOnly = !selected && !hovered && act.maxHp > 0 && (act.flags & 1) !== 0 && (bars === 2 || (bars === 1 && act.hp < act.maxHp));
      if (!selected && !hovered && !barOnly) continue;
      if (act.bw <= 0 || act.bh <= 0) continue;
      const [sx, sy] = Renderer.lerpActor(prev?.actorById.get(act.id), act, a);
      const x0 = Math.round(sx) + act.bx;
      const y0 = Math.round(sy) + act.by;
      const x1 = x0 + act.bw;
      const y1 = y0 + act.bh;
      // RA2-style corner brackets (not for a unit that only shows its status bar)
      const c = selected ? [1, 1, 1] : [0.7, 0.7, 0.7];
      if (!barOnly) {
        const L = Math.max(3, Math.min(act.bw, act.bh) / 4);
        const t = px;
        rect(x0, y0, L, t, c[0], c[1], c[2]); rect(x0, y0, t, L, c[0], c[1], c[2]);
        rect(x1 - L, y0, L, t, c[0], c[1], c[2]); rect(x1 - t, y0, t, L, c[0], c[1], c[2]);
        rect(x0, y1 - t, L, t, c[0], c[1], c[2]); rect(x0, y1 - L, t, L, c[0], c[1], c[2]);
        rect(x1 - L, y1 - t, L, t, c[0], c[1], c[2]); rect(x1 - t, y1 - L, t, L, c[0], c[1], c[2]);
        if (act.rank > 0) {
          // Veterancy chevrons at the bottom right (gold: veteran, red-gold: elite).
          const col = act.rank >= 2 ? [1, 0.45, 0.2] : [0.95, 0.82, 0.45];
          for (let k = 0; k < act.rank; k++) {
            const cx = x1 - 6 - k * 5, cy = y1 - 4;
            rect(cx, cy, 4, 1.5, col[0], col[1], col[2]);
            rect(cx + 1, cy - 1.5, 2, 1.5, col[0], col[1], col[2]);
          }
        }
      }
      if (act.maxHp > 0) {
        const f = Math.max(0, act.hp / act.maxHp);
        const col = f > 0.5 ? [0.2, 0.85, 0.25] : f > 0.25 ? [0.95, 0.8, 0.1] : [0.9, 0.15, 0.1];
        rect(x0, y0 - 5 * px - 3, act.bw, 4, 0, 0, 0, 0.75);
        rect(x0 + px, y0 - 4 * px - 3, Math.max(0, (act.bw - 2 * px) * f), 2, col[0], col[1], col[2]);
      }
    }

    for (const m of ov.markers ?? []) {
      // Destination flag: a cross with a short pole.
      const [r, g, b] = m.color;
      rect(m.x - 7, m.y - px, 14, 2 * px, r, g, b);
      rect(m.x - px, m.y - 7, 2 * px, 14, r, g, b);
      rect(m.x, m.y - 22, 2 * px, 16, 0.9, 0.9, 0.9);
      rect(m.x + 2 * px, m.y - 22, 9, 6, r, g, b);
    }

    if (ov.dragBox) {
      const [x0, y0, x1, y1] = ov.dragBox;
      const l = Math.min(x0, x1), tp = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
      rect(l, tp, w, h, 1, 1, 1, 0.08);
      rect(l, tp, w, px, 1, 1, 1); rect(l, tp + h, w, px, 1, 1, 1);
      rect(l, tp, px, h, 1, 1, 1); rect(l + w, tp, px, h + px, 1, 1, 1);
    }

    if (ov.orderFlash) {
      const age = (now - ov.orderFlash.t) / 600;
      if (age < 1) {
        const s = 6 + 10 * age;
        const [r, g, b] = ov.orderFlash.color;
        const al = 1 - age;
        const { x, y } = ov.orderFlash;
        rect(x - s, y, 2 * s, px * 2, r, g, b, al);
        rect(x, y - s / 2, px * 2, s, r, g, b, al);
      }
    }

    if (n === 0) return;
    gl.useProgram(this.colorProg);
    this.viewUniforms(this.colorProg, cam);
    setBlend(gl, 1);
    gl.bindVertexArray(this.colorVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, D, 0, n * COLOR_FLOATS);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
  }
}
