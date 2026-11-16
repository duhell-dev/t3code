import { type ReleaseHighlight, releaseHighlightsBetween } from "@t3tools/shared/releaseHighlights";

import { useForkReleases } from "./forkReleases";

const NO_HIGHLIGHTS: ReadonlyArray<ReleaseHighlight> = [];

/** Null while the releases load or when GitHub could not be read; empty when nothing is worth showing. */
export function useReleaseHighlights(
  fromVersion: string | null | undefined,
  toVersion: string | null,
  enabled = true,
): ReadonlyArray<ReleaseHighlight> | null {
  // duhell: the list is shared with the browser's update check (forkReleases.ts).
  const releases = useForkReleases(enabled && toVersion !== null);
  if (!enabled || toVersion === null) return NO_HIGHLIGHTS;
  if (releases === null) return null;
  return releaseHighlightsBetween(releases, fromVersion, toVersion);
}
