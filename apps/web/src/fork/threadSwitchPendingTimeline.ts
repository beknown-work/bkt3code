/**
 * T3-CUSTOM(expbkt3): keep a thread's remembered history on screen when a message is sent
 * before the thread's history has loaded.
 *
 * Upstream's thread switch (`resolveThreadSwitchTimeline`) paints the remembered timeline
 * only while the live one is empty. A message sent in that window makes the live timeline
 * non-empty with nothing but the pending message, so a long history collapses to one row and
 * the scroll position resets to the top; when the history arrives it lands above the reader,
 * who is left at the first message of the session. Appending the pending rows to the
 * remembered history instead keeps the list whole until the real history replaces it.
 *
 * @module fork/threadSwitchPendingTimeline
 */

export function withRememberedHistoryWhileLoading<
  Entries extends ReadonlyArray<{ readonly id: string }>,
>(input: {
  /** The thread's history is still loading from the server. */
  readonly loading: boolean;
  /** Messages the server has delivered for this thread so far. */
  readonly serverMessageCount: number;
  readonly entries: Entries;
  readonly remembered: Entries | null;
}): Entries {
  const { entries, remembered } = input;
  if (
    !input.loading ||
    input.serverMessageCount > 0 ||
    entries.length === 0 ||
    remembered === null ||
    remembered.length === 0
  ) {
    return entries;
  }
  const rememberedIds = new Set(remembered.map((entry) => entry.id));
  const pending = entries.filter((entry) => !rememberedIds.has(entry.id));
  return pending.length === 0 ? remembered : ([...remembered, ...pending] as unknown as Entries);
}

/**
 * Whether a finished history load should take the reader to the latest message: they sent
 * while it was loading and have not scrolled away since.
 */
export function shouldFollowEndAfterHistoryLoads(input: {
  readonly wasLoading: boolean;
  readonly loading: boolean;
  readonly pendingSendCount: number;
  readonly followingEnd: boolean;
}): boolean {
  return input.wasLoading && !input.loading && input.pendingSendCount > 0 && input.followingEnd;
}
