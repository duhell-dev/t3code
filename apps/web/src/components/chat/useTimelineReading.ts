import { useAtomSet } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { getDocumentActivity, subscribeDocumentActivity } from "~/lib/documentActivity";
import { threadReadingAtom, UNREAD_THREAD_READING } from "~/state/threadReading";
import {
  deriveTimelineCatchUp,
  laterOf,
  nextCaughtUp,
  NOT_CAUGHT_UP,
  type CaughtUpState,
} from "./threadCatchUp.logic";

type Rows = Parameters<typeof deriveTimelineCatchUp>[0];
type Entries = Parameters<typeof deriveTimelineCatchUp>[1];

/**
 * What the reader of a thread has not seen yet. They have read a message once they stayed at
 * the end of the focused thread for the dwell, or while they stay there as it arrives; then the
 * visit tracker moves the thread's mark, so the sidebar and other devices agree.
 */
export function useTimelineReading(input: {
  readonly identity: string;
  /** Where unread messages start for this reader, frozen when the thread opened. */
  readonly boundary: string | null;
  /** At the end of the list, after the opening scroll settled. */
  readonly atEnd: boolean;
  readonly rows: Rows;
  readonly entries: Entries;
}) {
  const setReading = useAtomSet(threadReadingAtom(parseScopedThreadKey(input.identity)));
  const focused = useSyncExternalStore(
    subscribeDocumentActivity,
    () => {
      const activity = getDocumentActivity();
      return activity.visible && activity.focused;
    },
    () => true,
  );

  const [caughtUp, setCaughtUp] = useState({ identity: input.identity, caughtUp: false });
  const caughtUpStateRef = useRef<{ identity: string; state: CaughtUpState }>({
    identity: input.identity,
    state: NOT_CAUGHT_UP,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows scroll position and window focus, both outside React, through a dwell timer
  useEffect(() => {
    if (caughtUpStateRef.current.identity !== input.identity) {
      caughtUpStateRef.current = { identity: input.identity, state: NOT_CAUGHT_UP };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      const next = nextCaughtUp(caughtUpStateRef.current.state, {
        atEnd: input.atEnd,
        focused,
        nowMs: Date.now(),
      });
      caughtUpStateRef.current = { identity: input.identity, state: next };
      setCaughtUp((current) =>
        current.identity === input.identity && current.caughtUp === next.caughtUp
          ? current
          : { identity: input.identity, caughtUp: next.caughtUp },
      );
      if (next.wakeAtMs !== null) timer = setTimeout(step, next.wakeAtMs - Date.now());
    };
    step();
    return () => clearTimeout(timer);
  }, [input.identity, input.atEnd, focused]);
  const isCaughtUp = caughtUp.identity === input.identity && caughtUp.caughtUp;

  // Messages that arrive while the reader is caught up are read as they land.
  const newestAt = input.entries.at(-1)?.createdAt ?? null;
  const [readThrough, setReadThrough] = useState<{ identity: string; at: string | null }>({
    identity: input.identity,
    at: null,
  });
  let readThroughAt = readThrough.identity === input.identity ? readThrough.at : null;
  if (isCaughtUp && newestAt !== null && laterOf(readThroughAt, newestAt) !== readThroughAt) {
    readThroughAt = newestAt;
    setReadThrough({ identity: input.identity, at: newestAt });
  }
  const boundary = input.boundary === null ? null : laterOf(input.boundary, readThroughAt);
  const catchUp =
    boundary === null ? null : deriveTimelineCatchUp(input.rows, input.entries, boundary);
  const unreadCount = catchUp?.unreadCount ?? 0;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shares the open thread's reading with the visit tracker and the sidebar, which live outside this tree
  useEffect(() => {
    setReading((current) => ({ ...current, caughtUp: isCaughtUp, unreadCount }));
  }, [setReading, isCaughtUp, unreadCount]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a thread left behind must not count as caught up when it opens again
  useEffect(
    () => () =>
      setReading((current) => ({
        ...UNREAD_THREAD_READING,
        markedRead: current.markedRead,
      })),
    [setReading],
  );

  const markRead = () => {
    setReadThrough({ identity: input.identity, at: newestAt });
    setReading((current) => ({ ...current, markedRead: current.markedRead + 1, unreadCount: 0 }));
  };
  return { catchUp, caughtUp: isCaughtUp, markRead };
}
