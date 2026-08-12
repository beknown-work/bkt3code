/**
 * T3-CUSTOM(expbkt3): Who owns a session's title, and when may we overwrite it.
 *
 * Three rules live here, all of them pure so the reactor seams stay one-liners:
 *
 * 1. The first prompt should always name the session. Upstream only replaces a
 *    title that still equals the placeholder or the exact `titleSeed` the
 *    client optimistically set. The web client sends `truncate(prompt)` as the
 *    title but the *full* prompt as the seed, so every prompt longer than the
 *    truncation budget failed that equality and the session kept its clipped
 *    first line forever. `isPlaceholderTitle` compares against the seed and
 *    against the seed's truncations instead.
 * 2. A name you typed is yours. Nothing generated may replace it.
 * 3. Asking for a new name explicitly hands ownership back to the generator.
 *    That is the `regenerateTitle: true` path, which never consults this module
 *    — a user-authored title is exactly what "regenerate" is asked to replace.
 */

/** Placeholder every client uses for a thread that has never been titled. */
export const DEFAULT_THREAD_TITLE = "New thread";

/**
 * Truncation budgets clients apply when they seed a title from a prompt.
 *
 * `truncate` in `@t3tools/shared/String` defaults to 50 and callers may pass
 * their own, so match on the shape (`<slice>...`) rather than a fixed length.
 */
const TRUNCATION_SUFFIX = "...";

/**
 * True when `title` is the placeholder, the seed, or a truncation of the seed —
 * i.e. nothing a human chose, so the generator may replace it.
 */
export function isPlaceholderTitle(input: {
  readonly title: string;
  readonly titleSeed?: string | undefined;
}): boolean {
  const title = input.title.trim();
  if (title.length === 0 || title === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const seed = input.titleSeed?.trim();
  if (seed === undefined || seed.length === 0) {
    return false;
  }
  if (title === seed) {
    return true;
  }

  // `truncate(seed, n)` === `seed.slice(0, n) + "..."`. Recover n from the
  // candidate rather than guessing the budget the client used.
  if (!title.endsWith(TRUNCATION_SUFFIX)) {
    return false;
  }
  const body = title.slice(0, -TRUNCATION_SUFFIX.length);
  return body.length > 0 && body.length < seed.length && seed.startsWith(body);
}

/**
 * The gate for generated titles: first-turn naming and the periodic refresh.
 *
 * `titleManuallySet` is the durable record of rule 2 and outranks everything —
 * a hand-typed title survives even when it happens to look like a placeholder.
 */
export function canGeneratedTitleReplace(input: {
  readonly title: string;
  readonly titleManuallySet?: boolean | undefined;
  readonly titleSeed?: string | undefined;
}): boolean {
  if (input.titleManuallySet === true) {
    return false;
  }
  return isPlaceholderTitle({ title: input.title, titleSeed: input.titleSeed });
}

/**
 * Whether the first prompt should name this session through the *durable*
 * regeneration flow rather than upstream's forked fiber.
 *
 * Upstream names the first turn from a fiber forked into the turn-start scope.
 * That works upstream, where turn start runs the provider start inline, but this
 * fork hands turn start to the durable execution coordinator and returns as
 * soon as the work is queued. The scope dies with it, taking the forked fiber
 * with it — and because an interrupt is delivered during finalization, the
 * generator's own `catchCause` never gets to log, so the failure is completely
 * silent. Sessions on bkt3 and expbkt3 kept their prompt-derived titles forever
 * while the upstream-style deployment titled the same sessions correctly.
 *
 * The regeneration flow already survives all of this: it runs in a drainable
 * worker with request ids, supersede checks and interrupted-run recovery. So the
 * first prompt asks for a regeneration like every later refresh does, and the
 * only thing left to decide is whether this turn is the one that should ask.
 */
export function shouldNameThreadFromFirstPrompt(input: {
  /** User messages in the thread *including* the one starting this turn. */
  readonly userMessageCount: number;
  readonly title: string;
  readonly titleManuallySet?: boolean | undefined;
  readonly titleSeed?: string | undefined;
}): boolean {
  if (input.userMessageCount !== 1) {
    return false;
  }
  return canGeneratedTitleReplace({
    title: input.title,
    ...(input.titleManuallySet !== undefined ? { titleManuallySet: input.titleManuallySet } : {}),
    ...(input.titleSeed !== undefined ? { titleSeed: input.titleSeed } : {}),
  });
}
