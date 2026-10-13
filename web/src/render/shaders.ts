// WebGL2 port of OpenRA's glsl/combined.{vert,frag}. Sheets are uploaded as the engine's BGRA bytes into RGBA
// textures, so the channel masks and palette lookups swizzle accordingly (engine Red channel = byte 2 = .b here).

const DECODE = /* glsl */ `
vec4 SelectChannelMask(uint x)
{
  switch (x)
  {
    case 7u: return vec4(0.0, 0.0, 0.0, 1.0); // Alpha -> byte 3
    case 5u: return vec4(1.0, 0.0, 0.0, 0.0); // Blue  -> byte 0
    case 3u: return vec4(0.0, 1.0, 0.0, 0.0); // Green -> byte 1
    case 2u: return vec4(1.0, 1.0, 1.0, 1.0); // RGBA
    case 1u: return vec4(0.0, 0.0, 1.0, 0.0); // Red   -> byte 2
    default: return vec4(0.0);
  }
}

void Decode(uint attr)
{
  vChannelType = attr & 0x07u;
  vChannelMask = SelectChannelMask(vChannelType);
  vDepthMask = SelectChannelMask((attr >> 3) & 0x07u);
  vChannelSampler = (attr >> 6) & 0x07u;
  vDepthSampler = (attr >> 9) & 0x07u;
  vTexPalette = float(attr >> 16) / uPaletteRows;
}
`;

const VARYINGS_OUT = /* glsl */ `
out vec4 vTexCoord;
flat out float vTexPalette;
flat out vec4 vChannelMask;
flat out uint vChannelSampler;
flat out uint vChannelType;
flat out vec4 vDepthMask;
flat out uint vDepthSampler;
out vec4 vTint;
`;

const UNIFORMS_VS = /* glsl */ `
uniform vec3 uScroll;
uniform vec3 uP1;
uniform vec3 uP2;
uniform float uPaletteRows;
uniform float uZoom;
`;

/** Terrain: the engine's TerrainSpriteLayer vertices, unchanged (Vertex: vec3 pos, vec4 tex, uint attrib, vec4 tint). */
export const TERRAIN_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${UNIFORMS_VS}
layout(location = 0) in vec3 aVertexPosition;
layout(location = 1) in vec4 aVertexTexCoord;
layout(location = 2) in uint aVertexAttributes;
layout(location = 3) in vec4 aVertexTint;
${VARYINGS_OUT}
${DECODE}
void main()
{
  gl_Position = vec4((aVertexPosition - uScroll) * uP1 + uP2, 1.0);
  vTexCoord = aVertexTexCoord;
  Decode(aVertexAttributes);
  vTint = aVertexTint;
}
`;

/** Actors and effects: one instance per engine SpriteRenderable (quad origin, size, uv, attrib, tint). */
export const SPRITE_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${UNIFORMS_VS}
layout(location = 0) in vec4 aDst;   // x, y, w, h (world px)
layout(location = 1) in vec2 aZ;     // z at top, z delta to bottom (ZRamp)
layout(location = 2) in vec4 aUV;
layout(location = 3) in vec4 aUV2;
layout(location = 4) in uint aAttr;
layout(location = 5) in vec4 aTint;
layout(location = 6) in float aRot;
${VARYINGS_OUT}
${DECODE}
void main()
{
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  // Snap the quad origin to a screen pixel so interpolated sprites stay crisp.
  vec2 origin = floor((aDst.xy - uScroll.xy) * uZoom + 0.5) / uZoom + uScroll.xy;
  vec3 pos = vec3(origin + c * aDst.zw, aZ.x + c.y * aZ.y);
  if (aRot != 0.0)
  {
    vec2 centre = origin + 0.5 * aDst.zw;
    vec2 d = pos.xy - centre;
    float s = sin(aRot);
    float k = cos(aRot);
    pos.xy = centre + vec2(d.x * k - d.y * s, d.x * s + d.y * k);
  }

  gl_Position = vec4((pos - uScroll) * uP1 + uP2, 1.0);
  vTexCoord = vec4(mix(aUV.xy, aUV.zw, c), mix(aUV2.xy, aUV2.zw, c));
  Decode(aAttr);
  vTint = aTint;
}
`;

export const COMBINED_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D Texture0;
uniform sampler2D Texture1;
uniform sampler2D Texture2;
uniform sampler2D Texture3;
uniform sampler2D Texture4;
uniform sampler2D Texture5;
uniform sampler2D Texture6;
uniform sampler2D Texture7;
uniform sampler2D Palette;
uniform float DepthTextureScale;
// Per sampler: the sheet's full height / its allocated rows (shipped sheets hold only their used rows), else 1.
uniform float uRowScale[8];

