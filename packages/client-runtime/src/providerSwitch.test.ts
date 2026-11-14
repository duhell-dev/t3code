import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  foldProviderSwitchItems,
  providerFailureSummary,
  providerSwitchDetail,
  providerSwitchLabel,
} from "./providerSwitch.ts";

const item = (fields: Record<string, unknown>) => ({
  item: { status: "completed", title: null, ...fields } as unknown as OrchestrationV2TurnItem,
});
const notice = (runId: string, signal: string) =>
  item({
    id: `turn-item:run:${runId}:signal:${signal}`,
    runId,
    type: "system_notice",
    message: "Back on Main plan",
  });
const handoff = (id: string, runId: string, title: string) =>
  item({ id, runId, type: "handoff", title });
const creditFailure: OrchestrationV2ProviderFailure = {
  class: "provider_error",
  message: "Credit balance is too low",
  code: "billing_error",
  retryable: false,
};
const ids = (rows: ReadonlyArray<{ readonly item: OrchestrationV2TurnItem }>) =>
  rows.map(({ item }) => item.id);

describe("foldProviderSwitchItems", () => {
  it("folds a return's handoff rows into its notice", () => {
    const rows = [
      item({ id: "answer", runId: "r1", type: "assistant_message" }),
      notice("r1", "provider-failover-return"),
      handoff("recovered", "r2", "Recovered context"),
      handoff("switch", "r2", "Provider handoff"),
      item({ id: "next", runId: "r2", type: "user_message", messageId: "m2" }),
    ];
    const folded = foldProviderSwitchItems(rows);
    expect(ids(folded)).toEqual([
      "answer",
      "turn-item:run:r1:signal:provider-failover-return",
      "next",
    ]);
    expect(providerSwitchDetail(folded[1]!.item)).toMatchObject({
      signal: "provider-failover-return",
      failure: null,
      continuation: null,
    });
    expect(providerSwitchDetail(folded[1]!.item)?.handoffs.map(({ id }) => id)).toEqual([
      "recovered",
      "switch",
    ]);
  });

  it("folds a switch's failure and continuation, and leaves later runs alone", () => {
    const rows = [
      item({ id: "error", runId: "r1", type: "error", status: "failed", failure: creditFailure }),
      notice("r1", "provider-failover"),
      handoff("switch", "r2", "Provider handoff"),
      item({
        id: "continue",
        runId: "r2",
        type: "user_message",
        messageId: "failover-continue:t:r1",
        text: "The previous provider instance stopped working.",
      }),
      item({ id: "work", runId: "r2", type: "assistant_message" }),
      handoff("later", "r3", "Provider handoff"),
    ];
    const folded = foldProviderSwitchItems(rows);
    expect(ids(folded)).toEqual(["turn-item:run:r1:signal:provider-failover", "work", "later"]);
    expect(providerSwitchDetail(folded[0]!.item)).toMatchObject({
      failure: creditFailure,
      continuation: "The previous provider instance stopped working.",
    });
  });

  it("drops a recovery handoff beside a switch handoff without any failover", () => {
    const rows = [
      handoff("recovered", "r2", "Recovered context"),
      handoff("switch", "r2", "Provider handoff"),
      handoff("alone", "r3", "Recovered context"),
    ];
    expect(ids(foldProviderSwitchItems(rows))).toEqual(["switch", "alone"]);
    const untouched = [handoff("switch", "r2", "Provider handoff")];
    expect(foldProviderSwitchItems(untouched)).toBe(untouched);
  });
});

describe("providerSwitchLabel", () => {
  const names: Record<string, string> = { claudeAgent: "Main plan", claudeBackup: "Backup plan" };
  const displayName = (id: ProviderInstanceId) => names[id] ?? id;

  it("rewrites the older prose notices with display names", () => {
    expect(
      providerSwitchLabel(
        "Switched back from claudeBackup to claudeAgent because claudeAgent is usable again. The next run starts there.",
        displayName,
      ),
    ).toBe("Back on Main plan");
    expect(
      providerSwitchLabel(
        "Switched from claudeAgent to claudeBackup because claudeAgent failed: its usage limit is reached. Continuing there.",
        displayName,
      ),
    ).toBe("Switched to Backup plan: usage limit reached on Main plan");
    expect(providerSwitchLabel("Back on Main plan", displayName)).toBe("Back on Main plan");
  });
});

describe("providerFailureSummary", () => {
  const failure = (
    fields: Partial<OrchestrationV2ProviderFailure>,
  ): OrchestrationV2ProviderFailure => ({
    class: "provider_error",
    message: "Something failed",
    code: null,
    retryable: null,
    ...fields,
  });

  it.each([
    [failure({ code: "billing_error", message: "Credit balance is too low" }), "Out of API credit"],
    [failure({ message: "API Error: 400 Credit balance is too low" }), "Out of API credit"],
    [
      failure({
        class: "usage_limit",
        code: "api_spend_limit",
        message: "You have reached your specified API usage limits.",
      }),
      "API spend limit reached",
    ],
    [failure({ class: "usage_limit", message: "5-hour limit reached" }), "Usage limit reached"],
    [
      failure({ code: "authentication_failed", message: "Not logged in" }),
      "Signed out of the provider",
    ],
    [
      failure({
        message: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
      }),
      "Signed out of the provider",
    ],
    [failure({ message: "API Error: 529 Overloaded" }), "The provider is overloaded"],
    [failure({}), null],
  ])("%#", (input, summary) => {
    expect(providerFailureSummary(input)).toBe(summary);
  });
});
