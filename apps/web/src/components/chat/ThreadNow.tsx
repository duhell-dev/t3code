import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";
import { cn } from "~/lib/utils";
import { NoticeText } from "./ComposerBannerStack";

/** A line of thread state for the end of the timeline. */
export interface ThreadNowItem {
  readonly id: string;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  /** Shown below the line when its title is expanded; the title then never truncates into a popup. */
  readonly details?: ReactNode;
}

/** Matches ThreadStatusLine, so every line at the end of the timeline reads as one family. */
const lineClassName = cn(
  "mx-auto flex w-full min-w-0 max-w-(--chat-content-max-width) items-center gap-1.5 px-1 pb-2 text-xs text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0",
  // A details button must not make its line taller than the others.
  "[&_[data-slot=popover-trigger]]:-my-1.5",
  // Inline actions keep their text size but get a finger-sized hit area on touch.
  "pointer-coarse:[&_[data-slot=inline-button]]:relative pointer-coarse:[&_[data-slot=inline-button]]:after:absolute pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-x-1.5 pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-y-3.5",
  "transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none",
);

/** One line of thread state at the end of the timeline: icon, title, detail, then actions. */
function ThreadNowLine({
  item,
  announce = false,
}: {
  readonly item: ThreadNowItem;
  /** Announces the line when it appears; only for something that needs the user. */
  readonly announce?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = (
    <>
      {item.title}
      {item.description ? (
        <>
          {" "}
          <span className="ms-0.5 text-muted-foreground/60 light:text-muted-foreground/80">
            {item.description}
          </span>
        </>
      ) : null}
    </>
  );
  return (
    <>
      <div
        role={announce ? "alert" : undefined}
        className={cn(lineClassName, "items-baseline")}
        data-thread-now-line="true"
      >
        <span
          aria-hidden
          className="flex size-3.5 shrink-0 self-center items-center justify-center"
        >
          {item.icon}
        </span>
        {/* Title and detail read as one line that gives way before the actions, so Stop stays
            reachable; when it is cut, its details button or expanded list shows all of it. */}
        {item.details ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            className="flex min-w-0 cursor-pointer items-baseline gap-1 text-start hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="min-w-0 truncate">{text}</span>
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "self-center transition-transform motion-reduce:transition-none",
                expanded && "rotate-90",
              )}
            />
          </button>
        ) : (
          <NoticeText
            detailsLabel={
              typeof item.title === "string" ? `Show details: ${item.title}` : "Show details"
            }
            className="min-w-0 truncate"
          >
            {text}
          </NoticeText>
        )}
        {item.actions ? (
          <span className="ms-1.5 flex shrink-0 items-baseline gap-2.5">{item.actions}</span>
        ) : null}
      </div>
      {item.details && expanded ? (
        <div className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width) px-1 pb-2">
          {item.details}
        </div>
      ) : null}
    </>
  );
}

function ThreadSyncLine({ phase }: { readonly phase: ThreadSyncPhase }) {
  return (
    <div className={lineClassName} role="status" data-composer-sync-status={phase}>
      <RefreshCwIcon aria-hidden />
      <span className="truncate">{threadSyncLabel(phase)}</span>
    </div>
  );
}

/**
 * What the thread is doing now, at the end of the timeline: what needs you, background work,
 * the sync status while messages load, then the goal.
 */
export function ThreadNow({
  attention,
  work,
  syncPhase,
  goal,
}: {
  /** Something that needs you elsewhere, such as a subagent's question. */
  readonly attention: ThreadNowItem | null;
  readonly work: ThreadNowItem | null;
  readonly syncPhase: ThreadSyncPhase | null;
  readonly goal: ThreadNowItem | null;
}): ReactNode {
  return (
    <>
      {attention ? <ThreadNowLine item={attention} announce /> : null}
      {work ? <ThreadNowLine key={work.id} item={work} /> : null}
      {syncPhase ? <ThreadSyncLine phase={syncPhase} /> : null}
      {goal ? <ThreadNowLine item={goal} /> : null}
    </>
  );
}
