import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { Skeleton } from "../ui/skeleton";
import { CATCH_UP_SUMMARY_MIN_ANSWERS, type ThreadCatchUpWindow } from "./threadCatchUp.logic";

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Over the timeline while the reader has not reached what is new. */
export function ThreadCatchUpBar(props: {
  readonly answerCount: number;
  readonly boundary: string;
  readonly onJump: () => void;
  readonly onMarkRead: () => void;
}) {
  const gt = useGT();
  return (
    <div
      role="status"
      className="absolute inset-x-0 top-0 z-30 flex items-center gap-3 bg-info px-4 py-1.5 text-xs font-semibold text-white shadow-sm"
    >
      <span className="min-w-0 truncate">
        {gt(
          "{count, plural, one {{count} new answer since you last looked ({time})} other {{count} new answers since you last looked ({time})}}",
          { count: props.answerCount, time: clockTime(props.boundary) },
        )}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        className="shrink-0 cursor-pointer font-medium underline underline-offset-2"
        onClick={props.onJump}
      >
        {gt("Jump to new")}
      </button>
      <button
        type="button"
        className="shrink-0 cursor-pointer font-medium underline underline-offset-2"
        onClick={props.onMarkRead}
      >
        {gt("Mark as read")}
      </button>
    </div>
  );
}

/** The "New" line above the first missed row, and the summary when catching up takes reading. */
export function ThreadCatchUpMarker(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly window: ThreadCatchUpWindow;
  readonly answerCount: number;
}) {
  const gt = useGT();
  return (
    <div className="pb-1">
      <div
        className="flex items-center gap-2 py-2 text-2xs font-bold text-destructive"
        data-thread-catch-up-line="true"
      >
        <span aria-hidden="true" className="h-px flex-1 bg-destructive" />
        <span>{gt("New · since {time}", { time: clockTime(props.window.boundary) })}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-destructive" />
      </div>
      <ThreadCatchUpSummaryBox {...props} />
    </div>
  );
}

function ThreadCatchUpSummaryBox(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly window: ThreadCatchUpWindow;
  readonly answerCount: number;
}) {
  const gt = useGT();
  const [collapsed, setCollapsed] = useState(false);
  const result = useEnvironmentQuery(
    orchestrationEnvironment.threadCatchUp({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, since: props.window.boundary },
    }),
  );
  const summary = result.data?.summary ?? null;
  const expectSummary = props.answerCount >= CATCH_UP_SUMMARY_MIN_ANSWERS;
  // A short stretch gets a box only once the server finds it long enough to summarize.
  if (summary === null && !(expectSummary && (result.isPending || result.error !== null))) {
    return null;
  }
  const ToggleIcon = collapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <section
      aria-label={gt("Since your last visit")}
      className="rounded-md border border-s-2 border-border border-s-warning bg-secondary/60 px-3 py-2 text-sm"
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-1.5 text-start font-semibold"
      >
        <ToggleIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span>{gt("Since your last visit")}</span>
        <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">
          {summary === null
            ? gt("{count, plural, one {· {count} answer} other {· {count} answers}}", {
                count: props.answerCount,
              })
            : gt(
                "{count, plural, one {· {count} answer · summarized by {model}} other {· {count} answers · summarized by {model}}}",
                { count: summary.messageCount, model: summary.model },
              )}
        </span>
      </button>
      {collapsed ? null : summary !== null ? (
        <div className="mt-1.5 ps-5">
          {summary.todo.length > 0 ? (
            <>
              <p className="font-semibold text-warning">
                {gt("For you to do: {count}", { count: summary.todo.length })}
              </p>
              <ul className="mt-0.5 mb-1.5 list-disc space-y-0.5 ps-4">
                {summary.todo.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : null}
          <ul className="list-disc space-y-0.5 ps-4">
            {summary.points.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : result.error !== null ? (
        <p className={cn("mt-1.5 ps-5 text-xs text-muted-foreground")}>
          {gt("No summary this time: {error}", { error: result.error })}
        </p>
      ) : (
        <div className="mt-2 space-y-1.5 ps-5" aria-label={gt("Summarizing…")}>
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      )}
    </section>
  );
}
