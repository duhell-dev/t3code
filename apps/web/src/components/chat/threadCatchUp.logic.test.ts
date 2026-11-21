import { describe, expect, it } from "vite-plus/test";

import {
  CATCH_UP_DWELL_MS,
  deriveTimelineCatchUp,
  nextCaughtUp,
  NOT_CAUGHT_UP,
  type CaughtUpState,
} from "./threadCatchUp.logic";

const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

function walk(steps: ReadonlyArray<{ atEnd: boolean; focused: boolean; nowMs: number }>) {
  let state: CaughtUpState = NOT_CAUGHT_UP;
  for (const step of steps) state = nextCaughtUp(state, step);
  return state.caughtUp;
}

describe("nextCaughtUp", () => {
  it.each([
    {
      name: "staying at the end of a focused thread for the dwell catches up",
      steps: [
        { atEnd: true, focused: true, nowMs: 0 },
        { atEnd: true, focused: true, nowMs: CATCH_UP_DWELL_MS },
      ],
      caughtUp: true,
    },
    {
      name: "scrolling past the end does not",
      steps: [
        { atEnd: true, focused: true, nowMs: 0 },
        { atEnd: false, focused: true, nowMs: 400 },
        { atEnd: true, focused: true, nowMs: 1_000 },
        { atEnd: true, focused: true, nowMs: 1_000 + CATCH_UP_DWELL_MS - 1 },
      ],
      caughtUp: false,
    },
    {
      name: "the end of an unfocused window does not",
      steps: [
        { atEnd: true, focused: false, nowMs: 0 },
        { atEnd: true, focused: false, nowMs: CATCH_UP_DWELL_MS * 4 },
      ],
      caughtUp: false,
    },
    {
      name: "scrolling up ends it at once",
      steps: [
        { atEnd: true, focused: true, nowMs: 0 },
        { atEnd: true, focused: true, nowMs: CATCH_UP_DWELL_MS },
        { atEnd: false, focused: true, nowMs: CATCH_UP_DWELL_MS + 1 },
      ],
      caughtUp: false,
    },
  ])("$name", ({ steps, caughtUp }) => {
    expect(walk(steps)).toBe(caughtUp);
  });

  it("asks to be woken when the dwell ends", () => {
    expect(nextCaughtUp(NOT_CAUGHT_UP, { atEnd: true, focused: true, nowMs: 100 })).toEqual({
      caughtUp: false,
      readySinceMs: 100,
      wakeAtMs: 100 + CATCH_UP_DWELL_MS,
    });
  });
});

describe("deriveTimelineCatchUp", () => {
  const message = (minute: number, role: string, createdBy: string, idleCompaction?: string) => ({
    kind: "message",
    createdAt: at(minute),
    message: { role, createdBy, ...(idleCompaction ? { idleCompaction } : {}) },
  });
  const entries = [
    message(5, "assistant", "agent"),
    message(21, "user", "user"),
    message(22, "assistant", "agent"),
    { kind: "work", createdAt: at(23) },
    message(24, "assistant", "agent"),
    message(25, "user", "agent"),
    message(26, "user", "agent", "beforeCacheExpires"),
  ];
  const rows = [
    { id: "seen", kind: "message", createdAt: at(5) },
    { id: "prompt", kind: "message", createdAt: at(21) },
    { id: "answer", kind: "message", createdAt: at(22) },
    { id: "working", kind: "working", createdAt: at(30) },
  ];

  it("puts the line on the first row after the boundary and counts what others wrote", () => {
    expect(deriveTimelineCatchUp(rows, entries, at(20))).toEqual({
      rowId: "prompt",
      unreadCount: 3,
    });
  });

  it("has nothing once the boundary passes the newest message", () => {
    expect(deriveTimelineCatchUp(rows, entries, at(26))).toBeNull();
  });
});
