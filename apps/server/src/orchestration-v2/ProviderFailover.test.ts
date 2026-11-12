import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderFailure,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  exhaustedUntilMs,
  exhaustionFromRun,
  FAILOVER_AUTH_BACKOFF_MS,
  FAILOVER_LIMIT_BACKOFF_MS,
  failoverCause,
  failoverContinuationMessageId,
  normalizeFailoverChain,
  providerFailoverDecision,
  usageExhaustedUntilMs,
  type FailoverInput,
  type FailoverRun,
} from "./ProviderFailover.ts";

const threadId = ThreadId.make("thread-1");
const chain = ["claudeAgent", "claudeNepo", "claudeGuthaben", "claudeGuthabenNepo"];
const nowMs = Date.parse("2026-11-12T22:00:00.000Z");
const at = (minutesBeforeNow: number) => DateTime.makeUnsafe(nowMs - minutesBeforeNow * 60_000);

const limit: OrchestrationV2ProviderFailure = {
  class: "usage_limit",
  message: "You've hit your weekly limit · resets Nov 14, 2am (Europe/Berlin)",
  code: "api_error_429",
  retryable: true,
  resetAt: "2026-11-14T01:00:00.000Z",
};
const signedOut: OrchestrationV2ProviderFailure = {
  class: "provider_error",
  message: "Claude could not authenticate.",
  code: "authentication_failed",
  retryable: null,
};
const noCredit: OrchestrationV2ProviderFailure = {
  class: "provider_error",
  message: "Credit balance is too low",
  code: "billing_error",
  retryable: null,
};
const spendCap: OrchestrationV2ProviderFailure = {
  class: "usage_limit",
  message:
    "API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.",
  code: "api_spend_limit",
  retryable: false,
  resetAt: "2026-12-01T00:00:00.000Z",
};
const otherError: OrchestrationV2ProviderFailure = {
  class: "provider_error",
  message: "Claude API is overloaded (529). Try again shortly.",
  code: "api_error_529",
  retryable: true,
};

function run(
  ordinal: number,
  instance: string,
  status: FailoverRun["status"],
  options: { failure?: OrchestrationV2ProviderFailure; continues?: number } = {},
): FailoverRun {
  return {
    id: RunId.make(`run-${ordinal}`),
    ordinal,
    status,
    providerInstanceId: ProviderInstanceId.make(instance),
    userMessageId: MessageId.make(
      options.continues === undefined
        ? `message-${ordinal}`
        : failoverContinuationMessageId(threadId, RunId.make(`run-${options.continues}`)),
    ),
    startedAt: at(100 - ordinal),
    completedAt: status === "running" || status === "queued" ? null : at(99 - ordinal),
    failure: options.failure ?? null,
  };
}

const allUsable = new Map(chain.map((id) => [id, { usable: true }]));

function input(overrides: Partial<FailoverInput>): FailoverInput {
  return {
    chain,
    threadId,
    threadInstanceId: ProviderInstanceId.make("claudeAgent"),
    runs: [],
    blocked: false,
    noticedRunIds: new Set(),
    health: allUsable,
    exhaustedUntil: new Map(),
    usageExhaustedUntil: new Map(),
    nowMs,
    ...overrides,
  };
}

describe("failoverCause", () => {
  it("classifies the four account failures and nothing else", () => {
    assert.equal(failoverCause(limit), "usage_limit");
    assert.equal(failoverCause(spendCap), "spend_limit");
    assert.equal(failoverCause(signedOut), "authentication");
    assert.equal(failoverCause(noCredit), "billing");
    assert.equal(failoverCause(otherError), null);
    assert.equal(failoverCause(null), null);
  });
});

describe("exhaustedUntilMs", () => {
  it("uses the limit's reset time, else a fixed back-off", () => {
    assert.equal(exhaustedUntilMs("usage_limit", limit, nowMs), Date.parse(limit.resetAt!));
    assert.equal(
      exhaustedUntilMs("usage_limit", { resetAt: null }, nowMs),
      nowMs + FAILOVER_LIMIT_BACKOFF_MS,
    );
    assert.equal(exhaustedUntilMs("spend_limit", spendCap, nowMs), Date.parse(spendCap.resetAt!));
    assert.equal(
      exhaustedUntilMs("authentication", { resetAt: null }, nowMs),
      nowMs + FAILOVER_AUTH_BACKOFF_MS,
    );
  });

  it("is recorded only for failed runs with an account failure", () => {
    assert.deepStrictEqual(
      exhaustionFromRun(run(1, "claudeNepo", "failed", { failure: noCredit })),
      {
        instanceId: "claudeNepo",
        untilMs: DateTime.toEpochMillis(at(98)) + FAILOVER_AUTH_BACKOFF_MS,
      },
    );
    assert.equal(exhaustionFromRun(run(1, "claudeNepo", "failed", { failure: otherError })), null);
    assert.equal(exhaustionFromRun(run(1, "claudeNepo", "completed")), null);
  });
});

