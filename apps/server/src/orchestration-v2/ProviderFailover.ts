/**
 * Provider failover (duHell fork): when a run fails because its provider account is unusable
 * (usage limit, signed out, API credit used up), move the thread to the next usable provider
 * instance of the configured chain and continue there. Pure decisions only; the worker in
 * ProviderFailoverWorker.ts reads the state and carries them out.
 */
import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";

/** Failure code the Claude adapter sets when the CLI reports authentication_failed ("Not logged in"). */
export const PROVIDER_FAILURE_CODE_AUTHENTICATION = "authentication_failed";
/** Failure code the Claude adapter sets when the CLI reports billing_error ("Credit balance is too low"). */
export const PROVIDER_FAILURE_CODE_BILLING = "billing_error";

/** How long an instance counts as exhausted when the failure carries no reset time. */
export const FAILOVER_AUTH_BACKOFF_MS = 30 * 60 * 1000;
export const FAILOVER_BILLING_BACKOFF_MS = 30 * 60 * 1000;
export const FAILOVER_LIMIT_BACKOFF_MS = 5 * 60 * 60 * 1000;

const CONTINUATION_MESSAGE_PREFIX = "failover-continue:";
/** The continuation after a switch. It names the switch: the handoff carries the old failure. */
export function failoverContinuationText(from: string, to: string, cause: FailoverCause): string {
  return `The previous provider instance ${from} stopped working because ${failoverCauseText(cause)}. This thread now runs on ${to}, which works. That failure is not part of your task; ignore it. Continue where you left off.`;
}

export type FailoverCause = "usage_limit" | "authentication" | "billing";

export function failoverCause(
  failure: Pick<OrchestrationV2ProviderFailure, "class" | "code"> | null,
): FailoverCause | null {
  if (failure === null) return null;
  if (failure.class === "usage_limit") return "usage_limit";
  if (failure.code === PROVIDER_FAILURE_CODE_AUTHENTICATION) return "authentication";
  if (failure.code === PROVIDER_FAILURE_CODE_BILLING) return "billing";
  return null;
}

export function failoverCauseText(cause: FailoverCause): string {
  switch (cause) {
    case "usage_limit":
      return "its usage limit is reached";
    case "authentication":
      return "it is not logged in";
    case "billing":
      return "its API credit is used up";
  }
}

/** The message id of the continuation sent after a failover from `failedRunId`; it links the hops. */
export function failoverContinuationMessageId(threadId: ThreadId, failedRunId: RunId): string {
  return `${CONTINUATION_MESSAGE_PREFIX}${threadId}:${failedRunId}`;
}

/** The failed run a failover continuation continues, or null for any other message. */
export function failoverContinuedRunId(threadId: ThreadId, userMessageId: string): string | null {
  const prefix = `${CONTINUATION_MESSAGE_PREFIX}${threadId}:`;
  return userMessageId.startsWith(prefix) ? userMessageId.slice(prefix.length) : null;
}

/** Until when a failure makes its instance unusable, in epoch ms. */
export function exhaustedUntilMs(
  cause: FailoverCause,
  failure: Pick<OrchestrationV2ProviderFailure, "resetAt">,
  failedAtMs: number,
): number {
  if (cause === "usage_limit") {
    const resetMs = failure.resetAt == null ? Number.NaN : Date.parse(failure.resetAt);
    return Number.isFinite(resetMs) && resetMs > failedAtMs
      ? resetMs
      : failedAtMs + FAILOVER_LIMIT_BACKOFF_MS;
  }
  return (
    failedAtMs + (cause === "billing" ? FAILOVER_BILLING_BACKOFF_MS : FAILOVER_AUTH_BACKOFF_MS)
  );
}

/** Claude's model-scoped weekly windows ("Weekly · Fable") have ids like `seven_day_fable`. */
const CLAUDE_SCOPED_WINDOW = /^seven_day_(.+)$/;

/**
 * Until when the instance's own usage reading makes it unusable, in epoch ms, or null. A window at
 * 100 % that has not reset blocks it until its reset time (no reset time: the limit back-off).
 * Unreadable limits (unsupported, probe failed) say nothing, so the instance stays a candidate.
 * A Claude window scoped to one model family blocks only threads on that family.
 */
