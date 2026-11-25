import { describe, expect, it } from "vite-plus/test";

import {
  type CatchUpMarks,
  deriveTimelineCatchUp,
  markedReadCatchUpMarks,
  nextCatchUpMarks,
  NO_CATCH_UP_MARKS,
} from "./threadCatchUp.logic";

const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

const message = (
  minute: number,
  role = "assistant",
  createdBy = "agent",
  idleCompaction?: string,
) => ({
  id: `m-${minute}`,
  kind: "message",
  createdAt: at(minute),
  message: { role, createdBy, ...(idleCompaction ? { idleCompaction } : {}) },
});
const rowOf = (entry: { id: string; createdAt: string }) => ({
  id: entry.id,
  kind: "message",
  createdAt: entry.createdAt,
});

interface View {
  readonly entries: ReadonlyArray<ReturnType<typeof message>>;
  readonly boundary?: string | null;
  readonly atEnd?: boolean;
  readonly looking?: boolean;
  readonly lineInView?: boolean;
}

/** Renders the open thread once per view, the way the timeline does. */
function read(views: ReadonlyArray<View>, start: CatchUpMarks = NO_CATCH_UP_MARKS) {
  let marks = start;
  let shown: ReturnType<typeof deriveTimelineCatchUp> = null;
  for (const view of views) {
    const boundary = view.boundary === undefined ? at(10) : view.boundary;
    marks = nextCatchUpMarks(marks, {
      boundary,
      entries: view.entries,
      atEnd: view.atEnd ?? false,
      looking: view.looking ?? true,
      lineInView: view.lineInView ?? false,
    }).marks;
    shown = deriveTimelineCatchUp(view.entries.map(rowOf), view.entries, boundary, marks);
  }
  return { marks, line: shown?.lineRowId ?? null, unread: shown?.unreadCount ?? 0 };
}

const seen = [message(5)];
const missed = [...seen, message(12), message(13)];

describe("reading a thread", () => {
  it.each([
    {
      name: "opens with what came after the boundary unread, and the line above it",
      views: [{ entries: missed }],
      line: "m-12",
      unread: 2,
    },
    {
      name: "reaching the end reads it at once, and the line stays where it was",
      views: [{ entries: missed }, { entries: missed, atEnd: true }],
      line: "m-12",
      unread: 0,
    },
    {
      name: "the end of a window nobody looks at reads nothing",
      views: [{ entries: missed, atEnd: true, looking: false }],
      line: "m-12",
      unread: 2,
    },
    {
      name: "arrivals while the reader stays at the end are read as they land, below the line",
      views: [
        { entries: missed, atEnd: true },
        { entries: [...missed, message(14), message(15)], atEnd: true },
      ],
      line: "m-12",
      unread: 0,
    },
    {
      name: "arrivals after reading, scrolled up, start a new stretch and the line moves there",
      views: [
        { entries: missed, atEnd: true },
        { entries: missed },
        { entries: [...missed, message(14), message(15)] },
      ],
      line: "m-14",
      unread: 2,
    },
    {
      name: "arrivals before the first stretch is read stay in it",
      views: [{ entries: missed }, { entries: [...missed, message(14)] }],
      line: "m-12",
      unread: 3,
    },
    {
      name: "their own message reads what came before it and takes the line away",
      views: [
        { entries: missed },
        { entries: [...missed, message(14, "user", "user")], boundary: at(14), atEnd: true },
      ],
      line: null,
      unread: 0,
    },
    {
      name: "an answer to their own message, scrolled up, gets its own line",
      views: [
        { entries: missed },
        {
          entries: [...missed, message(14, "user", "user"), message(15)],
          boundary: at(14),
        },
      ],
      line: "m-15",
      unread: 1,
    },
    {
      name: "a thread never visited has nothing unread",
      views: [{ entries: missed, boundary: null, atEnd: true }],
      line: null,
      unread: 0,
    },
    {
      name: "their own messages, helper wakes and compaction prompts are not counted",
      views: [
        {
          entries: [
            ...seen,
            message(11, "user", "user"),
            message(12),
            message(13, "user", "agent"),
            message(14, "user", "agent", "beforeCacheExpires"),
          ],
        },
      ],
      line: "m-11",
      unread: 2,
    },
  ])("$name", ({ views, line, unread }) => {
    expect(read(views)).toMatchObject({ line, unread });
  });

  it("marking read takes the line away until something new comes in", () => {
    const marked = markedReadCatchUpMarks(missed);
    expect(read([{ entries: missed }], marked)).toMatchObject({ line: null, unread: 0 });
    expect(
      read(
        [
          { entries: missed, atEnd: true },
          { entries: [...missed, message(14)], atEnd: true },
        ],
        marked,
      ),
    ).toMatchObject({ line: null, unread: 0 });
    expect(read([{ entries: [...missed, message(14)] }], marked)).toMatchObject({
      line: "m-14",
      unread: 1,
    });
  });

  describe("coming back to a window that kept following the end", () => {
    const away = [
      { entries: missed, atEnd: true },
      { entries: missed, atEnd: true, looking: false },
      { entries: [...missed, message(14), message(15)], atEnd: true, looking: false },
    ];

    it("keeps what came in unread while the new line is off screen", () => {
      expect(
        read([...away, { entries: [...missed, message(14), message(15)], atEnd: true }]),
      ).toMatchObject({ line: "m-14", unread: 2 });
    });

    it("reads it once the line is on screen", () => {
      expect(
        read([
          ...away,
          { entries: [...missed, message(14), message(15)], atEnd: true, lineInView: true },
        ]),
      ).toMatchObject({ line: "m-14", unread: 0 });
    });

    it("reads it once the reader scrolls up and back to the end", () => {
      const entries = [...missed, message(14), message(15)];
      expect(read([...away, { entries }, { entries, atEnd: true }])).toMatchObject({
        line: "m-14",
        unread: 0,
      });
    });

    it("reads at once what fits on screen below its new line", () => {
      expect(
        read([
          { entries: missed, atEnd: true },
          { entries: [...missed, message(14)], atEnd: true, looking: false, lineInView: true },
          { entries: [...missed, message(14)], atEnd: true, lineInView: true },
        ]),
      ).toMatchObject({ line: "m-14", unread: 0 });
    });
  });
});