const weeklyReset = "2026-11-14T01:00:00.000Z";
function claudeUsage(
  windows: ServerProviderUsageLimits["windows"],
  unavailable?: ServerProviderUsageLimits["unavailable"],
): Pick<ServerProvider, "driver" | "usageLimits"> {
  return {
    driver: "claudeAgent" as ServerProvider["driver"],
    usageLimits: {
      checkedAt: "2026-11-12T21:59:00.000Z",
      windows,
      ...(unavailable === undefined ? {} : { unavailable }),
    },
  };
}
const fullWeekly = {
  id: "seven_day",
  kind: "weekly" as const,
  label: "Weekly",
  usedPercent: 100,
  resetsAt: weeklyReset,
};

describe("usageExhaustedUntilMs", () => {
  it("blocks a full window until its reset, else for the limit back-off", () => {
    assert.equal(
      usageExhaustedUntilMs(claudeUsage([fullWeekly]), nowMs, "claude-opus-5-5"),
      Date.parse(weeklyReset),
    );
    const { resetsAt: _, ...noReset } = fullWeekly;
    assert.equal(
      usageExhaustedUntilMs(claudeUsage([noReset]), nowMs),
      nowMs + FAILOVER_LIMIT_BACKOFF_MS,
    );
  });

  it("does not block a full window whose reset has passed, or one below 100 %", () => {
    const past = { ...fullWeekly, resetsAt: "2026-11-12T21:00:00.000Z" };
    assert.equal(usageExhaustedUntilMs(claudeUsage([past]), nowMs), null);
    assert.equal(
      usageExhaustedUntilMs(claudeUsage([{ ...fullWeekly, usedPercent: 99 }]), nowMs),
      null,
    );
  });

  it("does not block on unreadable limits, even with a retained full window", () => {
    assert.equal(usageExhaustedUntilMs(undefined, nowMs), null);
    assert.equal(
      usageExhaustedUntilMs(claudeUsage([fullWeekly], { reason: "probeFailed" }), nowMs),
      null,
    );
    assert.equal(usageExhaustedUntilMs(claudeUsage([], { reason: "unsupported" }), nowMs), null);
  });

  it("lets a model-scoped Claude window block only its own model family", () => {
    const fable = { ...fullWeekly, id: "seven_day_fable", label: "Weekly · Fable" };
    assert.equal(usageExhaustedUntilMs(claudeUsage([fable]), nowMs, "claude-opus-5-5"), null);
    assert.equal(
      usageExhaustedUntilMs(claudeUsage([fable]), nowMs, "claude-fable-5-2"),
      Date.parse(weeklyReset),
    );
  });
});

describe("normalizeFailoverChain", () => {
  it("keeps strings once, in order", () => {
    assert.deepStrictEqual(normalizeFailoverChain(["a", " b ", 3, "a", "", null, "c"]), [
      "a",
      "b",
      "c",
    ]);
  });
});

