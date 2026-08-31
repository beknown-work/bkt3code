// T3-CUSTOM(expbkt3): pure preference logic for the experimental phase sidebar.
//
// Deliberately free of react-native and of the preferences atom, mirroring the
// split between features/threads/threadListV2.ts and its hook: anything that
// imports the atom transitively imports react-native, which the unit test
// bundler cannot parse. Hooks live in phaseSidebarEnabled.ts and
// phaseSidebarVisitStore.ts.

/**
 * How many threads' visit times to remember. The map exists only to answer "is
 * this row unread", a question about recent work, so old entries are worthless
 * and an unbounded map would bloat the preferences blob.
 */
export const PHASE_SIDEBAR_VISIT_CAP = 200;

/**
 * Off by default, and off while preferences are still loading.
 *
 * The opposite default to Thread List v2 on purpose: this is experimental, so a
 * device that has never chosen keeps the stock list, and the first frame after
 * launch must not flash the experimental sidebar before the real answer loads.
 */
export function resolvePhaseSidebarEnabled(input: {
  readonly preference: boolean | undefined;
  readonly preferencesLoaded: boolean;
}): boolean {
  if (!input.preferencesLoaded) return false;
  return input.preference === true;
}

/**
 * Drops the oldest entries once the cap is exceeded.
 *
 * Getting this wrong either grows the blob forever or silently forgets threads
 * the user just opened, so it is tested directly.
 */
export function pruneVisitTimestamps(
  visits: Readonly<Record<string, string>>,
  cap: number = PHASE_SIDEBAR_VISIT_CAP,
): Readonly<Record<string, string>> {
  const entries = Object.entries(visits);
  if (entries.length <= cap) return visits;
  const newestFirst = entries.sort((left, right) => {
    const leftMs = Date.parse(left[1]);
    const rightMs = Date.parse(right[1]);
    // An unparseable timestamp sorts last, so it is dropped before a real one.
    if (Number.isNaN(leftMs) && Number.isNaN(rightMs)) return 0;
    if (Number.isNaN(leftMs)) return 1;
    if (Number.isNaN(rightMs)) return -1;
    return rightMs - leftMs;
  });
  return Object.fromEntries(newestFirst.slice(0, cap));
}
