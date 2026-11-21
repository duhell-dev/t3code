import { useAtomSet } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { getDocumentActivity, subscribeDocumentActivity } from "~/lib/documentActivity";
import { threadReadingAtom, UNREAD_THREAD_READING } from "~/state/threadReading";
import {
  deriveTimelineCatchUp,
  markedReadCatchUpMarks,
  nextCatchUpMarks,
  NO_CATCH_UP_MARKS,
  READER_INTERACTION_MS,
  type CatchUpMarks,
} from "./threadCatchUp.logic";

type Rows = Parameters<typeof deriveTimelineCatchUp>[0];
type Entries = Parameters<typeof deriveTimelineCatchUp>[1];

/**
 * What the reader of a thread has not seen yet. Looking at the end of the list reads everything
 * there is, at once and as it lands; the visit tracker then moves the thread's mark, so the
 * sidebar and other devices agree.
 */
export function useTimelineReading(input: {
  readonly identity: string;
  /** Where unread messages start for this reader, frozen when the thread opened. */
  readonly boundary: string | null;
  /** At the end of the list, after the opening scroll settled. */
  readonly atEnd: boolean;
  /** The New line is on screen, so whatever came after it is too. */
  readonly lineInView: boolean;
  readonly rows: Rows;
  readonly entries: Entries;
}) {
  const setReading = useAtomSet(threadReadingAtom(parseScopedThreadKey(input.identity)));
  const activity = useSyncExternalStore(
    subscribeDocumentActivity,
    getDocumentActivity,
    getDocumentActivity,
  );
  const [recentlyUsed, setRecentlyUsed] = useState(false);
  const usedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the interaction timer, which lives outside React
  useEffect(() => () => clearTimeout(usedTimerRef.current), []);
  const noteInteraction = () => {
    clearTimeout(usedTimerRef.current);
    usedTimerRef.current = setTimeout(() => setRecentlyUsed(false), READER_INTERACTION_MS);
    setRecentlyUsed(true);
  };
  const looking = activity.visible && (activity.focused || recentlyUsed);

  const [stored, setStored] = useState<{ identity: string; marks: CatchUpMarks }>({
    identity: input.identity,
    marks: NO_CATCH_UP_MARKS,
  });
  const current = stored.identity === input.identity ? stored.marks : NO_CATCH_UP_MARKS;
  const step = nextCatchUpMarks(current, {
    boundary: input.boundary,
    entries: input.entries,
    looking,
    atEnd: input.atEnd,
    lineInView: input.lineInView,
  });
  if (stored.identity !== input.identity || step.marks !== stored.marks) {
    setStored({ identity: input.identity, marks: step.marks });
  }
  const catchUp = deriveTimelineCatchUp(input.rows, input.entries, input.boundary, step.marks);
  const caughtUp = step.caughtUp;
  const unreadCount = catchUp?.unreadCount ?? 0;

  // Before paint, so the sidebar's count drops in the frame the bar goes.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shares the open thread's reading with the visit tracker and the sidebar, which live outside this tree
  useLayoutEffect(() => {
    setReading((reading) =>
      reading.caughtUp === caughtUp && reading.unreadCount === unreadCount
        ? reading
        : { ...reading, caughtUp, unreadCount },
    );
  }, [setReading, caughtUp, unreadCount]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a thread left behind must not count as caught up when it opens again
  useEffect(
    () => () =>
      setReading((reading) => ({
        ...UNREAD_THREAD_READING,
        markedRead: reading.markedRead,
      })),
    [setReading],
  );

  const markRead = () => {
    setStored({ identity: input.identity, marks: markedReadCatchUpMarks(input.entries) });
    setReading((reading) => ({ ...reading, markedRead: reading.markedRead + 1, unreadCount: 0 }));
  };
  return { catchUp, caughtUp, markRead, noteInteraction };
}
