// Shared natural-order collator (B5): ONE configuration for every name sort in
// the app. `numeric` orders "Track 2" before "Track 10" (a plain
// localeCompare compares "1" < "2" and gets it backwards), `sensitivity:
// "base"` ignores case and diacritics ("Đổi" == "Doi") so display-order
// matches what the search index considers equal.
//
// Module-level on purpose: locale data load has real cost and sorting is a hot
// path (file listing + search results), so the collator is created once.
export const SORT_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Natural, case/diacritic-insensitive comparison on two display names. */
export function compareNatural(a: string, b: string): number {
  return SORT_COLLATOR.compare(a, b);
}
