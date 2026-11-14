import { describe, expect, it } from "vite-plus/test";

import { extractReleaseHighlights } from "@t3tools/shared/releaseHighlights";
import {
  buildForkReleaseNotes,
  readHighlightTrailers,
  readPreviousForkRelease,
  selectUpstreamNightlies,
  type UpstreamRelease,
} from "./duhell-release-notes.ts";

const sha = (digit: string) => digit.repeat(40);
const nightly = (number: number, digit: string, body = ""): UpstreamRelease => ({
  tag_name: `v0.1.10-nightly.20261113.${number}`,
  target_commitish: sha(digit),
  body,
});

describe("duhell-release-notes", () => {
  it("reads the previous release's commit and upstream marker, also from the old prose", () => {
    expect(
      readPreviousForkRelease(
        `x\n<!-- duhell-commit: ${sha("a")} -->\n<!-- duhell-upstream: v0.1.10-nightly.20261113.4656 -->`,
      ),
    ).toEqual({ commit: sha("a"), upstreamThrough: "v0.1.10-nightly.20261113.4656" });
    expect(
      readPreviousForkRelease(`Fork-Bau von duhell-dev/t3code, Zweig duhell, Commit ${sha("b")}.`),
    ).toEqual({ commit: sha("b"), upstreamThrough: null });
  });

  it("takes the nightlies merged after the marker, including one tagged after an earlier merge", () => {
    const releases = [
      nightly(4660, "d"),
      nightly(4656, "c"),
      nightly(4643, "b"),
      { ...nightly(4650, "e"), draft: true },
      nightly(4630, "a"),
    ];
    // 4660 is not merged yet; 4643 was merged before the previous build but tagged after it.
    const inBuild = (commit: string) => commit !== sha("d");
    const selected = selectUpstreamNightlies({
      releases,
      previous: { commit: sha("f"), upstreamThrough: "v0.1.10-nightly.20261113.4630" },
      inBuild,
      inPreviousBuild: () => true,
    });
    expect(selected.nightlies.map((release) => release.tag_name)).toEqual([
      "v0.1.10-nightly.20261113.4656",
      "v0.1.10-nightly.20261113.4643",
    ]);
    expect(selected.through).toBe("v0.1.10-nightly.20261113.4656");

    // Without a marker the previous build's commit bounds the range.
    expect(
      selectUpstreamNightlies({
        releases,
        previous: { commit: sha("f"), upstreamThrough: null },
        inBuild,
        inPreviousBuild: (commit) => commit === sha("a") || commit === sha("b"),
      }).nightlies.map((release) => release.tag_name),
    ).toEqual(["v0.1.10-nightly.20261113.4656"]);

    // The first fork release collects nothing but starts the marker.
    expect(
      selectUpstreamNightlies({ releases, previous: null, inBuild, inPreviousBuild: () => false }),
    ).toEqual({ nightlies: [], through: "v0.1.10-nightly.20261113.4656" });
  });

  it("reads Highlight trailers into title and detail", () => {
    expect(
      readHighlightTrailers("What's new. Server updates list the highlights.\n\nFailover lines\n"),
    ).toEqual([
      { title: "What's new.", detail: "Server updates list the highlights." },
      { title: "Failover lines.", detail: "" },
    ]);
  });

  it("writes fork highlights first, drops fix counts, and keeps the markers", () => {
    const notes = buildForkReleaseNotes({
      version: "0.1.10-nightly.20261114.1000030",
      commit: sha("c"),
      runUrl: "https://github.com/duhell-dev/t3code/actions/runs/1",
      forkHighlights: [{ title: "What's new.", detail: "Shown after an update." }],
      nightlies: [
        nightly(
          4656,
          "c",
          "**v0.1.10-nightly.20261113.4656** · 87 changes\n\n- **Symlink search.** Find symlinks.\n- **What's new.** Shown after an update.\n\n### Plus 77 more bug fixes.\n\n<details>\n<summary>Full changelog</summary>\n\n* fix: a\n</details>",
        ),
        nightly(4643, "b", "**3 bug fixes.**"),
      ],
      upstreamRepository: "pingdotgg/t3code",
      upstreamThrough: "v0.1.10-nightly.20261113.4656",
    });
    expect(notes).not.toContain("bug fixes");
    expect(notes).toContain(`<!-- duhell-commit: ${sha("c")} -->`);
    expect(notes).toContain("<!-- duhell-upstream: v0.1.10-nightly.20261113.4656 -->");
    expect(notes).toContain("2 upstream nightlies");
    expect(extractReleaseHighlights(notes)).toEqual([
      { title: "What's new.", detail: "Shown after an update." },
      { title: "Symlink search.", detail: "Find symlinks." },
    ]);
    expect(readPreviousForkRelease(notes)).toEqual({
      commit: sha("c"),
      upstreamThrough: "v0.1.10-nightly.20261113.4656",
    });
  });
});
