/**
 * T3-CUSTOM(expbkt3): guards the fork's own marker discipline.
 *
 * A `// T3-CUSTOM(expbkt3): ...` comment is free-standing text when it sits in
 * JSX *children* position — React renders it into the UI. That is exactly how a
 * 2026-08-27 upstream merge shipped four marker comments into the composer's
 * traits chip and the settings model row, where they showed up as literal
 * "// T3-CUSTOM(expbkt3): ..." labels next to the model picker.
 *
 * Markers in attribute position (inside an unterminated `<Tag ...>`) and in
 * ordinary TypeScript are fine; only children position is a defect. Scanning
 * source is deliberate: rendering every component that carries a marker would
 * be far slower and would still miss the ones no test mounts.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SOURCE_ROOT = new URL("./", import.meta.url).pathname;
const MARKER = "// T3-CUSTOM(expbkt3)";

function collectTsxFiles(directory: string): string[] {
  return NodeFS.readdirSync(directory).flatMap((entry) => {
    const path = NodePath.join(directory, entry);
    if (NodeFS.statSync(path).isDirectory()) return collectTsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/**
 * True when the marker sits between a JSX element's attributes, which is a
 * legal comment position. Walks back to the nearest opening tag and stops at
 * any line that already closed a tag or statement.
 */
function isInsideOpeningTag(lines: readonly string[], index: number): boolean {
  for (let cursor = index - 1; cursor >= 0 && cursor > index - 40; cursor -= 1) {
    const line = lines[cursor]?.trim() ?? "";
    if (line.length === 0 || line.startsWith("//")) continue;
    if (
      line.endsWith(">") ||
      line.endsWith("/>") ||
      line.endsWith(")") ||
      line.endsWith(";") ||
      line.endsWith("{") ||
      line.endsWith(",")
    ) {
      return false;
    }
    if (/<[A-Za-z][\w.]*$/.test(line)) return true;
  }
  return false;
}

function nextMeaningfulLine(lines: readonly string[], index: number): string {
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]?.trim() ?? "";
    if (line.length > 0) return line;
  }
  return "";
}

function previousMeaningfulLine(lines: readonly string[], index: number): string {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor]?.trim() ?? "";
    if (line.length === 0 || line.startsWith("//")) continue;
    return line;
  }
  return "";
}

describe("fork marker placement", () => {
  it("never leaves a T3-CUSTOM comment in JSX children position", () => {
    const offenders: string[] = [];

    for (const file of collectTsxFiles(SOURCE_ROOT)) {
      const lines = NodeFS.readFileSync(file, "utf8").split("\n");
      lines.forEach((rawLine, index) => {
        if (!rawLine.trim().startsWith(MARKER)) return;
        if (isInsideOpeningTag(lines, index)) return;

        const previous = previousMeaningfulLine(lines, index);
        const next = nextMeaningfulLine(lines, index);
        const closesJsx =
          previous.endsWith(">") || previous.endsWith("<>") || previous.endsWith(")}");
        const opensJsx = next.startsWith("<") || next.startsWith("{");
        if (closesJsx && opensJsx) {
          offenders.push(`${file.replace(SOURCE_ROOT, "")}:${index + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
