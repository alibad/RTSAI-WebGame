// Is the browser drawing with the graphics card? Chrome and Edge fall back to software drawing (SwiftShader, or Windows'
// "Microsoft Basic Render Driver") after their GPU process crashes, until the browser restarts, or always when
// hardware acceleration is off. The game, and every page effect, then runs on the CPU and feels slow even on a fast
// machine. Detected once at startup: the menu tells the player, and the page drops its moving effects
// (<html data-gpu="software">, menu.css).

const SOFTWARE = /swiftshader|basic render|llvmpipe|softpipe|software|warp/i;

export interface GpuInfo { software: boolean; renderer: string }

let info: GpuInfo | null = null;

export function gpuInfo(): GpuInfo {
  if (info) return info;
  let renderer = "", software = false;
  try {
    const canvas = document.createElement("canvas");
    // A software-only context is refused when the browser counts it as a "major performance caveat".
    const strict = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    const gl = strict ?? document.createElement("canvas").getContext("webgl2");
    if (gl) {
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      renderer = String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      software = !strict || SOFTWARE.test(renderer);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch { /* no WebGL at all: the engine reports its own error */ }
  info = { software, renderer: renderer.slice(0, 120) };
  if (software) document.documentElement.dataset.gpu = "software";
  return info;
}
