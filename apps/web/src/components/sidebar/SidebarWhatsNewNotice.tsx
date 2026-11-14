import * as Schema from "effect/Schema";
import { MegaphoneIcon, XIcon } from "lucide-react";
import { useEffect } from "react";

import { APP_VERSION } from "~/branding";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useReleaseHighlights } from "~/state/releaseHighlights";
import { ReleaseHighlightsList } from "../ReleaseHighlightsList";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { resolveWhatsNew, WHATS_NEW_SEEN_STORAGE_KEY } from "./whatsNew.logic";

const SeenVersionSchema = Schema.NullOr(Schema.String);

/** Once per update with highlights: what this app's new version brings since the last one seen. */
export function SidebarWhatsNewNotice() {
  const [seenVersion, setSeenVersion] = useLocalStorage(
    WHATS_NEW_SEEN_STORAGE_KEY,
    null,
    SeenVersionSchema,
  );
  const highlights = useReleaseHighlights(
    seenVersion,
    APP_VERSION,
    seenVersion !== null && seenVersion !== APP_VERSION,
  );
  const action = resolveWhatsNew(seenVersion, APP_VERSION, highlights);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the seen version in localStorage when there is nothing to show
  useEffect(() => {
    if (action === "mark-seen") setSeenVersion(APP_VERSION);
  }, [action, setSeenVersion]);
  if (action !== "show" || highlights === null) return null;
  const dismiss = () => setSeenVersion(APP_VERSION);

  return (
    <div className="flex min-h-7 w-full shrink-0 items-center rounded-lg bg-sidebar-control-surface text-2xs leading-4 font-medium text-sidebar-foreground">
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <MegaphoneIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">What's new in T3 Code</span>
        </PopoverTrigger>
        <PopoverPopup side="top" align="start" padding="compact" width="sm">
          <div className="flex flex-col gap-2">
            <div>
              <div className="font-medium text-sm">What's new</div>
              <div className="text-muted-foreground text-xs">{APP_VERSION}</div>
            </div>
            <ReleaseHighlightsList highlights={highlights} />
            <div className="flex justify-end">
              <Button size="xs" variant="outline" onClick={dismiss}>
                Got it
              </Button>
            </div>
          </div>
        </PopoverPopup>
      </Popover>
      <button
        type="button"
        aria-label="Dismiss what's new"
        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={dismiss}
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
