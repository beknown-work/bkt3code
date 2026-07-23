import { describe, expect, it } from "vite-plus/test";

import { terminalBufferAppend, TerminalOutputWriter } from "./terminalOutputWriter";

class FakeTerminal {
  readonly writes: string[] = [];
  readonly callbacks: Array<() => void> = [];

  write(data: string, callback: () => void): void {
    this.writes.push(data);
    this.callbacks.push(callback);
  }

  parseNext(): void {
    const callback = this.callbacks.shift();
    if (!callback) {
      throw new Error("No terminal write is pending");
    }
    callback();
  }
}

describe("terminalBufferAppend", () => {
  it("returns direct appended output", () => {
    expect(terminalBufferAppend("hello", "hello world")).toBe(" world");
  });

  it("returns only new output when retained history drops a prefix", () => {
    expect(terminalBufferAppend("abcdefgh", "efghijkl")).toBe("ijkl");
  });

  it("requests a replay for unrelated buffers", () => {
    expect(terminalBufferAppend("old output", "new output")).toBeNull();
  });
});

describe("TerminalOutputWriter", () => {
  it("waits for xterm parsing and coalesces intermediate buffer states", () => {
    const terminal = new FakeTerminal();
    const writer = new TerminalOutputWriter(terminal);

    writer.syncBuffer("hello", 1);
    writer.syncBuffer("hello world", 1);
    writer.syncBuffer("hello world!", 1);

    expect(terminal.writes).toEqual(["\u001bchello"]);

    terminal.parseNext();

    expect(terminal.writes).toEqual(["\u001bchello", " world!"]);
    terminal.parseNext();
    expect(terminal.callbacks).toHaveLength(0);
  });

  it("uses retained-buffer overlap instead of replaying the capped buffer", () => {
    const terminal = new FakeTerminal();
    const writer = new TerminalOutputWriter(terminal);

    writer.syncBuffer("abcdefgh", 1);
    terminal.parseNext();
    writer.syncBuffer("efghijkl", 1);

    expect(terminal.writes).toEqual(["\u001bcabcdefgh", "ijkl"]);
  });

  it("replays after a reset epoch even when buffers overlap", () => {
    const terminal = new FakeTerminal();
    const writer = new TerminalOutputWriter(terminal);

    writer.syncBuffer("hello", 1);
    terminal.parseNext();
    writer.syncBuffer("hello again", 2);

    expect(terminal.writes).toEqual(["\u001bchello", "\u001bchello again"]);
  });

  it("chunks a large replay and allows only one xterm write in flight", () => {
    const terminal = new FakeTerminal();
    const writer = new TerminalOutputWriter(terminal);
    const buffer = "x".repeat(150_000);

    writer.syncBuffer(buffer, 1);

    expect(terminal.writes).toHaveLength(1);
    expect(terminal.writes[0]?.length).toBeLessThanOrEqual(64 * 1024);

    terminal.parseNext();
    expect(terminal.writes).toHaveLength(2);
    terminal.parseNext();
    expect(terminal.writes).toHaveLength(3);
    terminal.parseNext();
    expect(terminal.callbacks).toHaveLength(0);
    expect(terminal.writes.join("")).toBe(`\u001bc${buffer}`);
  });
});
