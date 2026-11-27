import type { ReleaseHighlight } from "@t3tools/shared/releaseHighlights";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ReleaseHighlightsList } from "../ReleaseHighlightsList";
import { SidebarWhatsNewNotice } from "./SidebarWhatsNewNotice";
import { WHATS_NEW_SEEN_STORAGE_KEY } from "./whatsNew.logic";

const HIGHLIGHTS: ReadonlyArray<ReleaseHighlight> = Array.from({ length: 24 }, (_, index) => ({
  title: `Highlight ${index + 1}.`,
  detail: "One sentence about what changed in this release, long enough to wrap in the popover.",
}));

vi.mock("~/state/releaseHighlights", () => ({
  useReleaseHighlights: () => HIGHLIGHTS,
}));

describe("SidebarWhatsNewNotice", () => {
  it("expands to every highlight and collapses again, keeping Got it in view", async () => {
    await page.viewport(900, 480);
    localStorage.setItem(WHATS_NEW_SEEN_STORAGE_KEY, JSON.stringify("0.0.0-previous"));
    using _seen = { [Symbol.dispose]: () => localStorage.removeItem(WHATS_NEW_SEEN_STORAGE_KEY) };
    await using _screen = await render(
      <div className="fixed bottom-2 left-2 w-64">
        <SidebarWhatsNewNotice />
      </div>,
    );

    await userEvent.click(page.getByRole("button", { name: "What's new in T3 Code" }));
    const items = page.getByRole("listitem");
    await expect.poll(() => items.elements().length).toBe(8);

    const toggle = page.getByRole("button", { name: "Show all 24 highlights" });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);

    await expect.poll(() => items.elements().length).toBe(24);
    await expect
      .element(page.getByRole("button", { name: "Show fewer" }))
      .toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByRole("button", { name: "Got it" })).toBeInViewport();

    await userEvent.click(page.getByRole("button", { name: "Show fewer" }));
    await expect.poll(() => items.elements().length).toBe(8);
  });

  it("keeps a plain count where the list cannot take a click", async () => {
    await using screen = await render(
      <ReleaseHighlightsList highlights={HIGHLIGHTS} limit={5} expandable={false} />,
    );

    await expect.element(screen.getByText("and 19 more highlights")).toBeVisible();
    expect(screen.getByRole("button").elements()).toHaveLength(0);
  });
});
