import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineCatchUp, resolveCatchUpWindow } from "./threadCatchUp.logic";

const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

describe("resolveCatchUpWindow", () => {
  it.each([
    {
      name: "starts at the visit when it is later",
      shell: { lastVisitedAt: at(20), latestUserAuthoredMessageAt: at(10), updatedAt: at(40) },
      window: { boundary: at(20), until: at(40) },
    },
    {
      name: "starts at the reader's own prompt when it is later",
      shell: { lastVisitedAt: at(10), latestUserAuthoredMessageAt: at(20), updatedAt: at(40) },
      window: { boundary: at(20), until: at(40) },
    },
    {
      name: "nothing after the boundary",
      shell: { lastVisitedAt: at(40), latestUserAuthoredMessageAt: at(10), updatedAt: at(40) },
      window: null,
    },
    {
      name: "no visit and no prompt",
      shell: { lastVisitedAt: null, latestUserAuthoredMessageAt: null, updatedAt: at(40) },
      window: null,
    },
  ])("$name", ({ shell, window }) => {
    expect(resolveCatchUpWindow(shell)).toEqual(window);
  });
});

describe("deriveTimelineCatchUp", () => {
  const message = (id: string, minute: number, role: string, runId: string | null) => ({
    kind: "message" as const,
    createdAt: at(minute),
    message: { id, role, runId },
  });
  const entries = [
    message("seen", 5, "assistant", "run-0"),
    message("a1", 21, "assistant", "run-1"),
    { kind: "work", createdAt: at(22) },
    message("a2", 23, "assistant", "run-1"),
    message("wake", 30, "user", null),
    message("a3", 31, "assistant", "run-2"),
    // Arrived while the reader was already looking.
    message("live", 45, "assistant", "run-3"),
  ];
  const rows = [
    { id: "seen", kind: "message", createdAt: at(5) },
    { id: "work-1", kind: "work", createdAt: at(21) },
    { id: "a3", kind: "message", createdAt: at(31) },
    { id: "working", kind: "working", createdAt: at(46) },
  ];

  it("puts the line on the first missed row and counts each run's answer once", () => {
    expect(deriveTimelineCatchUp(rows, entries, { boundary: at(20), until: at(40) })).toEqual({
      rowId: "work-1",
      answerCount: 2,
    });
  });

  it("has nothing when only the reader's live view added answers", () => {
    expect(deriveTimelineCatchUp(rows, entries, { boundary: at(40), until: at(44) })).toBeNull();
  });
});
