// Cameos rendered on the GPU from the engine's own sheets and palette (the sheets live only on the GPU once
// sent): one quad into a small framebuffer, read back once, kept as a PNG data URL for the HUD.

export interface IconSprite { tex: number; channel: number; uv: [number, number, number, number]; w: number; h: number; pal: number }

const VS = /* glsl */ `#version 300 es
out vec2 vC;
void main()
{
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vC = c;
  gl_Position = vec4(c.x * 2.0 - 1.0, 1.0 - c.y * 2.0, 0.0, 1.0);
}
`;

// Sheets hold the engine's BGRA bytes: engine Red is .b here, Green .g, Blue .r, Alpha .a.
const FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSheet;
uniform sampler2D uPalette;
uniform vec4 uUV;
uniform int uChannel;
uniform float uRow;
uniform float uRows;
in vec2 vC;
out vec4 o;
void main()
{
  vec4 x = texture(uSheet, mix(uUV.xy, uUV.zw, vC));
  if (uChannel == 4) { o = x.bgra; return; }
  float i = uChannel == 0 ? x.b : uChannel == 1 ? x.g : uChannel == 2 ? x.r : x.a;
  o = texture(uPalette, vec2(i, (uRow + 0.5) / uRows)).bgra;
}
`;

export class IconRaster {
  private prog: WebGLProgram;
  private fbo: WebGLFramebuffer;
  private tex: WebGLTexture;
  private size = [0, 0];

  constructor(private gl: WebGL2RenderingContext) {
    const make = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "icon shader");
      return s;
    };
    this.prog = gl.createProgram()!;
    gl.attachShader(this.prog, make(gl.VERTEX_SHADER, VS));
    gl.attachShader(this.prog, make(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(this.prog);
    this.fbo = gl.createFramebuffer()!;
    this.tex = gl.createTexture()!;
  }

  /** Renders a cameo; null when its sheet or the palette has not arrived yet (try again next frame). */
  render(s: IconSprite, sheet: WebGLTexture | undefined, palette: WebGLTexture | undefined, paletteRows: number): string | null {
    if (!sheet || !palette || s.w <= 0 || s.h <= 0) return null;
    const gl = this.gl;
    if (this.size[0] !== s.w || this.size[1] !== s.h) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, s.w, s.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.size = [s.w, s.h];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.viewport(0, 0, s.w, s.h);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sheet);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, palette);
    const u = (n: string) => gl.getUniformLocation(this.prog, n);
    gl.uniform1i(u("uSheet"), 0);
    gl.uniform1i(u("uPalette"), 1);
    gl.uniform4f(u("uUV"), s.uv[0], s.uv[1], s.uv[2], s.uv[3]);
    gl.uniform1i(u("uChannel"), s.channel);
    gl.uniform1f(u("uRow"), s.pal);
    gl.uniform1f(u("uRows"), paletteRows);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const px = new Uint8Array(s.w * s.h * 4);
    gl.readPixels(0, 0, s.w, s.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // readPixels is bottom-up and the quad was drawn top-down: flip rows.
    const img = new ImageData(s.w, s.h);
    const row = s.w * 4;
    for (let y = 0; y < s.h; y++) img.data.set(px.subarray((s.h - 1 - y) * row, (s.h - y) * row), y * row);
    const canvas = document.createElement("canvas");
    canvas.width = s.w;
    canvas.height = s.h;
    canvas.getContext("2d")!.putImageData(img, 0, 0);
    return canvas.toDataURL("image/png");
  }
}
