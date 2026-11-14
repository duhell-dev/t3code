// No effect imports: the fork's release workflow runs this file with plain Node.
import { compareSemverVersions, parseSemver } from "./semver.ts";

export interface ReleaseHighlight {
  readonly title: string;
  readonly detail: string;
}

export interface ReleaseWithNotes {
  readonly tag_name: string;
  readonly body?: string | null | undefined;
  readonly draft?: boolean | undefined;
}

const HIGHLIGHT_LINE = /^[-*]\s+\*\*([^*]+)\*\*\s*(.*)$/;

/**
 * The curated `- **Title.** Detail` bullets of a generated release body
 * (scripts/generate-release-notes.ts). The fix count and the folded changelog are not highlights.
 */
export function extractReleaseHighlights(body: string | null | undefined): Array<ReleaseHighlight> {
  if (!body) return [];
  const summaryEnd = body.search(/<details>/i);
  const highlights: Array<ReleaseHighlight> = [];
  for (const rawLine of (summaryEnd >= 0 ? body.slice(0, summaryEnd) : body).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^#{1,6}\s/.test(line)) break;
    const match = HIGHLIGHT_LINE.exec(line);
    const title = match?.[1]?.trim();
    if (!title) continue;
    const detail = (match?.[2] ?? "").replace(/\s*\((?:#\d+(?:,\s*)?)+\)\.?$/, "").trim();
    highlights.push({ title, detail });
  }
  return highlights;
}

export function formatReleaseHighlights(highlights: ReadonlyArray<ReleaseHighlight>): string {
  return highlights
    .map(({ title, detail }) => `- **${title}**${detail ? ` ${detail}` : ""}`)
    .join("\n");
}

/** Each highlight once, in order; the same feature can be named by several nightlies. */
export function uniqueReleaseHighlights(
  highlights: ReadonlyArray<ReleaseHighlight>,
): Array<ReleaseHighlight> {
  const seen = new Set<string>();
  return highlights.filter(({ title, detail }) => {
    const key = `${title.toLowerCase()}\n${detail.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const releaseVersion = (tagName: string) =>
  /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tagName)?.[1];

/** "nightly", "preview", or "" for stable, as in cliReleaseChannelOf. */
const releaseTrack = (version: string) => parseSemver(version)?.prerelease[0] ?? "";

/**
 * Highlights of the releases an update from `fromVersion` to `toVersion` brings, newest first.
 * Only releases on the target's track count. Without `fromVersion`, only the target's own.
 */
export function releaseHighlightsBetween(
  releases: ReadonlyArray<ReleaseWithNotes>,
  fromVersion: string | null | undefined,
  toVersion: string,
): Array<ReleaseHighlight> {
  const track = releaseTrack(toVersion);
  const included = releases.flatMap((release) => {
    const version = releaseVersion(release.tag_name);
    if (release.draft || version === undefined || releaseTrack(version) !== track) {
      return [];
    }
    if (compareSemverVersions(version, toVersion) > 0) return [];
    if (fromVersion ? compareSemverVersions(version, fromVersion) <= 0 : version !== toVersion) {
      return [];
    }
    return [{ version, highlights: extractReleaseHighlights(release.body) }];
  });
  included.sort((left, right) => compareSemverVersions(right.version, left.version));
  return uniqueReleaseHighlights(included.flatMap(({ highlights }) => highlights));
}
