// Lazily mounted files in the .NET runtime's in-memory filesystem (Emscripten FS): the file exists with its full
// size, but its bytes are fetched in 256 KB chunks on first read (synchronous range requests, allowed in workers)
// and kept in a bounded LRU cache. Used for the player's private RA2 files, of which a game reads only a fraction.
// Emscripten's own createLazyFile copies byte by byte; this copies chunks with typed-array sets.

const CHUNK = 256 * 1024;
const WHOLE_FILE = 4 * 1024 * 1024;

export type RangeReader = (start: number, end: number) => Uint8Array; // [start, end)
export type AsyncRangeReader = (start: number, end: number) => Promise<Uint8Array>; // [start, end)

export interface LazyStats { files: number; bytes: number; fetchedBytes: number; cachedBytes: number; fetches: number }

export class LazyMount {
  private cache = new Map<string, Uint8Array>(); // insertion order = LRU order
  private cached = 0;
  readonly stats: LazyStats = { files: 0, bytes: 0, fetchedBytes: 0, cachedBytes: 0, fetches: 0 };
  /** Chunk ids fetched synchronously, when tracing (diagnostics). */
  trace: string[] | null = null;
  /** Lazily mounted files that can also be fetched in the background (audio): path -> size and reader. */
  private background = new Map<string, { size: number; read: AsyncRangeReader }>();
  private fetching = new Map<string, Promise<void>>();

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
    // A file of a few chunks (a music track, a sprite file) is usually read whole: fetch the rest of it with this
    // chunk, one round trip instead of one per chunk (these reads block the engine).
    const start = index * CHUNK;
    const last = size <= WHOLE_FILE ? Math.ceil(size / CHUNK) - 1 : index;
    let end = Math.min(size, (last + 1) * CHUNK);
    for (let i = index + 1; i <= last; i++) if (this.cache.has(`${key}#${i}`)) { end = i * CHUNK; break; }
    const all = read(start, end);
    if (all.length !== end - start) throw new Error(`Short asset read: expected ${end - start} bytes, received ${all.length}`);
    this.stats.fetches++;
    this.stats.fetchedBytes += all.length;
    if (this.trace) this.trace.push(id);
    let data = all.subarray(0, Math.min(CHUNK, all.length));
    for (let i = index, o = 0; o < all.length; i++, o += CHUNK) {
      const piece = all.slice(o, Math.min(all.length, o + CHUNK));
      if (i === index) data = piece;
      this.cache.set(`${key}#${i}`, piece);
      this.cached += piece.length;
    }
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

  /**
   * Whether a file can be read now without waiting: true for files in memory and fully cached lazy files. Otherwise
   * (a lazy file with a background reader) it starts fetching the file in the background and returns false.
   */
  ready(path: string) {
    const bg = this.background.get(path);
    if (!bg) return true;
    const chunks = Math.ceil(bg.size / CHUNK);
    let complete = true;
    for (let i = 0; i < chunks && complete; i++) complete = this.cache.has(`${path}#${i}`);
    if (complete) return true;
    if (!this.fetching.has(path)) {
      const job = bg.read(0, bg.size).then((all) => {
        for (let i = 0, o = 0; o < all.length; i++, o += CHUNK) {
          const piece = all.slice(o, Math.min(all.length, o + CHUNK));
          const id = `${path}#${i}`;
          if (!this.cache.has(id)) { this.cache.set(id, piece); this.cached += piece.length; }
        }
        this.stats.fetchedBytes += all.length;
        this.stats.cachedBytes = this.cached;
      }).catch((e) => console.warn(`lazy: background fetch of ${path} failed`, e))
        .finally(() => this.fetching.delete(path));
      this.fetching.set(path, job);
    }
    return false;
  }

  /** Fetches files in the background, a few at a time (e.g. the voice lines a match will likely need). */
  async prefetch(paths: string[], lanes = 2) {
    const queue = paths.filter((p) => this.background.has(p));
    const lane = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) if (!this.ready(p)) await this.fetching.get(p);
    };
    await Promise.all(Array.from({ length: lanes }, lane));
  }

  /** The files that can be fetched in the background. */
  backgroundPaths() { return [...this.background.keys()]; }

  /** Creates `path` (absolute, inside the runtime FS) of `size` bytes whose content comes from `read`. */
  add(path: string, size: number, read: RangeReader, cached = true, readAsync?: AsyncRangeReader) {
    if (readAsync) this.background.set(path, { size, read: readAsync });
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
        let c: Uint8Array;
        try {
          c = cached ? this.chunk(path, index, size, read) : read(index * CHUNK, Math.min(size, (index + 1) * CHUNK));
          if (c.length <= pos - index * CHUNK) throw new Error("Asset read made no progress");
        } catch (err) {
          // A failed download (HTTP error, network) is an I/O error the runtime can handle (an IOException in .NET).
          // Any other exception would unwind through the WebAssembly frames of the read and leave the runtime
          // corrupted ("memory access out of bounds" a few seconds later).
          console.warn(`lazy read failed: ${path} @${pos}: ${err instanceof Error ? err.message : err}`);
          throw new FS.ErrnoError(29); // EIO
        }
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

/** Asynchronous HTTP range reads (background fetches that never block the engine). */
export function httpRangeReaderAsync(url: string): AsyncRangeReader {
  return async (start, end) => {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
    if (res.status !== 206 && res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
    const all = new Uint8Array(await res.arrayBuffer());
    return res.status === 200 ? all.slice(start, end) : all;
  };
}

/** A single file read whole (and cached by the browser): returns [start, end) of it. */
export function wholeFileReader(url: string): RangeReader {
  let data: Uint8Array | null = null;
  return (start, end) => {
    if (!data) {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.responseType = "arraybuffer";
      xhr.send(null);
      if (xhr.status !== 200) throw new Error(`${url}: HTTP ${xhr.status}`);
      data = new Uint8Array(xhr.response as ArrayBuffer);
    }
    return data.slice(start, end);
  };
}

export function wholeFileReaderAsync(url: string): AsyncRangeReader {
  return async (start, end) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer()).slice(start, end);
  };
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