in vec4 vTexCoord;
flat in float vTexPalette;
flat in vec4 vChannelMask;
flat in uint vChannelSampler;
flat in uint vChannelType;
flat in vec4 vDepthMask;
flat in uint vDepthSampler;
in vec4 vTint;
out vec4 fragColor;

vec4 Sample(uint i, vec2 p)
{
  switch (i)
  {
    case 7u: return texture(Texture7, vec2(p.x, p.y * uRowScale[7]));
    case 6u: return texture(Texture6, vec2(p.x, p.y * uRowScale[6]));
    case 5u: return texture(Texture5, vec2(p.x, p.y * uRowScale[5]));
    case 4u: return texture(Texture4, vec2(p.x, p.y * uRowScale[4]));
    case 3u: return texture(Texture3, vec2(p.x, p.y * uRowScale[3]));
    case 2u: return texture(Texture2, vec2(p.x, p.y * uRowScale[2]));
    case 1u: return texture(Texture1, vec2(p.x, p.y * uRowScale[1]));
    default: return texture(Texture0, vec2(p.x, p.y * uRowScale[0]));
  }
}

void main()
{
  bool isPaletted = (vChannelType & 0x01u) != 0u;
  bool isColor = vChannelType == 0u;
  vec4 x = Sample(vChannelSampler, vTexCoord.st);
  vec4 c;
  if (isPaletted)
    c = texture(Palette, vec2(dot(x, vChannelMask), vTexPalette)).bgra;
  else if (isColor)
    c = vTexCoord;
  else
    c = x.bgra;

  if (c.a == 0.0)
    discard;

  float depth = gl_FragCoord.z;
  if (length(vDepthMask) > 0.0)
  {
    vec4 y = Sample(vDepthSampler, vTexCoord.pq);
    depth = depth + DepthTextureScale * dot(y, vDepthMask);
  }

  gl_FragDepth = depth;

  if (vTint.a < 0.0)
    c = vec4(vTint.rgb, -vTint.a);
  else
    c *= vTint;

  fragColor = c;
}
`;

/**
 * Shroud and fog. uShroud holds one texel per half-tile on the isometric grid (value 0 unexplored, 0.5 fogged,
 * 1 visible), so bilinear filtering gives soft cell edges. Drawn over the world as one quad in world px.
 */
export const SHROUD_VS = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 uScroll;
uniform vec3 uP1;
uniform vec3 uP2;
uniform vec4 uRect; // world px x, y, w, h
out vec2 vWorld;
void main()
{
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vWorld = uRect.xy + c * uRect.zw;
  gl_Position = vec4((vWorld - uScroll.xy) * uP1.xy + uP2.xy, 0.0, 1.0);
}
`;

export const SHROUD_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uShroud;
uniform vec2 uOrigin;   // world px of the texel (0, 0) centre
uniform vec2 uHalfTile; // world px per texel
uniform vec2 uTexSize;
in vec2 vWorld;
out vec4 fragColor;
void main()
{
  vec2 t = (vWorld - uOrigin) / uHalfTile;
  float v = texture(uShroud, (t + 0.5) / uTexSize).r;
  float black = 1.0 - smoothstep(0.08, 0.42, v);
  float fog = (1.0 - smoothstep(0.58, 0.92, v)) * 0.55;
  float a = max(black, fog);
  if (a <= 0.003) discard;
  fragColor = vec4(0.0, 0.0, 0.0, a);
}
`;

/** Flat-coloured quads for selection brackets, health bars and the drag box (screen-space overlay). */
export const COLOR_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aRect;   // x, y, w, h in world px
layout(location = 1) in vec4 aColor;  // premultiplied rgba
uniform vec3 uScroll;
uniform vec3 uP1;
uniform vec3 uP2;
uniform float uZoom;
out vec4 vColor;
void main()
{
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 origin = floor((aRect.xy - uScroll.xy) * uZoom + 0.5) / uZoom + uScroll.xy;
  vec2 pos = origin + c * aRect.zw;
  gl_Position = vec4((pos - uScroll.xy) * uP1.xy + uP2.xy, 0.0, 1.0);
  vColor = aColor;
}
`;

export const COLOR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 fragColor;
void main() { fragColor = vColor; }
`;
