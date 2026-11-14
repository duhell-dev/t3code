import { describe, expect, it } from "vite-plus/test";

import { resolveWhatsNew } from "./whatsNew.logic";

const highlight = { title: "Symlink search.", detail: "Find symlinked files." };

describe("resolveWhatsNew", () => {
  it.each([
    ["first launch records the version", null, [highlight], "mark-seen"],
    ["the version already seen", "1.0.0", [highlight], "none"],
    ["releases still loading or unreadable", "0.9.0", null, "none"],
    ["an update without highlights", "0.9.0", [], "mark-seen"],
    ["an update with highlights", "0.9.0", [highlight], "show"],
  ] as const)("%s", (_, seen, highlights, action) => {
    expect(resolveWhatsNew(seen, "1.0.0", highlights)).toBe(action);
  });
});
