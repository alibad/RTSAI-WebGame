// The ground's height at a real place, for the Earth maps' hills and valleys (sim Relief.cs). Elevation comes from
// Mapterhorn's open terrain tiles (Copernicus DEM and other open elevation data, terrarium encoding, CORS-enabled), read
// in the browser like the rest of the place's evidence.

/** Credit shown with maps that use the elevation. */
export const ELEVATION_CREDIT = "Elevation © Mapterhorn (Copernicus DEM and other open data)";
const TILES = "https://tiles.mapterhorn.com";
const ZOOM = 12;
const TILE = 512;

export interface ElevationGrid {
  /** Metres at each grid point, row by row. */
  data: Float32Array;
  columns: number;
  rows: number;
  /** Metres across one map cell. */
  metersPerCell: number;
  lowest: number;
  highest: number;
}

const decoded = new Map<string, Promise<Float32Array | null>>();

/** One terrain tile as metres per pixel (null where the source has no tile). */
function tile(x: number, y: number): Promise<Float32Array | null> {
  const key = `${ZOOM}/${x}/${y}`;
  let p = decoded.get(key);
  if (!p) {
    p = (async () => {
      const r = await fetch(`${TILES}/${key}.webp`, { mode: "cors" });
      if (!r.ok) return null;
      const bitmap = await createImageBitmap(await r.blob());
      const canvas = new OffscreenCanvas(TILE, TILE);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const px = ctx.getImageData(0, 0, TILE, TILE).data;
      const out = new Float32Array(TILE * TILE);
      // Terrarium: metres = red * 256 + green + blue / 256 - 32768.
      for (let i = 0; i < out.length; i++) out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
      return out;
    })().catch(() => null);
    decoded.set(key, p);
  }
  return p;
}

/**
 * The elevation on the map's corner grid, laid out like the Earth compiler's evidence square: point (i, j) is the cell
 * corner X - Y = i - 1, X + Y = j - 1, at px = i - 1 across (2 * size wide) and py = (j - 1) / 2 down (size tall),
 * north up. Null if the elevation can't be read.
 */
export async function elevationGrid(lat: number, lon: number, radius: number, size: number): Promise<ElevationGrid | null> {
  const span = 2 * radius;
  const columns = 2 * size + 3, rows = 2 * size + 3;
  const cosLat = Math.cos(lat * Math.PI / 180);
  const world = TILE * 2 ** ZOOM;
  const points = new Float64Array(columns * rows * 2);
  const needed = new Set<string>();
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const px = i - 1, py = (j - 1) / 2;
      const east = (px / (2 * size) - 0.5) * span, south = (py / size - 0.5) * span;
      const la = lat - south / 111320, lo = lon + east / (111320 * cosLat);
      // Web Mercator pixel of the point at the tiles' zoom.
      const x = (lo + 180) / 360 * world;
      const s = Math.sin(la * Math.PI / 180);
      const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
      points[(j * columns + i) * 2] = x;
      points[(j * columns + i) * 2 + 1] = y;
      for (const tx of [Math.floor((x - 0.5) / TILE), Math.floor((x + 0.5) / TILE)])
        for (const ty of [Math.floor((y - 0.5) / TILE), Math.floor((y + 0.5) / TILE)]) needed.add(`${tx},${ty}`);
    }
  if (needed.size > 36) return null;
  const tiles = new Map<string, Float32Array | null>();
  await Promise.all([...needed].map(async (k) => { const [tx, ty] = k.split(",").map(Number); tiles.set(k, await tile(tx, ty)); }));
  if ([...tiles.values()].some((t) => !t)) return null;

  const at = (x: number, y: number) => {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    const t = tiles.get(`${tx},${ty}`)!;
    return t[Math.min(TILE - 1, Math.max(0, Math.floor(y - ty * TILE))) * TILE + Math.min(TILE - 1, Math.max(0, Math.floor(x - tx * TILE)))];
  };
  const data = new Float32Array(columns * rows);
  let lowest = Infinity, highest = -Infinity;
  for (let k = 0; k < columns * rows; k++) {
    // Bilinear between pixel centres.
    const x = points[k * 2] - 0.5, y = points[k * 2 + 1] - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const e = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    data[k] = e;
    lowest = Math.min(lowest, e);
    highest = Math.max(highest, e);
  }
  return { data, columns, rows, metersPerCell: span / size, lowest, highest };
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
