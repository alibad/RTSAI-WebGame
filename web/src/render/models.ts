// Replays the engine's ModelRenderer (voxel units) recorded by sim/OpenRA.WebSim/Capture.cs: each tick, models are
// drawn into framebuffer sheets with a WebGL2 port of glsl/model.{vert,frag}; the sprites that show them are part
// of the captured vertex batches drawn by the main renderer.

export const MODEL_CMD_BYTES = 136;
const CMD_BEGIN = 1, CMD_DRAW = 2, CMD_END = 3;

const MODEL_VS = /* glsl */ `#version 300 es
precision highp float;
uniform mat4 View;
uniform mat4 TransformMatrix;
layout(location = 0) in vec3 aVertexPosition;
layout(location = 1) in vec4 aVertexTexCoord;
layout(location = 2) in vec2 aVertexTexMetadata;
out vec4 vTexCoord;
out vec4 vChannelMask;
out vec4 vNormalsMask;

vec4 DecodeMask(float x)
{
  if (x > 0.0)
    return (x > 0.5) ? vec4(1,0,0,0) : vec4(0,1,0,0);
  else
    return (x < -0.5) ? vec4(0,0,0,1) : vec4(0,0,1,0);
}

void main()
{
  gl_Position = View * TransformMatrix * vec4(aVertexPosition, 1.0);
  vTexCoord = aVertexTexCoord;
  vChannelMask = DecodeMask(aVertexTexMetadata.s);
  vNormalsMask = DecodeMask(aVertexTexMetadata.t);
}
`;

// Sheets and the palette are uploaded as the engine's BGRA bytes, so samples are swizzled back to engine RGBA;
// the output is stored BGRA too, like every other sheet the sprite shader samples.
const MODEL_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D Palette;
uniform sampler2D DiffuseTexture;
uniform vec2 Palettes;
uniform float PaletteRows;
uniform vec4 LightDirection;
uniform vec3 AmbientLight;
uniform vec3 DiffuseLight;
in vec4 vTexCoord;
in vec4 vChannelMask;
in vec4 vNormalsMask;
out vec4 fragColor;

void main()
{
  vec4 x = texture(DiffuseTexture, vTexCoord.st).bgra;
  vec4 color = texture(Palette, vec2(dot(x, vChannelMask), (Palettes.x + 0.5) / PaletteRows)).bgra;
  if (color.a < 0.01)
    discard;

  vec4 y = texture(DiffuseTexture, vTexCoord.pq).bgra;
  vec4 normal = (2.0 * texture(Palette, vec2(dot(y, vNormalsMask), (Palettes.y + 0.5) / PaletteRows)).bgra - 1.0);
  vec3 intensity = AmbientLight + DiffuseLight * max(dot(normal, LightDirection), 0.0);
  fragColor = vec4(intensity * color.rgb, color.a).bgra;
}
`;

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

interface Target { fbo: WebGLFramebuffer; depth: WebGLRenderbuffer; width: number; height: number }

export class ModelPass {
  private prog: WebGLProgram;
  private buffers = new Map<number, { vao: WebGLVertexArrayObject; vbo: WebGLBuffer }>();
  private targets = new Map<number, Target>();
  private loc: Record<string, WebGLUniformLocation | null> = {};
  draws = 0;

  constructor(private gl: WebGL2RenderingContext) {
    this.prog = compile(gl, MODEL_VS, MODEL_FS);
    for (const n of ["View", "TransformMatrix", "Palette", "DiffuseTexture", "Palettes", "PaletteRows", "LightDirection", "AmbientLight", "DiffuseLight"])
      this.loc[n] = gl.getUniformLocation(this.prog, n);
  }

  /** A model vertex buffer (OpenRA.Graphics.ModelVertex: pos xyz, tex stuv, meta pc; 36 bytes). */
  setBuffer(id: number, data: ArrayBuffer) {
    const gl = this.gl;
    let b = this.buffers.get(id);
    if (!b) {
      const vao = gl.createVertexArray()!;
      const vbo = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 36, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 36, 28);
      gl.bindVertexArray(null);
      b = { vao, vbo };
      this.buffers.set(id, b);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, b.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  }

  /** Drops a render target's framebuffer (its texture was disposed). */
  freeTarget(id: number) {
    const t = this.targets.get(id);
    if (!t) return;
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteRenderbuffer(t.depth);
    this.targets.delete(id);
  }

  /** Attaches a framebuffer (with depth) to a render-target sheet texture. */
  setTarget(id: number, tex: WebGLTexture, width: number, height: number) {
    const gl = this.gl;
    const old = this.targets.get(id);
    if (old && old.width === width && old.height === height) return;
    const fbo = gl.createFramebuffer()!;
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.targets.set(id, { fbo, depth, width, height });
  }

  /**
   * Executes one tick's model commands: per target, clear and draw every queued model section exactly as
   * ModelRenderer.EndFrame does. `texture(id)` resolves sheet textures; the palette is bound by the caller's id.
   */
  run(cmds: DataView, count: number, texture: (id: number) => WebGLTexture | null, palette: WebGLTexture, paletteRows: number) {
    const gl = this.gl;
    this.draws = 0;
    if (count === 0) return;
    gl.useProgram(this.prog);
    gl.uniform1i(this.loc.DiffuseTexture, 0);
    gl.uniform1i(this.loc.Palette, 8);
    gl.uniform1f(this.loc.PaletteRows, paletteRows);
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, palette);
    gl.disable(gl.BLEND);
    let target: Target | null = null;
    const f = (o: number) => cmds.getFloat32(o, true);
    for (let k = 0; k < count; k++) {
      const o = k * MODEL_CMD_BYTES;
      const kind = cmds.getInt32(o, true);
      if (kind === CMD_BEGIN) {
        target = this.targets.get(cmds.getInt32(o + 4, true)) ?? null;
        if (!target) continue;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, target.width, target.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clearDepth(1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        const a = 2 / target.width;
        gl.uniformMatrix4fv(this.loc.View, false, [a, 0, 0, 0, 0, -a, 0, 0, 0, 0, -2 * a, 0, -1, 1, 0, 1]);
      } else if (kind === CMD_DRAW) {
        if (!target) continue;
        const vb = this.buffers.get(cmds.getInt32(o + 8, true));
        const diffuse = texture(cmds.getInt32(o + 20, true));
        if (!vb || !diffuse) continue;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, diffuse);
        gl.uniform2f(this.loc.Palettes, f(o + 24), f(o + 28));
        gl.uniform4f(this.loc.LightDirection, f(o + 32), f(o + 36), f(o + 40), f(o + 44));
        gl.uniform3f(this.loc.AmbientLight, f(o + 48), f(o + 52), f(o + 56));
        gl.uniform3f(this.loc.DiffuseLight, f(o + 60), f(o + 64), f(o + 68));
        const m = new Float32Array(16);
        for (let i = 0; i < 16; i++) m[i] = f(o + 72 + 4 * i);
        gl.uniformMatrix4fv(this.loc.TransformMatrix, false, m);
        gl.bindVertexArray(vb.vao);
        gl.drawArrays(gl.TRIANGLES, cmds.getInt32(o + 12, true), cmds.getInt32(o + 16, true));
        this.draws++;
      } else if (kind === CMD_END) {
        gl.disable(gl.DEPTH_TEST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        target = null;
      }
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST);
  }
}
