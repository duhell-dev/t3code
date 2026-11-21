import { useState } from "react";

import { laterOf } from "./threadCatchUp.logic";

/**
 * Where unread messages start for the reader: the visit mark as it was when the thread opened,
 * before reading moves it, or their own later message. Null for a thread never visited.
 */
export function useThreadCatchUpBoundary(input: {
  readonly threadKey: string;
  readonly shell: {
    readonly lastVisitedAt?: string | null | undefined;
    readonly latestUserAuthoredMessageAt?: string | null | undefined;
  } | null;
}): string | null {
  const [opened, setOpened] = useState<{ key: string | null; mark: string | null }>({
    key: null,
    mark: null,
  });
  let current = opened;
  if (input.shell !== null && opened.key !== input.threadKey) {
    current = { key: input.threadKey, mark: input.shell.lastVisitedAt ?? null };
    setOpened(current);
  }
  if (current.key !== input.threadKey || current.mark === null) return null;
  return laterOf(current.mark, input.shell?.latestUserAuthoredMessageAt);
}
