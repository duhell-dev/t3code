#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off - CI runs it with plain Node, before any install.
// duhell: release notes for a fork build (.github/workflows/duhell-release.yml). They carry the
// highlights of every upstream nightly merged since the previous fork release plus the fork's own
// `Highlight:` commit trailers, in the form clients read (packages/shared/src/releaseHighlights.ts).
// Runs with plain Node: the workflow links packages/shared in place of an install.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import {
  extractReleaseHighlights,
  formatReleaseHighlights,
  type ReleaseHighlight,
  type ReleaseWithNotes,
  uniqueReleaseHighlights,
} from "@t3tools/shared/releaseHighlights";
import { compareSemverVersions } from "@t3tools/shared/semver";

const UPSTREAM_MARKER = /<!-- duhell-upstream: (v\S+) -->/;
const COMMIT_MARKER = /<!-- duhell-commit: ([0-9a-f]{40}) -->/;
// Releases before the markers named their commit only in prose.
const LEGACY_COMMIT = /\bCommit ([0-9a-f]{40})\b/;
const NIGHTLY_TAG = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;

export interface UpstreamRelease extends ReleaseWithNotes {
  readonly target_commitish: string;
}

export interface PreviousForkRelease {
  readonly commit: string | null;
  readonly upstreamThrough: string | null;
}

export function readPreviousForkRelease(body: string | null | undefined): PreviousForkRelease {
  const text = body ?? "";
  return {
    commit: COMMIT_MARKER.exec(text)?.[1] ?? LEGACY_COMMIT.exec(text)?.[1] ?? null,
    upstreamThrough: UPSTREAM_MARKER.exec(text)?.[1] ?? null,
  };
}

/**
 * The upstream nightlies this build adds, newest first, and the newest one it contains. A nightly
 * counts once its commit is in the build, even if it was tagged after an earlier fork build had
 * already merged that commit: the marker, not the previous build's commit, bounds the range.
 */
export function selectUpstreamNightlies(options: {
  readonly releases: ReadonlyArray<UpstreamRelease>;
  readonly previous: PreviousForkRelease | null;
  readonly inBuild: (commit: string) => boolean;
  readonly inPreviousBuild: (commit: string) => boolean;
}): { readonly nightlies: Array<UpstreamRelease>; readonly through: string | null } {
  const { previous } = options;
  const contained = options.releases
    .filter(
      (release) =>
        !release.draft &&
        NIGHTLY_TAG.test(release.tag_name) &&
        /^[0-9a-f]{40}$/.test(release.target_commitish) &&
        options.inBuild(release.target_commitish),
    )
    .toSorted((left, right) => compareSemverVersions(right.tag_name, left.tag_name));
  const through = contained[0]?.tag_name ?? previous?.upstreamThrough ?? null;
  if (previous === null) return { nightlies: [], through };
  const nightlies = contained.filter((release) =>
    previous.upstreamThrough !== null
      ? compareSemverVersions(release.tag_name, previous.upstreamThrough) > 0
      : previous.commit !== null && !options.inPreviousBuild(release.target_commitish),
  );
  return { nightlies, through };
}

/** `Highlight: Title. Detail` trailers, one per line, as `git log --format=%(trailers:...)` prints them. */
export function readHighlightTrailers(text: string): Array<ReleaseHighlight> {
  return text.split(/\r?\n/).flatMap((rawLine) => {
    const line = rawLine.trim();
    if (line === "") return [];
    const split = line.search(/[.!?](?:\s|$)/);
    if (split < 0) return [{ title: `${line}.`, detail: "" }];
    return [{ title: line.slice(0, split + 1), detail: line.slice(split + 1).trim() }];
  });
}