export function usageExhaustedUntilMs(
  provider: Pick<ServerProvider, "driver" | "usageLimits"> | undefined,
  nowMs: number,
  model?: string,
): number | null {
  const limits = provider?.usageLimits;
  if (limits === undefined || limits.unavailable !== undefined) return null;
  const windows =
    provider!.driver === "claudeAgent"
      ? limits.windows.filter((window) => {
          const scope = window.id.match(CLAUDE_SCOPED_WINDOW)?.[1];
          if (scope === undefined || model === undefined) return true;
          // The family is the scope's first word ("opus_4" -> opus), so a new version still counts.
          return model.toLowerCase().includes(scope.split("_")[0]!);
        })
      : limits.windows;
  const window = exhaustedUsageWindow(
    { ...provider, usageLimits: { ...limits, windows } } as ServerProvider,
    nowMs,
    model,
  );
  if (window === undefined) return null;
  const resetMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  return Number.isFinite(resetMs) && resetMs > nowMs ? resetMs : nowMs + FAILOVER_LIMIT_BACKOFF_MS;
}

/** Parses the chain setting: known strings only, each once, in order. */
export function normalizeFailoverChain(chain: ReadonlyArray<unknown>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const result: Array<string> = [];
  for (const entry of chain) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export type FailoverRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "status" | "providerInstanceId" | "userMessageId" | "startedAt" | "completedAt"
> & {
  /** The run's latest root failure (latestRootProviderFailure). */
  readonly failure: OrchestrationV2ProviderFailure | null;
};

export interface InstanceHealth {
  /** Enabled, installed and not reporting itself signed out. */
  readonly usable: boolean;
}

export interface FailoverInput {
  readonly chain: ReadonlyArray<string>;
  readonly threadId: ThreadId;
  readonly threadInstanceId: ProviderInstanceId;
  readonly runs: ReadonlyArray<FailoverRun>;
  /** Archived, settled, a pending request or a native subagent thread: never touch it. */
  readonly blocked: boolean;
  /** Run ids that already carry a failover notice (switch or stop). */
  readonly noticedRunIds: ReadonlySet<string>;
  readonly health: ReadonlyMap<string, InstanceHealth>;
  /** Instance id -> epoch ms until which it is exhausted, from its failed runs. */
  readonly exhaustedUntil: ReadonlyMap<string, number>;
  /** Instance id -> epoch ms until which its usage reading shows a full window (usageExhaustedUntilMs). */
  readonly usageExhaustedUntil: ReadonlyMap<string, number>;
  readonly nowMs: number;
}

export type FailoverDecision =
  | {
      readonly type: "switch";
      readonly failedRunId: RunId;
      readonly from: string;
      readonly to: string;
      readonly cause: FailoverCause;
    }
  | {
      readonly type: "stop";
      readonly failedRunId: RunId;
      readonly from: string;
      readonly cause: FailoverCause;
      readonly tried: ReadonlyArray<string>;
    }
  | {
      readonly type: "return";
      readonly lastRunId: RunId;
      readonly from: string;
      readonly to: string;
    };

export function isInstanceUsable(
  instanceId: string,
  input: Pick<FailoverInput, "health" | "exhaustedUntil" | "usageExhaustedUntil" | "nowMs">,
): boolean {
  if (input.health.get(instanceId)?.usable !== true) return false;
  for (const until of [
    input.exhaustedUntil.get(instanceId),
    input.usageExhaustedUntil.get(instanceId),
  ]) {
    if (until !== undefined && until > input.nowMs) return false;
  }
  return true;
}

function latestExecuted(runs: ReadonlyArray<FailoverRun>): FailoverRun | null {
  let latest: FailoverRun | null = null;
  for (const run of runs) {
    if (run.status === "queued") continue;
    if (run.status === "cancelled" && run.startedAt === null) continue;
    if (latest === null || runRanAfter(run, latest)) latest = run;
  }
  return latest;
}

/** The runs of one failover streak, newest first: `run` and every failed run it continued. */
function failoverStreak(
  threadId: ThreadId,
  run: FailoverRun,
  byId: ReadonlyMap<string, FailoverRun>,
): ReadonlyArray<FailoverRun> {
  const streak: Array<FailoverRun> = [run];
  const seen = new Set<string>([run.id]);
  let current = run;
  for (;;) {
    const previousId = failoverContinuedRunId(threadId, current.userMessageId);
    if (previousId === null || seen.has(previousId)) break;
    const previous = byId.get(previousId);
    if (previous === undefined) break;
    seen.add(previousId);
    streak.push(previous);
    current = previous;
  }
  return streak;
}

export function providerFailoverDecision(input: FailoverInput): FailoverDecision | null {
  const chain = normalizeFailoverChain(input.chain);
  if (chain.length < 2 || input.blocked) return null;
  // Never mid-run: a run that still owns the thread's provider turn, or one waiting to start.
  if (
    input.runs.some(
      (run) =>
        run.status === "queued" ||
        run.status === "preparing" ||
        run.status === "starting" ||
        run.status === "running" ||
        run.status === "waiting",
    )
  )
    return null;
  const latest = latestExecuted(input.runs);
  if (latest === null) return null;
  const byId = new Map(input.runs.map((run) => [run.id as string, run]));

  if (latest.status === "failed") {
    // An interrupted run has status "interrupted" and never reaches this branch.
    const cause = failoverCause(latest.failure);
    if (cause === null || input.noticedRunIds.has(latest.id)) return null;
    // Someone already moved the thread after the failure; leave it alone.
    if (latest.providerInstanceId !== input.threadInstanceId) return null;
    if (!chain.includes(latest.providerInstanceId)) return null;
    const tried = new Set(
      failoverStreak(input.threadId, latest, byId).map((run) => run.providerInstanceId as string),
    );
    const next = chain.find((id) => !tried.has(id) && isInstanceUsable(id, input));
    if (next === undefined) {
      return {
        type: "stop",
        failedRunId: latest.id,
        from: latest.providerInstanceId,
        cause,
        tried: chain.filter((id) => tried.has(id)),
      };
    }
    return {
      type: "switch",
      failedRunId: latest.id,
      from: latest.providerInstanceId,
      to: next,
      cause,
    };
  }

  // Going back happens only between runs, so the next run starts on the cheaper instance.
  let lastHop: FailoverRun | null = null;
  for (const run of input.runs) {
    if (failoverContinuedRunId(input.threadId, run.userMessageId) === null) continue;
    if (lastHop === null || run.ordinal > lastHop.ordinal) lastHop = run;
  }
  if (lastHop === null || input.noticedRunIds.has(latest.id)) return null;
  // The thread must still sit where the failover put it (no manual switch since).
  if (lastHop.providerInstanceId !== input.threadInstanceId) return null;
  if (
    input.runs.some(
      (run) =>
        run.ordinal > lastHop.ordinal &&
        run.status !== "queued" &&
        run.providerInstanceId !== lastHop.providerInstanceId,
    )
  )
    return null;
  const streak = failoverStreak(input.threadId, lastHop, byId);
  const origin = streak[streak.length - 1]!.providerInstanceId as string;
  const originIndex = chain.indexOf(origin);
  const currentIndex = chain.indexOf(input.threadInstanceId);
  if (originIndex < 0 || currentIndex < 0 || originIndex >= currentIndex) return null;
  const target = chain.slice(originIndex, currentIndex).find((id) => isInstanceUsable(id, input));
  if (target === undefined) return null;
  return { type: "return", lastRunId: latest.id, from: input.threadInstanceId, to: target };
}

/** Exhaustion recorded by a failed run, if it failed for a failover cause. */
export function exhaustionFromRun(
  run: Pick<FailoverRun, "status" | "failure" | "completedAt" | "providerInstanceId">,
): { readonly instanceId: string; readonly untilMs: number } | null {
  if (run.status !== "failed" || run.completedAt === null) return null;
  const cause = failoverCause(run.failure);
  if (cause === null || run.failure === null) return null;
  return {
    instanceId: run.providerInstanceId,
    untilMs: exhaustedUntilMs(cause, run.failure, DateTime.toEpochMillis(run.completedAt)),
  };
}
