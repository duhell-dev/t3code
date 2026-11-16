import { describe, expect, it } from "vite-plus/test";

import {
  RELEASES_FOCUS_REFRESH_MS,
  RELEASES_REFRESH_MS,
  releasesRefreshDue,
  releaseUpdateTarget,
} from "./forkReleases.logic";

const CLIENT = "0.1.10-nightly.20261112.1000021";

describe("releaseUpdateTarget", () => {
  it("moves to a newer release on the client's channel", () => {
    expect(
      releaseUpdateTarget(CLIENT, [
        { tag_name: "v0.1.10-nightly.20261116.1000025" },
        { tag_name: "v0.1.10-nightly.20261116.1000024" },
        { tag_name: "v0.1.10-nightly.20261112.1000021" },
      ]),
    ).toBe("0.1.10-nightly.20261116.1000025");
  });

  it("stays on the client's version when it is the newest release", () => {
    expect(
      releaseUpdateTarget(CLIENT, [
        { tag_name: "v0.1.10-nightly.20261112.1000021" },
        { tag_name: "v0.1.10-nightly.20261112.1000020" },
      ]),
    ).toBe(CLIENT);
  });

  it("never moves back to an older release", () => {
    expect(
      releaseUpdateTarget("0.1.10-nightly.20261116.1000025", [
        { tag_name: "v0.1.10-nightly.20261112.1000021" },
      ]),
    ).toBe("0.1.10-nightly.20261116.1000025");
  });

  it("ignores releases on another channel", () => {
    expect(releaseUpdateTarget(CLIENT, [{ tag_name: "v0.2.0" }, { tag_name: "v0.1.11" }])).toBe(
      CLIENT,
    );
    expect(
      releaseUpdateTarget("0.1.9", [
        { tag_name: "v0.1.10-nightly.20261116.1000025" },
        { tag_name: "v0.1.9" },
      ]),
    ).toBe("0.1.9");
  });

  it("skips drafts, whose files cannot be downloaded", () => {
    expect(
      releaseUpdateTarget(CLIENT, [
        { tag_name: "v0.1.10-nightly.20261116.1000025", draft: true },
        { tag_name: "v0.1.10-nightly.20261116.1000024" },
      ]),
    ).toBe("0.1.10-nightly.20261116.1000024");
  });

  it("keeps the client's version when the list could not be read", () => {
    expect(releaseUpdateTarget(CLIENT, null)).toBe(CLIENT);
    expect(releaseUpdateTarget(CLIENT, [])).toBe(CLIENT);
  });
});

describe("releasesRefreshDue", () => {
  const readAt = 1_000_000;

  it("reads again hourly", () => {
    expect(releasesRefreshDue(readAt, readAt + RELEASES_REFRESH_MS - 1, false)).toBe(false);
    expect(releasesRefreshDue(readAt, readAt + RELEASES_REFRESH_MS, false)).toBe(true);
  });

  it("reads again on focus after a quarter hour", () => {
    expect(releasesRefreshDue(readAt, readAt + RELEASES_FOCUS_REFRESH_MS - 1, true)).toBe(false);
    expect(releasesRefreshDue(readAt, readAt + RELEASES_FOCUS_REFRESH_MS, true)).toBe(true);
  });
});
