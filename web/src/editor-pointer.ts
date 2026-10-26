export type EditorPointer = { event: "down" | "up" | "move"; x: number; y: number; button: number; mods: number };
type EditorCommand = { run: () => Promise<void>; cancel: () => void };

/** Preserve stroke edges and the captured buttons when worker replies lag behind the mouse. */
export class EditorPointerStream {
  private queue: (EditorPointer | EditorCommand)[] = [];
  private running = false;
  private idle: (() => void)[] = [];
  constructor(private send: (input: EditorPointer) => Promise<void>, private fail: (error: unknown) => void) {}
  reset() {
    const queued = this.queue;
    this.queue = [];
    for (const item of queued) if ("cancel" in item) item.cancel();
  }
  settled(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise(resolve => this.idle.push(resolve));
  }
  push(input: EditorPointer) {
    const last = this.queue[this.queue.length - 1];
    if (input.event === "move" && last && "event" in last && last.event === "move" && last.button === input.button && last.mods === input.mods) this.queue[this.queue.length - 1] = input;
    else this.queue.push(input);
    void this.drain();
  }
  /** Apply a worker command before any pointer input the player sends after it. */
  command<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        run: async () => { try { resolve(await operation()); } catch (error) { reject(error); } },
        cancel: () => reject(new DOMException("Editor operation cancelled", "AbortError")),
      });
      void this.drain();
    });
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const input = this.queue.shift()!;
        try { if ("run" in input) await input.run(); else await this.send(input); } catch (error) { this.fail(error); }
      }
    } finally { this.running = false; this.idle.splice(0).forEach(resolve => resolve()); }
  }
}
