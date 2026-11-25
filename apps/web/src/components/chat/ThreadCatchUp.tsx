import { useGT } from "gt-react";
import { ArrowUpIcon, CheckIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * A slim strip above the timeline, in the flow, while unread messages are left: the count and the
 * two actions. It takes its own row, so it never covers "Load earlier turns" or a message.
 */
export function ThreadCatchUpBar(props: {
  readonly unreadCount: number;
  readonly since: string;
  /** Unread messages start in history not loaded yet; the count shows only what is loaded. */
  readonly beforeLoaded: boolean;
  /** The jump is loading earlier history on its way to the New line. */
  readonly jumping: boolean;
  readonly onJump: () => void;
  readonly onStopJump: () => void;
  readonly onMarkRead: () => void;
}) {
  const gt = useGT();
  const summary = props.beforeLoaded
    ? gt(
        "{count, plural, one {More than {count} new message since {time}} other {More than {count} new messages since {time}}}",
        { count: props.unreadCount, time: clockTime(props.since) },
      )
    : gt(
        "{count, plural, one {{count} new message since {time}} other {{count} new messages since {time}}}",
        { count: props.unreadCount, time: clockTime(props.since) },
      );
  return (
    <div
      className="flex shrink-0 justify-center ps-(--chat-lane-inset-start) pe-(--chat-lane-inset-end)"
      data-thread-catch-up-bar="true"
    >
      <div className="chat-content-lane flex items-center justify-center gap-1.5 px-3 py-1">
        <span role="status" className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="sr-only">{summary}</span>
          <span
            aria-hidden="true"
            className="shrink-0 rounded-full bg-destructive px-1.5 font-semibold text-white tabular-nums leading-4"
          >
            {props.beforeLoaded ? `${props.unreadCount}+` : props.unreadCount}
          </span>
          <span aria-hidden="true" className="hidden truncate text-muted-foreground sm:inline">
            {gt("{count, plural, one {new message} other {new messages}}", {
              count: props.unreadCount,
            })}
          </span>
        </span>
        {props.jumping ? (
          <Button size="xs" variant="outline" aria-busy="true" onClick={props.onStopJump}>
            <Spinner size="xs" aria-hidden="true" />
            {gt("Stop loading")}
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={props.onJump}>
            <ArrowUpIcon aria-hidden="true" />
            {gt("Jump to new")}
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={props.onMarkRead}>
          <CheckIcon aria-hidden="true" />
          {gt("Mark as read")}
        </Button>
      </div>
    </div>
  );
}

/** Above the first message the reader has not seen. */
export function ThreadCatchUpLine(props: { readonly since: string }) {
  const gt = useGT();
  return (
    <div
      className="flex items-center gap-2 py-2 text-2xs font-bold text-destructive"
      data-thread-catch-up-line="true"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-destructive" />
      <span className="shrink-0">{gt("New · since {time}", { time: clockTime(props.since) })}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-destructive" />
    </div>
  );
}
