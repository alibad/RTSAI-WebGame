export type EditorPointer = { event: "down" | "up" | "move"; x: number; y: number; button: number; mods: number };

/** Preserve stroke edges and the captured buttons when worker replies lag behind the mouse. */
export class EditorPointerStream {
  private queue: EditorPointer[] = [];
  private running = false;
  constructor(private send: (input: EditorPointer) => Promise<void>, private fail: (error: unknown) => void) {}
  reset() { this.queue = []; }
  push(input: EditorPointer) {
    const last = this.queue[this.queue.length - 1];
    if (input.event === "move" && last?.event === "move" && last.button === input.button && last.mods === input.mods) this.queue[this.queue.length - 1] = input;
    else this.queue.push(input);
    void this.drain();
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const input = this.queue.shift()!;
        try { await this.send(input); } catch (error) { this.fail(error); }
      }
    } finally { this.running = false; }
  }
}
