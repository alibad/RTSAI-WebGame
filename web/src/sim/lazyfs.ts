// Lazily mounted files in the .NET runtime's in-memory filesystem (Emscripten FS): the file exists with its full
// size, but its bytes are fetched in 256 KB chunks on first read (synchronous range requests, allowed in workers)
// and kept in a bounded LRU cache. Used for the player's private RA2 files, of which a game reads only a fraction.
// Emscripten's own createLazyFile copies byte by byte; this copies chunks with typed-array sets.

const CHUNK = 256 * 1024;

export type RangeReader = (start: number, end: number) => Uint8Array; // [start, end)

export interface LazyStats { files: number; bytes: number; fetchedBytes: number; cachedBytes: number; fetches: number }

export class LazyMount {
  private cache = new Map<string, Uint8Array>(); // insertion order = LRU order
  private cached = 0;
  readonly stats: LazyStats = { files: 0, bytes: 0, fetchedBytes: 0, cachedBytes: 0, fetches: 0 };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private FS: any, private maxCacheBytes = 128 * 1024 * 1024) {}

  private chunk(key: string, index: number, size: number, read: RangeReader): Uint8Array {
    const id = `${key}#${index}`;
    const hit = this.cache.get(id);
    if (hit) {
      this.cache.delete(id);
      this.cache.set(id, hit);
      return hit;
    }
    const start = index * CHUNK;
    const data = read(start, Math.min(size, start + CHUNK));
    this.stats.fetches++;
    this.stats.fetchedBytes += data.length;
    this.cache.set(id, data);
    this.cached += data.length;
    while (this.cached > this.maxCacheBytes && this.cache.size > 1) {
      const [oldest, buf] = this.cache.entries().next().value as [string, Uint8Array];
      this.cache.delete(oldest);
      this.cached -= buf.length;
    }
    this.stats.cachedBytes = this.cached;
    return data;
  }

  /** A file served from memory that is already in JS (no chunk cache). */
  addDirect(path: string, size: number, read: RangeReader) {
    this.add(path, size, read, false);
  }

  /** Creates `path` (absolute, inside the runtime FS) of `size` bytes whose content comes from `read`. */
  add(path: string, size: number, read: RangeReader, cached = true) {
    const FS = this.FS;
    const slash = path.lastIndexOf("/");
    const dir = path.slice(0, slash);
    const name = path.slice(slash + 1);
    FS.mkdirTree(dir);
    const node = FS.createFile(dir, name, {}, true, false);
    Object.defineProperty(node, "usedBytes", { get: () => size });
    node.contents = { length: size };
    const ops: Record<string, unknown> = { ...node.stream_ops };
    ops.read = (_stream: unknown, buffer: Int8Array, offset: number, length: number, position: number) => {
      if (position >= size) return 0;
      const n = Math.min(size - position, length);
      const dst = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, n);
      let done = 0;
      while (done < n) {
        const pos = position + done;
        const index = Math.floor(pos / CHUNK);
        const c = cached ? this.chunk(path, index, size, read) : read(index * CHUNK, Math.min(size, (index + 1) * CHUNK));
        const off = pos - index * CHUNK;
        const take = Math.min(n - done, c.length - off);
        dst.set(c.subarray(off, off + take), done);
        done += take;
      }
      return n;
    };
    ops.write = () => { throw new FS.ErrnoError(30); }; // EROFS
    ops.mmap = () => { throw new FS.ErrnoError(19); }; // ENODEV: callers fall back to read
    node.stream_ops = ops;
    if (cached) {
      this.stats.files++;
      this.stats.bytes += size;
    }
  }
}

/**
 * Mounts every file of an ORAPACK1 bundle (sim/OpenRA.WebSim/Pack.cs) as a file that reads straight from the
 * downloaded buffer, so the bundle is not copied into the WebAssembly heap.
 */
/** Mounts every file of an ORAPACK1 bundle under root; returns name -> [offset, length] within the pack. */
export function mountPack(mount: LazyMount, pack: Uint8Array, root: string) {
  const dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const magic = new TextDecoder().decode(pack.subarray(0, 8));
  if (magic !== "ORAPACK1") throw new Error("not an ORAPACK1 bundle");
  const count = dv.getInt32(8, true);
  const dec = new TextDecoder();
  let p = 12;
  const files = new Map<string, [number, number]>();
  for (let i = 0; i < count; i++) {
    const nameLength = dv.getUint16(p, true);
    p += 2;
    const name = dec.decode(pack.subarray(p, p + nameLength));
    p += nameLength;
    const length = dv.getInt32(p, true);
    p += 4;
    const start = p;
    mount.addDirect(`${root}/${name}`, length, (s, e) => pack.subarray(start + s, start + e));
    files.set(name, [start, length]);
    p += length;
  }
  return files;
}

/** Synchronous HTTP range reads (workers only). */
export function httpRangeReader(url: string): RangeReader {
  return (start, end) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.setRequestHeader("Range", `bytes=${start}-${end - 1}`);
    xhr.responseType = "arraybuffer";
    xhr.send(null);
    if (xhr.status !== 206 && xhr.status !== 200) throw new Error(`${url}: HTTP ${xhr.status}`);
    const all = new Uint8Array(xhr.response as ArrayBuffer);
    // A server that ignored the range sent the whole file.
    return xhr.status === 200 ? all.slice(start, end) : all;
  };
}
