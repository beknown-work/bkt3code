const TERMINAL_RESET_SEQUENCE = "\u001bc";
const MAX_WRITE_CHARS = 64 * 1024;

interface TerminalWriteTarget {
  write(data: string, callback: () => void): void;
}

interface BufferTarget {
  readonly buffer: string;
  readonly epoch: number;
  readonly sequence: number;
}

interface RawTarget {
  readonly data: string;
  readonly sequence: number;
}

type WritePlan =
  | {
      readonly type: "buffer";
      readonly target: BufferTarget;
      readonly data: string;
      offset: number;
    }
  | {
      readonly type: "raw";
      readonly target: RawTarget;
      readonly data: string;
      offset: number;
    };

function sliceWriteChunk(
  data: string,
  start: number,
): { readonly chunk: string; readonly end: number } {
  let end = Math.min(data.length, start + MAX_WRITE_CHARS);
  if (end < data.length && end > start && /[\uD800-\uDBFF]/.test(data.charAt(end - 1))) {
    end -= 1;
  }
  return { chunk: data.slice(start, end), end };
}

/**
 * Returns the data that can be appended to move between two retained terminal
 * buffers. A null result means their relationship is unknown and a replay is
 * required.
 */
export function terminalBufferAppend(previous: string, next: string): string | null {
  if (next.startsWith(previous)) {
    return next.slice(previous.length);
  }
  if (previous.length === 0) {
    return next;
  }
  if (next.length === 0) {
    return null;
  }

  // Once retained history reaches its byte cap, every output event removes a
  // prefix. Find the large suffix/prefix overlap so only genuinely new output
  // is sent to xterm. Replaying the entire retained buffer for every event can
  // outrun xterm's parser and trip its discard watermark.
  const shorterLength = Math.min(previous.length, next.length);
  const anchorLength = Math.min(64, Math.max(1, Math.floor(shorterLength / 2)));
  const anchor = next.slice(0, anchorLength);
  let overlapStart = Math.max(0, previous.length - next.length);

  while (overlapStart < previous.length) {
    overlapStart = previous.indexOf(anchor, overlapStart);
    if (overlapStart === -1) {
      return null;
    }
    const overlap = previous.length - overlapStart;
    if (overlap <= next.length && next.startsWith(previous.slice(overlapStart))) {
      return next.slice(overlap);
    }
    overlapStart += 1;
  }
  return null;
}

/**
 * Serializes writes through xterm's parser callback. Buffer updates are
 * coalesced while a write is in flight, which bounds xterm's internal write
 * queue even when PTY output arrives faster than the browser can render it.
 */
export class TerminalOutputWriter {
  readonly #terminal: TerminalWriteTarget;
  #processedBuffer = "";
  #processedEpoch = 0;
  #pendingBuffer: BufferTarget | null = null;
  #pendingRaw: RawTarget[] = [];
  #activePlan: WritePlan | null = null;
  #writeInFlight = false;
  #disposed = false;
  #nextSequence = 1;

  constructor(terminal: TerminalWriteTarget) {
    this.#terminal = terminal;
  }

  syncBuffer(buffer: string, epoch: number): void {
    if (this.#disposed) return;

    if (
      this.#activePlan?.type === "buffer" &&
      this.#activePlan.target.buffer === buffer &&
      this.#activePlan.target.epoch === epoch
    ) {
      this.#pendingBuffer = null;
      return;
    }
    if (
      this.#activePlan === null &&
      this.#pendingBuffer === null &&
      this.#processedBuffer === buffer &&
      this.#processedEpoch === epoch
    ) {
      return;
    }

    this.#pendingBuffer = {
      buffer,
      epoch,
      sequence: this.#pendingBuffer?.sequence ?? this.#nextSequence++,
    };
    this.#flush();
  }

  writeRaw(data: string): void {
    if (this.#disposed || data.length === 0) return;
    this.#pendingRaw.push({ data, sequence: this.#nextSequence++ });
    this.#flush();
  }

  dispose(): void {
    this.#disposed = true;
    this.#pendingBuffer = null;
    this.#pendingRaw = [];
    this.#activePlan = null;
  }

  #flush(): void {
    if (this.#disposed || this.#writeInFlight) return;

    if (this.#activePlan === null) {
      const pendingRaw = this.#pendingRaw[0];
      if (
        pendingRaw !== undefined &&
        (this.#pendingBuffer === null || pendingRaw.sequence < this.#pendingBuffer.sequence)
      ) {
        this.#pendingRaw.shift();
        this.#activePlan = {
          type: "raw",
          target: pendingRaw,
          data: pendingRaw.data,
          offset: 0,
        };
      } else if (this.#pendingBuffer !== null) {
        const target = this.#pendingBuffer;
        this.#pendingBuffer = null;
        const append =
          target.epoch === this.#processedEpoch
            ? terminalBufferAppend(this.#processedBuffer, target.buffer)
            : null;
        const data = append === null ? `${TERMINAL_RESET_SEQUENCE}${target.buffer}` : append;
        if (data.length === 0) {
          this.#processedBuffer = target.buffer;
          this.#processedEpoch = target.epoch;
          this.#flush();
          return;
        }
        this.#activePlan = {
          type: "buffer",
          target,
          data,
          offset: 0,
        };
      } else {
        return;
      }
    }

    const plan = this.#activePlan;
    if (plan.offset >= plan.data.length) {
      if (plan.type === "buffer") {
        this.#processedBuffer = plan.target.buffer;
        this.#processedEpoch = plan.target.epoch;
      }
      this.#activePlan = null;
      this.#flush();
      return;
    }

    const start = plan.offset;
    const { chunk, end } = sliceWriteChunk(plan.data, start);
    plan.offset = end;
    this.#writeInFlight = true;
    try {
      this.#terminal.write(chunk, () => {
        if (this.#disposed) return;
        this.#writeInFlight = false;
        this.#flush();
      });
    } catch (error) {
      plan.offset = start;
      this.#writeInFlight = false;
      throw error;
    }
  }
}
