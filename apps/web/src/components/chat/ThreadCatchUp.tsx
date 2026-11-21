import { useGT } from "gt-react";

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Over the timeline, in the banners' lane, while unread messages are left. */
export function ThreadCatchUpBar(props: {
  readonly unreadCount: number;
  readonly boundary: string;
  readonly onJump: () => void;
  readonly onMarkRead: () => void;
}) {
  const gt = useGT();
  const summary = gt(
    "{count, plural, one {{count} new message since {time}} other {{count} new messages since {time}}}",
    { count: props.unreadCount, time: clockTime(props.boundary) },
  );
  return (
    <div className="chat-banner-lane pointer-events-none absolute top-0 z-30 flex justify-center px-3 pt-2">
      <div
        role="status"
        className="pointer-events-auto flex max-w-full min-w-0 items-center gap-3 rounded-full bg-info py-1 ps-3 pe-1.5 text-xs font-medium text-white shadow-md"
      >
        <span className="min-w-0 truncate">{summary}</span>
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="cursor-pointer rounded-full px-2 py-0.5 font-semibold hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white"
            onClick={props.onJump}
          >
            {gt("Jump to new")}
          </button>
          <button
            type="button"
            className="cursor-pointer rounded-full px-2 py-0.5 font-semibold hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white"
            onClick={props.onMarkRead}
          >
            {gt("Mark as read")}
          </button>
        </span>
      </div>
    </div>
  );
}

/** Above the first message the reader has not seen. */
export function ThreadCatchUpLine(props: { readonly boundary: string }) {
  const gt = useGT();
  return (
    <div
      className="flex items-center gap-2 py-2 text-2xs font-bold text-destructive"
      data-thread-catch-up-line="true"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-destructive" />
      <span className="shrink-0">
        {gt("New · since {time}", { time: clockTime(props.boundary) })}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-destructive" />
    </div>
  );
}
