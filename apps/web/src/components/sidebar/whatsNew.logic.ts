import type { ReleaseHighlight } from "@t3tools/shared/releaseHighlights";

export const WHATS_NEW_SEEN_STORAGE_KEY = "t3code:whats-new-seen:v1";

export type WhatsNewAction = "none" | "mark-seen" | "show";

/**
 * What the app shows the first time it runs a new version. A first launch only records the
 * version, since there is nothing to compare it with; an update without highlights stays quiet.
 */
export function resolveWhatsNew(
  seenVersion: string | null,
  appVersion: string,
  highlights: ReadonlyArray<ReleaseHighlight> | null,
): WhatsNewAction {
  if (seenVersion === null) return "mark-seen";
  if (seenVersion === appVersion || highlights === null) return "none";
  return highlights.length > 0 ? "show" : "mark-seen";
}
