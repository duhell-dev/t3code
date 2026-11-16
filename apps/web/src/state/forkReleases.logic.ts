// duhell: a browser has no desktop updater, so the web client reads the fork's release list to
// learn of a new release (DUHELL.md, "Update check in the browser").
import { cliReleaseChannelOf, newestCliReleaseVersion } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";

export interface ReleaseListEntry {
  readonly tag_name: string;
  readonly draft?: boolean | undefined;
}

/**
 * The version an update moves servers to: `baseVersion`, or the newest published release on
 * `baseVersion`'s channel when that is newer. Without a release list (not read yet, or GitHub could
 * not be read) it stays `baseVersion`, so a failed read changes nothing.
 */
export function releaseUpdateTarget(
  baseVersion: string,
  releases: ReadonlyArray<ReleaseListEntry> | null,
): string {
  if (releases === null) return baseVersion;
  const newest = newestCliReleaseVersion(releases, cliReleaseChannelOf(baseVersion));
  return newest !== undefined && compareSemverVersions(newest, baseVersion) > 0
    ? newest
    : baseVersion;
}

/** GitHub allows 60 unauthenticated requests an hour per IP, shared by every client behind it. */
export const RELEASES_REFRESH_MS = 60 * 60 * 1000;
export const RELEASES_FOCUS_REFRESH_MS = 15 * 60 * 1000;

/** Whether the release list is old enough to read again: hourly, or after 15 minutes on focus. */
export function releasesRefreshDue(lastReadAt: number, now: number, onFocus: boolean): boolean {
  return now - lastReadAt >= (onFocus ? RELEASES_FOCUS_REFRESH_MS : RELEASES_REFRESH_MS);
}
