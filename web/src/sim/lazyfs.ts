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

  /** Creates `path` (absolute, inside the runtime FS) of `size` bytes whose content comes from `read`. */
  add(path: string, size: number, read: RangeReader) {
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
        const c = this.chunk(path, index, size, read);
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
    this.stats.files++;
    this.stats.bytes += size;
  }
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