describe("providerFailoverDecision", () => {
  it("does nothing without a chain of two", () => {
    const runs = [run(1, "claudeAgent", "failed", { failure: limit })];
    assert.equal(providerFailoverDecision(input({ runs, chain: [] })), null);
    assert.equal(providerFailoverDecision(input({ runs, chain: ["claudeAgent"] })), null);
  });

  it("moves to the next chain instance for each of the four causes", () => {
    for (const failure of [limit, spendCap, signedOut, noCredit]) {
      const decision = providerFailoverDecision(
        input({ runs: [run(1, "claudeAgent", "failed", { failure })] }),
      );
      assert.deepStrictEqual(decision, {
        type: "switch",
        failedRunId: RunId.make("run-1"),
        from: "claudeAgent",
        to: "claudeNepo",
        cause: failoverCause(failure)!,
      });
    }
  });

  it("prefers the cheapest usable instance in chain order", () => {
    const decision = providerFailoverDecision(
      input({
        threadInstanceId: ProviderInstanceId.make("claudeGuthaben"),
        runs: [run(1, "claudeGuthaben", "failed", { failure: noCredit })],
      }),
    );
    assert.equal(decision?.type === "switch" ? decision.to : null, "claudeAgent");
  });

  it("skips exhausted instances, and uses them again once the time has passed", () => {
    const runs = [run(1, "claudeAgent", "failed", { failure: limit })];
    const exhausted = providerFailoverDecision(
      input({ runs, exhaustedUntil: new Map([["claudeNepo", nowMs + 1]]) }),
    );
    assert.equal(exhausted?.type === "switch" ? exhausted.to : null, "claudeGuthaben");
    const expired = providerFailoverDecision(
      input({ runs, exhaustedUntil: new Map([["claudeNepo", nowMs]]) }),
    );
    assert.equal(expired?.type === "switch" ? expired.to : null, "claudeNepo");
  });

  it("skips an instance whose usage shows a full window, until that window resets", () => {
    const runs = [run(1, "claudeAgent", "failed", { failure: limit })];
    const full = providerFailoverDecision(
      input({ runs, usageExhaustedUntil: new Map([["claudeNepo", Date.parse(weeklyReset)]]) }),
    );
    assert.equal(full?.type === "switch" ? full.to : null, "claudeGuthaben");
    const reset = providerFailoverDecision(
      input({ runs, usageExhaustedUntil: new Map([["claudeNepo", nowMs]]) }),
    );
    assert.equal(reset?.type === "switch" ? reset.to : null, "claudeNepo");
  });

  it("skips unauthenticated, disabled and unknown instances", () => {
    const decision = providerFailoverDecision(
      input({
        runs: [run(1, "claudeAgent", "failed", { failure: signedOut })],
        health: new Map([
          ["claudeAgent", { usable: true }],
          ["claudeNepo", { usable: false }],
          ["claudeGuthabenNepo", { usable: true }],
        ]),
      }),
    );
    assert.equal(decision?.type === "switch" ? decision.to : null, "claudeGuthabenNepo");
  });

  it("moves one step per failed run and never back to a streak instance its failure still blocks", () => {
    const runs = [
      run(1, "claudeAgent", "failed", { failure: limit }),
      run(2, "claudeNepo", "failed", { failure: limit, continues: 1 }),
    ];
    const decision = providerFailoverDecision(
      input({ runs, threadInstanceId: ProviderInstanceId.make("claudeNepo") }),
    );
    assert.deepStrictEqual(decision, {
      type: "switch",
      failedRunId: RunId.make("run-2"),
      from: "claudeNepo",
      to: "claudeGuthaben",
      cause: "usage_limit",
    });
  });

  it("stops once every chain instance failed in the streak", () => {
    const runs = [
      run(1, "claudeAgent", "failed", { failure: limit }),
      run(2, "claudeNepo", "failed", { failure: limit, continues: 1 }),
      run(3, "claudeGuthaben", "failed", { failure: spendCap, continues: 2 }),
      run(4, "claudeGuthabenNepo", "failed", { failure: spendCap, continues: 3 }),
    ];
    const state = input({
      runs,
      threadInstanceId: ProviderInstanceId.make("claudeGuthabenNepo"),
    });
    assert.deepStrictEqual(providerFailoverDecision(state), {
      type: "stop",
      failedRunId: RunId.make("run-4"),
      from: "claudeGuthabenNepo",
      cause: "spend_limit",
      tried: chain,
    });
    // After a switch notice nothing more happens; after a stop it waits for a usable instance.
    assert.equal(providerFailoverDecision({ ...state, noticedRunIds: new Set(["run-4"]) }), null);
    const stopped = {
      ...state,
      noticedRunIds: new Set(["run-4"]),
      stoppedRunIds: new Set(["run-4"]),
    };
    assert.equal(providerFailoverDecision(stopped), null);
    assert.deepStrictEqual(
      providerFailoverDecision({ ...stopped, nowMs: Date.parse(weeklyReset) }),
      {
        type: "resume",
        failedRunId: RunId.make("run-4"),
        from: "claudeGuthabenNepo",
        to: "claudeAgent",
        cause: "spend_limit",
      },
    );
  });

  it("starts over at the front once a streak instance's failure stopped blocking it", () => {
    const runs = [
      run(1, "claudeAgent", "failed", { failure: limit }),
      run(2, "claudeNepo", "failed", { failure: limit, continues: 1 }),
      run(3, "claudeGuthaben", "failed", { failure: noCredit, continues: 2 }),
      run(4, "claudeGuthabenNepo", "failed", { failure: spendCap, continues: 3 }),
    ];
    // Run 3's credit back-off (30 min) has passed; the weekly limits have not reset.
    const decision = providerFailoverDecision(
      input({ runs, threadInstanceId: ProviderInstanceId.make("claudeGuthabenNepo") }),
    );
    assert.equal(decision?.type === "switch" ? decision.to : null, "claudeGuthaben");
  });

  it("starts a fresh walk after a message from the user", () => {
    const runs = [
      run(1, "claudeAgent", "failed", { failure: limit }),
      run(2, "claudeNepo", "failed", { failure: limit, continues: 1 }),
      run(3, "claudeNepo", "failed", { failure: limit }),
    ];
    const decision = providerFailoverDecision(
      input({ runs, threadInstanceId: ProviderInstanceId.make("claudeNepo") }),
    );
    assert.equal(decision?.type === "switch" ? decision.to : null, "claudeAgent");
  });

  it("never acts on an interrupted, active or unrelated run", () => {
    assert.equal(
      providerFailoverDecision(input({ runs: [run(1, "claudeAgent", "interrupted")] })),
      null,
    );
    assert.equal(
      providerFailoverDecision(
        input({
          runs: [
            run(1, "claudeAgent", "failed", { failure: limit }),
            run(2, "claudeAgent", "running"),
          ],
        }),
      ),
      null,
    );
    assert.equal(
      providerFailoverDecision(
        input({ runs: [run(1, "claudeAgent", "failed", { failure: otherError })] }),
      ),
      null,
    );
  });

  it("leaves blocked threads, foreign instances and threads already moved alone", () => {
    const runs = [run(1, "claudeAgent", "failed", { failure: limit })];
    assert.equal(providerFailoverDecision(input({ runs, blocked: true })), null);
    assert.equal(
      providerFailoverDecision(
        input({
          runs: [run(1, "codex", "failed", { failure: limit })],
          threadInstanceId: ProviderInstanceId.make("codex"),
        }),
      ),
      null,
    );
    assert.equal(
      providerFailoverDecision(
        input({ runs, threadInstanceId: ProviderInstanceId.make("claudeNepo") }),
      ),
      null,
    );
  });

  describe("going back", () => {
    const moved = [
      run(1, "claudeAgent", "failed", { failure: limit }),
      run(2, "claudeNepo", "failed", { failure: signedOut, continues: 1 }),
      run(3, "claudeGuthaben", "completed", { continues: 2 }),
    ];
    const movedState = input({
      runs: moved,
      threadInstanceId: ProviderInstanceId.make("claudeGuthaben"),
      exhaustedUntil: new Map([
        ["claudeAgent", nowMs + 60_000],
        ["claudeNepo", nowMs + 60_000],
      ]),
    });

    it("stays while the earlier instances are exhausted", () => {
      assert.equal(providerFailoverDecision(movedState), null);
    });

    it("returns to the first earlier instance that works again, between runs", () => {
      const decision = providerFailoverDecision({
        ...movedState,
        exhaustedUntil: new Map([["claudeNepo", nowMs + 60_000]]),
      });
      assert.deepStrictEqual(decision, {
        type: "return",
        lastRunId: RunId.make("run-3"),
        from: "claudeGuthaben",
        to: "claudeAgent",
      });
    });

    it("never goes back to an instance whose usage shows a full window", () => {
      const free = { ...movedState, exhaustedUntil: new Map() };
      const decision = providerFailoverDecision({
        ...free,
        usageExhaustedUntil: new Map([["claudeAgent", Date.parse(weeklyReset)]]),
      });
      assert.equal(decision?.type === "return" ? decision.to : null, "claudeNepo");
      assert.equal(
        providerFailoverDecision({
          ...free,
          usageExhaustedUntil: new Map([
            ["claudeAgent", Date.parse(weeklyReset)],
            ["claudeNepo", nowMs + 60_000],
          ]),
        }),
        null,
      );
    });

    it("never goes back mid-run or after a manual switch", () => {
      const free = { ...movedState, exhaustedUntil: new Map<string, number>() };
      assert.equal(
        providerFailoverDecision({
          ...free,
          runs: [...moved, run(4, "claudeGuthaben", "running")],
        }),
        null,
      );
      assert.equal(
        providerFailoverDecision({
          ...free,
          threadInstanceId: ProviderInstanceId.make("claudeGuthabenNepo"),
        }),
        null,
      );
      assert.equal(
        providerFailoverDecision({
          ...free,
          runs: [...moved, run(4, "claudeGuthabenNepo", "completed")],
        }),
        null,
      );
    });

    it("returns to the first usable instance of the whole chain, before where the thread started", () => {
      const startedOnNepo = [
        run(1, "claudeNepo", "failed", { failure: limit }),
        run(2, "claudeGuthaben", "completed", { continues: 1 }),
      ];
      const decision = providerFailoverDecision(
        input({
          runs: startedOnNepo,
          threadInstanceId: ProviderInstanceId.make("claudeGuthaben"),
        }),
      );
      assert.equal(decision?.type === "return" ? decision.to : null, "claudeAgent");
    });
  });
});
