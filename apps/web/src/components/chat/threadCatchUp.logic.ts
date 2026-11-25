export function laterOf(
  left: string | null | undefined,
  right: string | null | undefined,
): string | null {
  if (!left) return right || null;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

const isBefore = (left: string, right: string) => Date.parse(left) < Date.parse(right);

/** How long a wheel, pointer, touch or key in the timeline counts as looking at an unfocused window. */
export const READER_INTERACTION_MS = 30_000;

/**
 * What the reader of an open thread has read during this visit, on top of the boundary it opened
 * with. Reading moves `readThroughAt`; the New line stays at `lineAt` until another stretch of
 * unread messages begins after what they read, so it does not jump away while they read.
 */
export interface CatchUpMarks {
  readonly readThroughAt: string | null;
  /** Where the current unread stretch began; null once marked read and before anything is unread. */
  readonly lineAt: string | null;
  /**
   * Messages came in while the reader looked away and the list kept following the end, so being at
   * the end no longer means they saw them; set until the reader scrolls or sees the New line.
   */
  readonly missedAtEnd: boolean;
  /** Caught up in the step before, so what lands now is read as it lands, below the line. */
  readonly caughtUp: boolean;
}

export const NO_CATCH_UP_MARKS: CatchUpMarks = {
  readThroughAt: null,
  lineAt: null,
  missedAtEnd: false,
  caughtUp: false,
};

type CatchUpRow = { readonly id: string; readonly kind: string; readonly createdAt: string | null };
type CatchUpEntry = {
  readonly id: string;
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

/** Messages after `after` that the reader did not write, as the sidebar counts them. */
function unreadAfter(entries: ReadonlyArray<CatchUpEntry>, after: string) {
  const afterMs = Date.parse(after);
  let count = 0;
  let first: CatchUpEntry | null = null;
  // Newest last, so the scan stops at the boundary instead of walking the whole history.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (Date.parse(entry.createdAt) <= afterMs) break;
    if (!countsAsUnread(entry)) continue;
    count += 1;
    first = entry;
  }
  return { count, first };
}

const readPointOf = (boundary: string, marks: CatchUpMarks) =>
  laterOf(boundary, marks.readThroughAt) ?? boundary;

/**
 * One step of reading, run on every render of the open thread. The reader is caught up while they
 * look at the end of the list, and then reads up to the newest entry as it lands. Unread messages
 * after what they read start a new stretch, and the New line moves to its start. A null
 * `boundary` is a thread never visited, where nothing counts as unread.
 */
export function nextCatchUpMarks(
  marks: CatchUpMarks,
  input: {
    readonly boundary: string | null;
    readonly entries: ReadonlyArray<CatchUpEntry>;
    readonly looking: boolean;
    readonly atEnd: boolean;
    readonly lineInView: boolean;
  },
): { readonly marks: CatchUpMarks; readonly caughtUp: boolean } {
  if (input.boundary === null) return { marks, caughtUp: false };
  let { readThroughAt, lineAt, missedAtEnd } = marks;
  if (!input.atEnd || input.lineInView) missedAtEnd = false;
  const caughtUp = input.atEnd && input.looking && !missedAtEnd;
  // The line marks where unread messages began before this step reads them.
  const readPoint = readPointOf(input.boundary, marks);
  const unread = unreadAfter(input.entries, readPoint).count > 0;
  const startsStretch = unread && !(marks.caughtUp && caughtUp);
  if (startsStretch && (lineAt === null || isBefore(lineAt, readPoint))) lineAt = readPoint;
  const newestAt = input.entries.at(-1)?.createdAt ?? null;
  if (caughtUp && newestAt !== null && isBefore(readPoint, newestAt)) readThroughAt = newestAt;
  if (unread && !caughtUp && input.atEnd && !input.looking && !input.lineInView) missedAtEnd = true;
  const next =
    readThroughAt === marks.readThroughAt &&
    lineAt === marks.lineAt &&
    missedAtEnd === marks.missedAtEnd &&
    caughtUp === marks.caughtUp
      ? marks
      : { readThroughAt, lineAt, missedAtEnd, caughtUp };
  return { marks: next, caughtUp };
}

/** Marking read by hand reads everything there is and takes the New line away. */
export function markedReadCatchUpMarks(entries: ReadonlyArray<CatchUpEntry>): CatchUpMarks {
  return {
    readThroughAt: entries.at(-1)?.createdAt ?? null,
    lineAt: null,
    missedAtEnd: false,
    caughtUp: false,
  };
}

export interface TimelineCatchUp {
  /**
   * The row the "New" line sits above; null once the reader marked the thread read, and while the
   * line is in history not loaded yet.
   */
  readonly lineRowId: string | null;
  /** Where the line's stretch began. */
  readonly lineAt: string | null;
  /** Unread messages after what the reader read, the same number the sidebar shows. */
  readonly unreadCount: number;
  /** What the reader read up to, where the unread messages begin. */
  readonly unreadSince: string;
  /** Unread messages start before the loaded history, so the line and part of the count are older. */
  readonly beforeLoaded: boolean;
}

/**
 * The row the New line goes above: the first row after `lineAt`, or the row holding the first
 * unread message when that row started earlier, as a folded group of work can.
 */
function lineRowId(
  rows: ReadonlyArray<CatchUpRow>,
  entries: ReadonlyArray<CatchUpEntry>,
  lineAt: string,
): string | null {
  const first = unreadAfter(entries, lineAt).first;
  if (first === null) return null;
  const lineAtMs = Date.parse(lineAt);
  const firstMs = Date.parse(first.createdAt);
  let holding: CatchUpRow | null = null;
  for (const row of rows) {
    if (LIVE_ROW_KINDS.has(row.kind) || row.createdAt === null) continue;
    const rowMs = Date.parse(row.createdAt);
    if (row.id === first.id || rowMs > lineAtMs) return row.id;
    if (rowMs <= firstMs) holding = row;
  }
  return holding?.id ?? null;
}

/**
 * Whether history older than the loaded entries could still hold what came after `at`. With more
 * history to load, the oldest loaded entry has to be at or before `at` for the stretch to start
 * inside what is loaded.
 */
function startsBeforeLoaded(
  entries: ReadonlyArray<CatchUpEntry>,
  hasOlderHistory: boolean,
  at: string,
): boolean {
  if (!hasOlderHistory) return false;
  const oldest = entries[0];
  return oldest === undefined || isBefore(at, oldest.createdAt);
}

export function deriveTimelineCatchUp(
  rows: ReadonlyArray<CatchUpRow>,
  entries: ReadonlyArray<CatchUpEntry>,
  boundary: string | null,
  marks: CatchUpMarks,
  hasOlderHistory = false,
): TimelineCatchUp | null {
  if (boundary === null) return null;
  const unreadSince = readPointOf(boundary, marks);
  const unreadCount = unreadAfter(entries, unreadSince).count;
  const beforeLoaded = startsBeforeLoaded(entries, hasOlderHistory, marks.lineAt ?? unreadSince);
  // Their own message after the line read what is above it, so the line goes with it.
  // A line in unloaded history would land on the oldest loaded row, which is not where it is.
  const lineRow =
    marks.lineAt === null || isBefore(marks.lineAt, boundary) || beforeLoaded
      ? null
      : lineRowId(rows, entries, marks.lineAt);
  return unreadCount === 0 && lineRow === null
    ? null
    : {
        lineRowId: lineRow,
        lineAt: lineRow === null ? null : marks.lineAt,
        unreadCount,
        unreadSince,
        beforeLoaded: beforeLoaded && unreadCount > 0,
      };
}