describe("deriveTimelineCatchUp", () => {
  it("puts the line above the row holding the first unread message when that row began earlier", () => {
    const entries = [message(5), message(12), message(13)];
    const rows = [
      { id: "seen", kind: "message", createdAt: at(5) },
      // A folded turn starts before the boundary and holds both answers.
      { id: "fold", kind: "turn-fold", createdAt: at(8) },
      { id: "working", kind: "working", createdAt: at(30) },
    ];
    const marks = nextCatchUpMarks(NO_CATCH_UP_MARKS, {
      boundary: at(10),
      entries,
      atEnd: false,
      looking: true,
      lineInView: false,
    }).marks;
    expect(deriveTimelineCatchUp(rows, entries, at(10), marks)).toMatchObject({
      lineRowId: "fold",
      unreadCount: 2,
    });
  });

  it("puts the line above work that came in before the first unread message", () => {
    const entries = [message(5), { id: "w", kind: "work", createdAt: at(11) }, message(12)];
    const rows = [
      { id: "m-5", kind: "message", createdAt: at(5) },
      { id: "w", kind: "work", createdAt: at(11) },
      { id: "m-12", kind: "message", createdAt: at(12) },
    ];
    const marks = nextCatchUpMarks(NO_CATCH_UP_MARKS, {
      boundary: at(10),
      entries,
      atEnd: false,
      looking: true,
      lineInView: false,
    }).marks;
    expect(deriveTimelineCatchUp(rows, entries, at(10), marks)).toMatchObject({
      lineRowId: "w",
      unreadCount: 1,
    });
  });
});

describe("a New line in history not loaded yet", () => {
  const marksFor = (entries: ReadonlyArray<ReturnType<typeof message>>) =>
    nextCatchUpMarks(NO_CATCH_UP_MARKS, {
      boundary: at(10),
      entries,
      atEnd: false,
      looking: true,
      lineInView: false,
    }).marks;

  it("draws no line on the oldest loaded row while earlier history could still hold it", () => {
    // Loaded from minute 20 on; the unread stretch began at 10, in the pages above.
    const entries = [message(20), message(21), message(22)];
    expect(
      deriveTimelineCatchUp(entries.map(rowOf), entries, at(10), marksFor(entries), true),
    ).toMatchObject({ lineRowId: null, lineAt: null, unreadCount: 3, beforeLoaded: true });
  });

  it("draws the line once the page holding its start is loaded", () => {
    const entries = [message(5), message(12), message(20)];
    expect(
      deriveTimelineCatchUp(entries.map(rowOf), entries, at(10), marksFor(entries), true),
    ).toMatchObject({ lineRowId: "m-12", unreadCount: 2, beforeLoaded: false });
  });

  it("draws the line on the first row of a thread whose whole history is loaded", () => {
    const entries = [message(20), message(21)];
    expect(
      deriveTimelineCatchUp(entries.map(rowOf), entries, at(10), marksFor(entries), false),
    ).toMatchObject({ lineRowId: "m-20", beforeLoaded: false });
  });
});
