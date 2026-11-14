/**
 * duHell fork: one timeline row per provider switch. A failover writes a notice on the failed
 * run, the next run carries upstream's context handoff rows, and a forward switch also sends a
 * continuation message for the model. The notice becomes the row; the rest folds into it.
 */
import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
} from "@t3tools/contracts";

const FAILOVER_SIGNALS = [
  "provider-failover",
  "provider-failover-stop",
  "provider-failover-resume",
  "provider-failover-return",
] as const;
export type FailoverSignal = (typeof FAILOVER_SIGNALS)[number];

const CONTINUATION_MESSAGE_PREFIX = "failover-continue:";
// ProviderTurnStartService titles the handoff of a native resume that fell back.
const RECOVERED_CONTEXT_TITLE = "Recovered context";

type HandoffItem = Extract<OrchestrationV2TurnItem, { type: "handoff" }>;

export interface ProviderSwitchDetail {
  readonly signal: FailoverSignal;
  /** The account failure that caused the switch; its error row is folded away. */
  readonly failure: OrchestrationV2ProviderFailure | null;
  /** The handoff rows of the run that started on the new account. */
  readonly handoffs: ReadonlyArray<HandoffItem>;
  /** The text the model got after the switch. */
  readonly continuation: string | null;
}

/** The failover step a turn item records, from the worker's per-run signal item id. */
export function failoverNoticeSignal(item: OrchestrationV2TurnItem): FailoverSignal | null {
  if (item.type !== "system_notice") return null;
  return FAILOVER_SIGNALS.find((signal) => item.id.endsWith(`:signal:${signal}`)) ?? null;
}

const details = new WeakMap<OrchestrationV2TurnItem, ProviderSwitchDetail>();

/** What foldProviderSwitchItems folded into this notice, or undefined for any other item. */
export function providerSwitchDetail(
  item: OrchestrationV2TurnItem,
): ProviderSwitchDetail | undefined {
  return details.get(item);
}

/**
 * Folds each failover step's error, continuation and handoff rows into its notice, and drops a
 * recovery handoff that sits beside a switch handoff of the same run. Returns `rows` itself when
 * there is nothing to fold.
 */
export function foldProviderSwitchItems<Row extends { readonly item: OrchestrationV2TurnItem }>(
  rows: ReadonlyArray<Row>,
): ReadonlyArray<Row> {
  const hidden = new Set<OrchestrationV2TurnItem>();
  // A native resume that falls back adds a "Recovered context" handoff from the run's own
  // instance ahead of the switch's handoff; beside that one it only repeats the target.
  const switchHandoffRuns = new Set(
    rows.flatMap(({ item }) =>
      item.type === "handoff" && item.runId !== null && item.title !== RECOVERED_CONTEXT_TITLE
        ? [item.runId]
        : [],
    ),
  );
  for (const { item } of rows) {
    if (
      item.type === "handoff" &&
      item.title === RECOVERED_CONTEXT_TITLE &&
      item.runId !== null &&
      switchHandoffRuns.has(item.runId)
    ) {
      hidden.add(item);
    }
  }
  const notices = new Map<OrchestrationV2TurnItem, Row>();
  rows.forEach(({ item }, index) => {
    const signal = failoverNoticeSignal(item);
    if (signal === null || item.runId === null) return;
    let failure: OrchestrationV2ProviderFailure | null = null;
    if (signal === "provider-failover") {
      for (const { item: candidate } of rows) {
        if (
          candidate.runId === item.runId &&
          candidate.type === "error" &&
          candidate.status === "failed"
        ) {
          failure = candidate.failure;
          hidden.add(candidate);
        }
      }
    }
    const nextRunId = rows
      .slice(index + 1)
      .find((row) => row.item.runId !== null && row.item.runId !== item.runId)?.item.runId;
    const handoffs: Array<HandoffItem> = [];
    let continuation: string | null = null;
    for (const { item: candidate } of nextRunId === undefined ? [] : rows.slice(index + 1)) {
      if (candidate.runId !== nextRunId) continue;
      if (candidate.type === "handoff") {
        handoffs.push(candidate);
        hidden.add(candidate);
      }
      if (
        candidate.type === "user_message" &&
        candidate.messageId.startsWith(CONTINUATION_MESSAGE_PREFIX)
      ) {
        continuation = candidate.text;
        hidden.add(candidate);
      }
    }
    // A fresh item per fold, so a row that renders the notice sees the handoffs that came later.
    const notice = { ...item };
    details.set(notice, { signal, failure, handoffs, continuation });
    notices.set(item, { ...rows[index]!, item: notice });
  });
  if (hidden.size === 0 && notices.size === 0) return rows;
  return rows.flatMap((row) => (hidden.has(row.item) ? [] : [notices.get(row.item) ?? row]));
}

const LEGACY_CAUSES: ReadonlyArray<readonly [RegExp, string]> = [
  [/usage limit/, "usage limit reached"],
  [/not logged in/, "signed out"],
  [/API credit/, "out of API credit"],
  [/spend limit/, "API spend limit reached"],
];
const legacyCause = (text: string) =>
  LEGACY_CAUSES.find(([pattern]) => pattern.test(text))?.[1] ?? text;

/**
 * The notice line with display names. Servers before the short lines wrote prose with instance
 * ids; those read like the new lines too.
 */
export function providerSwitchLabel(
  message: string,
  displayName: (instanceId: ProviderInstanceId) => string,
): string {
  const name = (id: string | undefined) => displayName((id ?? "") as ProviderInstanceId);
  let match = /^Switched from (\S+) to (\S+) because \S+ failed: (.+?)\. Continuing there\.$/.exec(
    message,
  );
  if (match) return `Switched to ${name(match[2])}: ${legacyCause(match[3]!)} on ${name(match[1])}`;
  match = /^Switched back from \S+ to (\S+) because /.exec(message);
  if (match) return `Back on ${name(match[1])}`;
  match = /^Resumed on (\S+): it is usable again/.exec(message);
  if (match) return `Back on ${name(match[1])}: usable again`;
  match = /^Provider failover stopped: (\S+) failed because (.+?), and no other /.exec(message);
  if (match) {
    return `Failover stopped: ${legacyCause(match[2]!)} on ${name(match[1])}, and no other account is usable`;
  }
  return message;
}

const FAILURE_SUMMARIES: ReadonlyArray<
  readonly [(failure: OrchestrationV2ProviderFailure) => boolean, string]
> = [
  [
    (failure) =>
      failure.code === "api_spend_limit" ||
      /reached your specified API usage limits/i.test(failure.message),
    "API spend limit reached",
  ],
  [(failure) => failure.class === "usage_limit", "Usage limit reached"],
  [
    (failure) =>
      failure.code === "billing_error" || /credit balance is too low/i.test(failure.message),
    "Out of API credit",
  ],
  [
    (failure) =>
      failure.code === "authentication_failed" ||
      /not logged in|please run \/login|invalid api key|authentication_error|oauth token has expired|\b401\b/i.test(
        failure.message,
      ),
    "Signed out of the provider",
  ],
  [(failure) => /overloaded|\b529\b/i.test(failure.message), "The provider is overloaded"],
  [(failure) => /rate.?limit|\b429\b/i.test(failure.message), "Rate limited by the provider"],
  [(failure) => failure.class === "transport_error", "Lost the connection to the provider"],
];

/** A short reading of a provider failure, or null when its own title says enough. */
export function providerFailureSummary(failure: OrchestrationV2ProviderFailure): string | null {
  return FAILURE_SUMMARIES.find(([matches]) => matches(failure))?.[1] ?? null;
}
