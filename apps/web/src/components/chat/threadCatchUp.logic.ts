/** Mirrors the server's ThreadCatchUp threshold, so a box worth having shows its loading state. */
export const CATCH_UP_SUMMARY_MIN_ANSWERS = 3;

export interface ThreadCatchUpWindow {
  /** What came after this is new to the reader. */
  readonly boundary: string;
  /** The thread's last change when it opened: later rows arrived while the reader watched. */
  readonly until: string;
}

/**
 * The window of a thread the reader missed: from the later of their last visit and their
 * own last message, up to the thread's state when they opened it. Null when nothing is new.
 */
export function resolveCatchUpWindow(shell: {
  readonly lastVisitedAt?: string | null | undefined;
  readonly latestUserAuthoredMessageAt?: string | null | undefined;
  readonly updatedAt: string;
}): ThreadCatchUpWindow | null {
  const boundary = laterOf(shell.lastVisitedAt, shell.latestUserAuthoredMessageAt);
  if (boundary === null) return null;
  return Date.parse(shell.updatedAt) > Date.parse(boundary)
    ? { boundary, until: shell.updatedAt }
    : null;
}

function laterOf(left: string | null | undefined, right: string | null | undefined): string | null {
  if (!left) return right || null;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

export interface TimelineCatchUp {
  /** The first row after the boundary, where the "New" line goes. */
  readonly rowId: string;
  /** One per run that answered, like the sidebar's count. */
  readonly answerCount: number;
}

type CatchUpRow = { readonly id: string; readonly kind: string; readonly createdAt: string | null };
type CatchUpEntry =
  | {
      readonly kind: "message";
      readonly createdAt: string;
      readonly message: {
        readonly id: string;
        readonly role: string;
        readonly runId: string | null;
      };
    }
  | { readonly kind: Exclude<string, "message">; readonly createdAt: string };

const LIVE_ROW_KINDS = new Set(["working", "thinking", "worktree-setup"]);

export function deriveTimelineCatchUp(
  rows: ReadonlyArray<CatchUpRow>,
  entries: ReadonlyArray<CatchUpEntry>,
  window: ThreadCatchUpWindow,
): TimelineCatchUp | null {
  const boundaryMs = Date.parse(window.boundary);
  const untilMs = Date.parse(window.until);
  const isMissed = (createdAt: string | null) => {
    if (createdAt === null) return false;
    const at = Date.parse(createdAt);
    return at > boundaryMs && at <= untilMs;
  };
  const answers = new Set<string>();
  // Newest last, so the scan stops at the boundary instead of walking the whole history.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (Date.parse(entry.createdAt) <= boundaryMs) break;
    if (!isMissed(entry.createdAt) || entry.kind !== "message" || !("message" in entry)) continue;
    if (entry.message.role === "assistant") answers.add(entry.message.runId ?? entry.message.id);
  }
  if (answers.size === 0) return null;
  const row = rows.find(
    (candidate) => !LIVE_ROW_KINDS.has(candidate.kind) && isMissed(candidate.createdAt),
  );
  return row === undefined ? null : { rowId: row.id, answerCount: answers.size };
}
