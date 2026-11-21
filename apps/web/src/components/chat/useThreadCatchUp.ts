import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { resolveCatchUpWindow, type ThreadCatchUpWindow } from "./threadCatchUp.logic";

/**
 * Freezes what the reader missed when a thread opens, before the visit mark moves past it.
 * Marking read ends it; a prompt sent from here does too, since it starts a new stretch.
 */
export function useThreadCatchUp(input: {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly shell: {
    readonly lastVisitedAt?: string | null | undefined;
    readonly latestUserAuthoredMessageAt?: string | null | undefined;
    readonly updatedAt: string;
  } | null;
}) {
  const [state, setState] = useState<{
    readonly key: string | null;
    readonly window: ThreadCatchUpWindow | null;
    readonly barVisible: boolean;
  }>({ key: null, window: null, barVisible: false });
  let current = state;
  if (input.shell !== null && state.key !== input.threadKey) {
    const window = resolveCatchUpWindow(input.shell);
    current = { key: input.threadKey, window, barVisible: window !== null };
    setState(current);
  }
  if (current.key !== input.threadKey || current.window === null) return null;
  const ownPromptAt = input.shell?.latestUserAuthoredMessageAt;
  if (ownPromptAt && Date.parse(ownPromptAt) > Date.parse(current.window.boundary)) return null;
  return {
    environmentId: input.environmentId,
    threadId: input.threadId,
    window: current.window,
    barVisible: current.barVisible,
    onMarkRead: () => setState((previous) => ({ ...previous, window: null, barVisible: false })),
    onJumped: () => setState((previous) => ({ ...previous, barVisible: false })),
  };
}