export function buildForkReleaseNotes(options: {
  readonly version: string;
  readonly commit: string;
  readonly runUrl: string;
  readonly forkHighlights: ReadonlyArray<ReleaseHighlight>;
  readonly nightlies: ReadonlyArray<UpstreamRelease>;
  readonly upstreamRepository: string;
  readonly upstreamThrough: string | null;
}): string {
  const highlights = uniqueReleaseHighlights([
    ...options.forkHighlights,
    ...options.nightlies.flatMap((release) => extractReleaseHighlights(release.body)),
  ]);
  const count = options.nightlies.length;
  const header = `**v${options.version}** · duHell build of ${options.commit.slice(0, 12)}${
    count > 0 ? `, ${count} upstream ${count === 1 ? "nightly" : "nightlies"}` : ""
  }`;
  const upstreamLines = options.nightlies.map(
    (release) =>
      `* [${release.tag_name}](https://github.com/${options.upstreamRepository}/releases/tag/${release.tag_name})`,
  );
  const details = [
    `Fork build of duhell-dev/t3code, branch duhell, commit ${options.commit}.`,
    "CLI archives (Linux x64, Windows x64) for the updater and, when built, the Windows installer with nightly.yml. Unsigned.",
    `Run: ${options.runUrl}`,
    ...(upstreamLines.length > 0
      ? ["", "Upstream nightlies merged since the previous fork release:", ...upstreamLines]
      : []),
  ].join("\n");
  return [
    header,
    ...(highlights.length > 0 ? [formatReleaseHighlights(highlights)] : []),
    `<details>\n<summary>Full changelog</summary>\n\n${details}\n\n</details>`,
    [
      `<!-- duhell-commit: ${options.commit} -->`,
      ...(options.upstreamThrough ? [`<!-- duhell-upstream: ${options.upstreamThrough} -->`] : []),
    ].join("\n"),
  ].join("\n\n");
}

async function githubJson<T>(path: string): Promise<T> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
  return (await response.json()) as T;
}

function gitSucceeds(args: ReadonlyArray<string>): boolean {
  try {
    NodeChildProcess.execFileSync("git", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const isAncestor = (commit: string, of: string) =>
  gitSucceeds(["cat-file", "-e", `${commit}^{commit}`]) &&
  gitSucceeds(["merge-base", "--is-ancestor", commit, of]);

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      version: { type: "string" },
      commit: { type: "string" },
      repository: { type: "string" },
      upstream: { type: "string", default: "pingdotgg/t3code" },
      "run-url": { type: "string", default: "" },
      output: { type: "string" },
    },
  });
  const { version, commit, repository, upstream, output } = values;
  if (!version || !commit || !repository || !upstream || !output) {
    throw new Error("--version, --commit, --repository and --output are required");
  }
  const forkReleases = await githubJson<Array<ReleaseWithNotes>>(
    `repos/${repository}/releases?per_page=20`,
  );
  const previousRelease = forkReleases.find(
    (release) => !release.draft && release.tag_name !== `v${version}`,
  );
  const previous = previousRelease ? readPreviousForkRelease(previousRelease.body) : null;
  const previousCommit = previous?.commit ?? null;
  const upstreamReleases = await githubJson<Array<UpstreamRelease>>(
    `repos/${upstream}/releases?per_page=100`,
  );
  const { nightlies, through } = selectUpstreamNightlies({
    releases: upstreamReleases,
    previous,
    inBuild: (candidate) => isAncestor(candidate, commit),
    inPreviousBuild: (candidate) =>
      previousCommit !== null && isAncestor(candidate, previousCommit),
  });
  const forkHighlights =
    previousCommit !== null && isAncestor(previousCommit, commit)
      ? readHighlightTrailers(
          NodeChildProcess.execFileSync(
            "git",
            [
              "log",
              "--first-parent",
              "--no-merges",
              "--reverse",
              "--format=%(trailers:key=Highlight,valueonly,separator=%x0A)",
              `${previousCommit}..${commit}`,
            ],
            { encoding: "utf8" },
          ),
        )
      : [];
  const notes = buildForkReleaseNotes({
    version,
    commit,
    runUrl: values["run-url"] ?? "",
    forkHighlights,
    nightlies,
    upstreamRepository: upstream,
    upstreamThrough: through,
  });
  NodeFS.writeFileSync(output, `${notes}\n`);
  console.log(notes);
}

if (import.meta.main) {
  await main();
}
