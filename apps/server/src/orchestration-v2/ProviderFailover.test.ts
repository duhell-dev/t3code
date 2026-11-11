import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderFailure,
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
    nowMs,
    ...overrides,
  };
}

describe("failoverCause", () => {
  it("classifies the three account failures and nothing else", () => {
    assert.equal(failoverCause(limit), "usage_limit");
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

  it("moves to the next chain instance for each of the three causes", () => {
    for (const failure of [limit, signedOut, noCredit]) {
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

  it("moves one step per failed run and never back to an instance of the same streak", () => {
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
      run(3, "claudeGuthaben", "failed", { failure: noCredit, continues: 2 }),
      run(4, "claudeGuthabenNepo", "failed", { failure: noCredit, continues: 3 }),
    ];
    const state = input({
      runs,
      threadInstanceId: ProviderInstanceId.make("claudeGuthabenNepo"),
    });
    assert.deepStrictEqual(providerFailoverDecision(state), {
      type: "stop",
      failedRunId: RunId.make("run-4"),
      from: "claudeGuthabenNepo",
      cause: "billing",
      tried: chain,
    });
    // The stop notice is written once; after it the thread stays failed.
    assert.equal(providerFailoverDecision({ ...state, noticedRunIds: new Set(["run-4"]) }), null);
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

    it("never goes further back than where the thread started", () => {
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
      assert.equal(decision?.type === "return" ? decision.to : null, "claudeNepo");
    });
  });
});
