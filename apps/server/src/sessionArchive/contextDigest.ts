/**
 * T3-CUSTOM(expbkt3): Render a thread as a handoff digest another session can continue from.
 *
 * The audience is a brand-new agent session — possibly on a different provider —
 * that receives this digest as its very first prompt and has to pick the work
 * up mid-flight. So unlike the archive digest, which points at a transcript
 * sidecar, this one carries the conversation itself: every message inline,
 * role-labelled, newest kept when the size cap forces elision. The preamble
 * tells the receiving agent what it is looking at and to trust the worktree
 * over the digest wherever they disagree.
 *
 * Pure: takes plain data, returns a string plus a truncation flag.
 */
import { fencedBlock, renderGitSection, type HistoryGitState } from "./historyMarkdown.ts";

export interface ContextTranscriptMessage {
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}

export interface ThreadContextDigestInput {
  readonly threadId: string;
  readonly title: string;
  readonly projectName: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly providerInstanceId: string | null;
  readonly model: string | null;
  readonly createdAt: string | null;
  readonly rollingSummary: string | null;
  readonly git: HistoryGitState | null;
  readonly messages: ReadonlyArray<ContextTranscriptMessage>;
}

export interface ThreadContextDigest {
  readonly markdown: string;
  /** True when the transcript was elided to fit the cap. */
  readonly truncated: boolean;
}

/**
 * Total character budget for the transcript section.
 *
 * The digest's primary destination is a composer textarea and a first prompt,
 * so it has to stay well under provider prompt limits while keeping enough of
 * the tail for the receiving agent to continue mid-thought.
 */
const TRANSCRIPT_CHAR_BUDGET = 48_000;

/**
 * Cap for a single message so one pasted log dump cannot consume the whole
 * budget. Middle-elided: the head states intent, the tail states outcome.
 */
const MESSAGE_CHAR_CAP = 12_000;

const EM_DASH = "—";

function orDash(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : EM_DASH;
}

function clampMessageText(text: string): string {
  if (text.length <= MESSAGE_CHAR_CAP) {
    return text;
  }
  const half = Math.floor(MESSAGE_CHAR_CAP / 2);
  const omitted = text.length - MESSAGE_CHAR_CAP;
  return `${text.slice(0, half)}\n\n[… ${omitted} characters elided from the middle of this message …]\n\n${text.slice(text.length - half)}`;
}

function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    default:
      return role.charAt(0).toUpperCase() + role.slice(1);
  }
}

/**
 * Pick the messages that fit the budget.
 *
 * Selection walks backwards from the newest message because the tail is what
 * the next session continues from. The first user message is pinned even when
 * the walk cannot reach it: it is the cheapest complete record of the original
 * goal, and a digest that loses the goal invites confident drift.
 */
export function selectTranscriptMessages(messages: ReadonlyArray<ContextTranscriptMessage>): {
  readonly kept: ReadonlyArray<ContextTranscriptMessage & { readonly clampedText: string }>;
  readonly omittedCount: number;
  readonly pinnedFirstPrompt: boolean;
} {
  const clamped = messages
    .filter((message) => message.text.trim().length > 0)
    .map((message) => ({ ...message, clampedText: clampMessageText(message.text) }));

  let budget = TRANSCRIPT_CHAR_BUDGET;
  const keptFromTail: Array<(typeof clamped)[number]> = [];
  for (let index = clamped.length - 1; index >= 0; index -= 1) {
    const entry = clamped[index]!;
    if (entry.clampedText.length > budget && keptFromTail.length > 0) {
      break;
    }
    keptFromTail.unshift(entry);
    budget -= entry.clampedText.length;
    if (budget <= 0) {
      break;
    }
  }

  const firstPrompt = clamped.find((message) => message.role === "user") ?? null;
  const tailStart = clamped.length - keptFromTail.length;
  const pinnedFirstPrompt =
    firstPrompt !== null && clamped.indexOf(firstPrompt) < tailStart ? true : false;

  const kept = pinnedFirstPrompt && firstPrompt !== null ? [firstPrompt, ...keptFromTail] : keptFromTail;
  return {
    kept,
    omittedCount: clamped.length - kept.length,
    pinnedFirstPrompt,
  };
}

export function renderThreadContextDigest(input: ThreadContextDigestInput): ThreadContextDigest {
  const { kept, omittedCount, pinnedFirstPrompt } = selectTranscriptMessages(input.messages);
  const truncated = omittedCount > 0;

  const lines: Array<string> = [
    "# Session handoff — continue this work",
    "",
    "You are taking over an in-progress T3 Code session. Everything below was",
    "extracted mechanically from that session's record. Read it, then continue",
    "the work. Where this digest and the actual repository state disagree, trust",
    "the repository: verify the git state before acting on it.",
    "",
    "## Session",
    "",
    `- **Title:** ${input.title.trim() || "Untitled session"}`,
    `- **Project:** ${orDash(input.projectName)}`,
    `- **Workspace:** ${orDash(input.workspaceRoot)}`,
    `- **Worktree:** ${orDash(input.worktreePath)}`,
    `- **Branch:** ${orDash(input.branch)}`,
    `- **Source thread id:** \`${input.threadId}\``,
    `- **Provider:** ${orDash(input.providerInstanceId)}${input.model ? ` (${input.model})` : ""}`,
    `- **Created:** ${orDash(input.createdAt)}`,
    `- **Messages:** ${input.messages.length}`,
    "",
  ];

  const rolling = input.rollingSummary?.trim();
  if (rolling) {
    lines.push("## Summary of the work so far", "", rolling, "");
  }

  lines.push(...renderGitSection(input.git));

  lines.push(`## Transcript (${kept.length} of ${input.messages.length} messages)`, "");
  if (kept.length === 0) {
    lines.push("This session had no messages yet.", "");
  }
  for (const [index, message] of kept.entries()) {
    lines.push(
      `### ${roleLabel(message.role)} — ${message.createdAt}`,
      "",
      fencedBlock(message.clampedText),
      "",
    );
    if (pinnedFirstPrompt && index === 0 && omittedCount > 0) {
      lines.push(
        `> … ${omittedCount} intermediate message${omittedCount === 1 ? "" : "s"} omitted to fit the size cap; the transcript resumes near the end of the session …`,
        "",
      );
    }
  }
  if (!pinnedFirstPrompt && omittedCount > 0) {
    lines.splice(
      lines.findIndex((line) => line.startsWith("## Transcript")) + 2,
      0,
      `> … ${omittedCount} earlier message${omittedCount === 1 ? "" : "s"} omitted to fit the size cap …`,
      "",
    );
  }

  return { markdown: `${lines.join("\n").trimEnd()}\n`, truncated };
}
