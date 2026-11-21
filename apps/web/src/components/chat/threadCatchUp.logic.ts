/** How long the reader stays at the end, with the window focused, before the thread counts as read. */
export const CATCH_UP_DWELL_MS = 1_500;

export function laterOf(
  left: string | null | undefined,
  right: string | null | undefined,
): string | null {
  if (!left) return right || null;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

export interface CaughtUpState {
  readonly caughtUp: boolean;
  /** Since when the reader has been at the end with the window focused, while not yet caught up. */
  readonly readySinceMs: number | null;
}

export const NOT_CAUGHT_UP: CaughtUpState = { caughtUp: false, readySinceMs: null };

/**
 * The reader catches up by staying at the end of a focused thread for the dwell, so scrolling
 * past the end reads nothing. Leaving the end or the window ends it at once.
 */
export function nextCaughtUp(
  state: CaughtUpState,
  input: { readonly atEnd: boolean; readonly focused: boolean; readonly nowMs: number },
): CaughtUpState & { readonly wakeAtMs: number | null } {
  if (!input.atEnd || !input.focused) return { ...NOT_CAUGHT_UP, wakeAtMs: null };
  if (state.caughtUp) return { ...state, wakeAtMs: null };
  const readySinceMs = state.readySinceMs ?? input.nowMs;
  return input.nowMs - readySinceMs >= CATCH_UP_DWELL_MS
    ? { caughtUp: true, readySinceMs: null, wakeAtMs: null }
    : { caughtUp: false, readySinceMs, wakeAtMs: readySinceMs + CATCH_UP_DWELL_MS };
}

export interface TimelineCatchUp {
  /** The first row after the boundary, where the "New" line goes. */
  readonly rowId: string;
  /** Messages the reader did not write, as the sidebar counts them. */
  readonly unreadCount: number;
}

type CatchUpRow = { readonly id: string; readonly kind: string; readonly createdAt: string | null };
type CatchUpEntry = {
  readonly kind: string;
  readonly createdAt: string;
  readonly message?: {
    readonly role: string;
    readonly createdBy?: string | undefined;
    readonly idleCompaction?: unknown;
  };
};

const LIVE_ROW_KINDS = new Set(["working", "thinking", "worktree-setup"]);

function countsAsUnread(entry: CatchUpEntry): boolean {
  const message = entry.kind === "message" ? entry.message : undefined;
  if (message === undefined) return false;
  if (message.role === "assistant") return true;
  return (
    message.role === "user" && message.createdBy !== "user" && message.idleCompaction === undefined
  );
}

export function deriveTimelineCatchUp(
  rows: ReadonlyArray<CatchUpRow>,
  entries: ReadonlyArray<CatchUpEntry>,
  boundary: string,
): TimelineCatchUp | null {
  const boundaryMs = Date.parse(boundary);
  let unreadCount = 0;
  // Newest last, so the scan stops at the boundary instead of walking the whole history.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (Date.parse(entry.createdAt) <= boundaryMs) break;
    if (countsAsUnread(entry)) unreadCount += 1;
  }
  if (unreadCount === 0) return null;
  const row = rows.find(
    (candidate) =>
      !LIVE_ROW_KINDS.has(candidate.kind) &&
      candidate.createdAt !== null &&
      Date.parse(candidate.createdAt) > boundaryMs,
  );
  return row === undefined ? null : { rowId: row.id, unreadCount };
}
