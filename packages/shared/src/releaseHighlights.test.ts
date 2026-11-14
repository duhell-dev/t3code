import { describe, expect, it } from "vite-plus/test";

import {
  extractReleaseHighlights,
  formatReleaseHighlights,
  releaseHighlightsBetween,
} from "./releaseHighlights.ts";

const GENERATED_BODY = `**v0.1.10-nightly.20261113.4656** · 87 changes from 8 contributors

- **Symlink search.** Find symlinked files and folders in workspace search and file mentions.
- **Force stop Codex.** Force stop a Codex turn when Stop does not complete (#36212).

### Plus 77 more bug fixes.

<details>
<summary>Full changelog</summary>

## What's Changed
* **fix(server):** stop device daemon by @someone in https://github.com/pingdotgg/t3code/pull/33566
</details>`;

describe("releaseHighlights", () => {
  it("keeps the curated bullets and drops the fix count and folded changelog", () => {
    expect(extractReleaseHighlights(GENERATED_BODY)).toEqual([
      {
        title: "Symlink search.",
        detail: "Find symlinked files and folders in workspace search and file mentions.",
      },
      { title: "Force stop Codex.", detail: "Force stop a Codex turn when Stop does not complete" },
    ]);
    expect(extractReleaseHighlights("**12 bug fixes.**")).toEqual([]);
    expect(
      extractReleaseHighlights("## What's Changed\n* fix(web): a fix by @a in https://x/pull/1"),
    ).toEqual([]);
    expect(extractReleaseHighlights(null)).toEqual([]);
  });

  it("formats highlights back into the bullets it reads", () => {
    const highlights = extractReleaseHighlights(GENERATED_BODY);
    expect(extractReleaseHighlights(formatReleaseHighlights(highlights))).toEqual(highlights);
  });

  it("collects the releases after the running version up to the target, newest first", () => {
    const releases = [
      { tag_name: "v0.1.10-nightly.20261114.1000030", body: "- **Too new.** Not offered yet." },
      { tag_name: "v0.1.10-nightly.20261113.1000029", body: "- **Target.** In the target." },
      { tag_name: "v0.1.10-nightly.20261113.1000028", body: "- **Draft.** Never.", draft: true },
      {
        tag_name: "v0.1.10-nightly.20261112.1000027",
        body: "- **Between.** Skipped release.\n- **Target.** In the target.",
      },
      { tag_name: "v0.1.9", body: "- **Stable.** Another track." },
      { tag_name: "v0.1.10-nightly.20261111.1000026", body: "- **Running.** Already installed." },
    ];
    const titles = (from: string | undefined, to: string) =>
      releaseHighlightsBetween(releases, from, to).map(({ title }) => title);

    expect(titles("0.1.10-nightly.20261111.1000026", "0.1.10-nightly.20261113.1000029")).toEqual([
      "Target.",
      "Between.",
    ]);
    expect(titles(undefined, "0.1.10-nightly.20261113.1000029")).toEqual(["Target."]);
    expect(titles("0.1.10-nightly.20261113.1000029", "0.1.10-nightly.20261113.1000029")).toEqual(
      [],
    );
  });
});
