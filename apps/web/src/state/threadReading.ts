import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ThreadReading } from "@t3tools/client-runtime/state/thread-visits";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

/** The open thread's reading state: the timeline writes it, the visit tracker and sidebar read it. */
export interface WebThreadReading extends ThreadReading {
  /** Messages after the reader's boundary, the same number the timeline's bar shows. */
  readonly unreadCount: number;
}

export const UNREAD_THREAD_READING: WebThreadReading = {
  caughtUp: false,
  markedRead: 0,
  unreadCount: 0,
};

const threadReadingFamily = Atom.family((key: string) =>
  Atom.make<WebThreadReading>(UNREAD_THREAD_READING).pipe(
    Atom.keepAlive,
    Atom.withLabel(`thread-reading:${key}`),
  ),
);

const NO_THREAD_READING = Atom.make<WebThreadReading>(UNREAD_THREAD_READING).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-reading:none"),
);

export const threadReadingAtom = (ref: ScopedThreadRef | null) =>
  ref === null ? NO_THREAD_READING : threadReadingFamily(scopedThreadKey(ref));
