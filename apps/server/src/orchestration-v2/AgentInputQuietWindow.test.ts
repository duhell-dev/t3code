import { describe, expect, it } from "@effect/vitest";

import { AGENT_INPUT_MAX_HOLD_MS, agentInputHoldUntil } from "./AgentInputQuietWindow.ts";

describe("agentInputHoldUntil", () => {
  const base = {
    quietMs: 90_000,
    nowMs: 1_000_000,
    firstHeldAtMs: undefined,
    threadIdle: true,
    siblingsRunning: false,
  };
  it.each([
    { name: "a quiet period after the input", input: base, due: 1_090_000 },
    { name: "no window when it is off", input: { ...base, quietMs: 0 }, due: null },
    { name: "no window on a busy thread", input: { ...base, threadIdle: false }, due: null },
    {
      name: "a later input moves it on",
      input: { ...base, firstHeldAtMs: 950_000 },
      due: 1_090_000,
    },
    {
      name: "running siblings wait up to the cap",
      input: { ...base, firstHeldAtMs: 950_000, siblingsRunning: true },
      due: 950_000 + AGENT_INPUT_MAX_HOLD_MS,
    },
    {
      name: "past the cap it starts now",
      input: { ...base, firstHeldAtMs: 1_000_000 - AGENT_INPUT_MAX_HOLD_MS, siblingsRunning: true },
      due: null,
    },
    {
      name: "the cap shortens the last quiet period",
      input: { ...base, firstHeldAtMs: 1_000_000 - AGENT_INPUT_MAX_HOLD_MS + 30_000 },
      due: 1_030_000,
    },
  ])("$name", ({ input, due }) => {
    expect(agentInputHoldUntil(input)).toBe(due);
  });
});
