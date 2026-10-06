// WebGL2 renderer for engine snapshots: terrain from the engine's TerrainSpriteLayer vertices, then every
// SpriteRenderable the engine produced this tick (instanced, batched like OpenRA's SpriteRenderer: up to
// 8 sheets per batch, split on blend mode), then selection brackets, health bars and the drag box.

import { COLOR_FS, COLOR_VS, COMBINED_FS, SPRITE_VS, TERRAIN_VS } from "./shaders";
import { DRAW_BYTES, type Actor, type Snapshot, type SpriteInfo, type StartInfo } from "../sim/protocol";

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

interface GLTex { tex: WebGLTexture; width: number; height: number; version: number }

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private spriteProg: WebGLProgram;
  private terrainProg: WebGLProgram;
  private colorProg: WebGLProgram;
  private textures = new Map<number, GLTex>();
  private palette: GLTex | null = null;
  private paletteRows = 1;
  private sprites: SpriteInfo[] = [];
  private terrainVao: WebGLVertexArrayObject | null = null;
  private terrainIndexCount = 0;
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

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false, depth: true, premultipliedAlpha: true, alpha: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.spriteProg = compile(gl, SPRITE_VS, COMBINED_FS);
    this.terrainProg = compile(gl, TERRAIN_VS, COMBINED_FS);
    this.colorProg = compile(gl, COLOR_VS, COLOR_FS);

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
    }
  }

  setStartInfo(info: StartInfo, terrain: ArrayBuffer) {
    const gl = this.gl;
    this.info = info;
    this.sprites = [];
    this.terrainSheets = info.terrainSheets;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, terrain, gl.STATIC_DRAW);
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
    this.terrainIndexCount = idx.length;
  }

  addSprites(s: SpriteInfo[]) {
    for (const x of s) this.sprites.push(x);
  }

  uploadTexture(id: number, version: number, width: number, height: number, kind: number, data: ArrayBuffer) {
    const gl = this.gl;
    const existing = kind === 1 ? this.palette : this.textures.get(id);
    const tex = existing?.tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const entry = { tex, width, height, version };
    if (kind === 1) {
      this.palette = entry;
      this.paletteRows = height;
    } else this.textures.set(id, entry);
  }

  get textureCount() { return this.textures.size; }

  private viewUniforms(prog: WebGLProgram, cam: Camera) {
    const gl = this.gl;
    const W = this.canvas.width / cam.zoom;
    const H = this.canvas.height / cam.zoom;
    const depthOn = !!this.info?.depthBuffer;
    const margin = this.info?.depthMargin ?? 0;
    const sx = cam.x - W / 2;
    const sy = cam.y - H / 2;
    const depth = depthOn ? 2 / (H + margin) : 0;
    gl.uniform3f(gl.getUniformLocation(prog, "uScroll"), sx, sy, depthOn ? sy : 0);
    gl.uniform3f(gl.getUniformLocation(prog, "uP1"), 2 / W, -2 / H, -depth);
    gl.uniform3f(gl.getUniformLocation(prog, "uP2"), -1, 1, depthOn ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(prog, "uZoom"), cam.zoom);
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
    gl.viewport(0, 0, w, h);
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
    if (this.terrainVao) {
      gl.useProgram(this.terrainProg);
      this.viewUniforms(this.terrainProg, cam);
      for (let i = 0; i < 8; i++) {
        const t = this.textures.get(this.terrainSheets[i]);
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, t?.tex ?? null);
      }
      setBlend(gl, 1);
      gl.bindVertexArray(this.terrainVao);
      gl.drawElements(gl.TRIANGLES, this.terrainIndexCount, gl.UNSIGNED_INT, 0);
    }

    if (cur) this.drawSprites(cur, prev, cam, now);
    if (depthOn) gl.disable(gl.DEPTH_TEST);
    if (cur) this.drawOverlay(cur, prev, cam, overlay, now);
    gl.bindVertexArray(null);
    this.stats.frameMs = performance.now() - t0;
  }

  private drawSprites(cur: Snapshot, prev: Snapshot | null, cam: Camera, now: number) {
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
      for (const [texId, slot] of slots) {
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(gl.TEXTURE_2D, this.textures.get(texId)!.tex);
      }
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
      const key = dv.getUint32(o, true);
      const sprite = this.sprites[dv.getInt32(o + 4, true)];
      if (!sprite || !this.textures.has(sprite.tex) || (sprite.tex2 >= 0 && !this.textures.has(sprite.tex2))) {
        this.stats.skipped++;
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
      if (!selected && !hovered) continue;
      if (act.bw <= 0 || act.bh <= 0) continue;
      const [sx, sy] = Renderer.lerpActor(prev?.actorById.get(act.id), act, a);
      const x0 = Math.round(sx) + act.bx;
      const y0 = Math.round(sy) + act.by;
      const x1 = x0 + act.bw;
      const y1 = y0 + act.bh;
      // RA2-style corner brackets
      const c = selected ? [1, 1, 1] : [0.7, 0.7, 0.7];
      const L = Math.max(3, Math.min(act.bw, act.bh) / 4);
      const t = px;
      rect(x0, y0, L, t, c[0], c[1], c[2]); rect(x0, y0, t, L, c[0], c[1], c[2]);
      rect(x1 - L, y0, L, t, c[0], c[1], c[2]); rect(x1 - t, y0, t, L, c[0], c[1], c[2]);
      rect(x0, y1 - t, L, t, c[0], c[1], c[2]); rect(x0, y1 - L, t, L, c[0], c[1], c[2]);
      rect(x1 - L, y1 - t, L, t, c[0], c[1], c[2]); rect(x1 - t, y1 - L, t, L, c[0], c[1], c[2]);
      if (act.maxHp > 0) {
        const f = Math.max(0, act.hp / act.maxHp);
        const col = f > 0.5 ? [0.2, 0.85, 0.25] : f > 0.25 ? [0.95, 0.8, 0.1] : [0.9, 0.15, 0.1];
        rect(x0, y0 - 5 * px - 3, act.bw, 4, 0, 0, 0, 0.75);
        rect(x0 + px, y0 - 4 * px - 3, Math.max(0, (act.bw - 2 * px) * f), 2, col[0], col[1], col[2]);
      }
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
