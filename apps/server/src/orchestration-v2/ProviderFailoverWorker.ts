/**
 * duHell fork: with `providerFailoverChain` set, moves a thread whose run failed for an account
 * cause to the next usable chain instance and continues it; between runs it goes back to a
 * cheaper instance that works again. Decisions live in ProviderFailover.ts.
 */
import {
  CommandId,
  isProviderNativeSubagentThread,
  MessageId,
  ProviderInstanceId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  exhaustionFromRun,
  failoverCauseText,
  failoverContinuationMessageId,
  failoverContinuationText,
  normalizeFailoverChain,
  providerFailoverDecision,
  type FailoverDecision,
  type FailoverRun,
  type InstanceHealth,
} from "./ProviderFailover.ts";

/** Failures older than this neither move threads nor mark instances exhausted. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const NOTICE_SIGNALS = ["provider-failover", "provider-failover-stop", "provider-failover-return"];

const affectsFailover = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const due = DueHint.make();
  // Instance id -> epoch ms. Kept across sweeps so a thread that already moved on still tells
  // the others; rebuilt from failed runs after a restart.
  const exhaustedUntil = new Map<string, number>();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsFailover(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));

  const writeNotice = Effect.fn("ProviderFailoverWorker.writeNotice")(function* (input: {
    readonly threadId: ThreadId;
    readonly run: OrchestrationV2Run;
    readonly signal: string;
    readonly title: string;
    readonly message: string;
  }) {
    const now = yield* DateTime.now;
    const commandId = CommandId.make(`${input.signal}:${input.run.id}`);
    const item: OrchestrationV2TurnItem = {
      id: ids.derive.runSignalTurnItem({ runId: input.run.id, signal: input.signal }),
      threadId: input.threadId,
      runId: input.run.id,
      nodeId: input.run.rootNodeId,
      providerThreadId: input.run.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      // EventSink allocates the real position, after the run's existing items.
      ordinal: 0,
      status: "completed",
      title: input.title,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "system_notice",
      message: input.message,
    };
    yield* eventSink.write({
      commandId,
      events: [
        {
          id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: input.run.id,
          ...(input.run.rootNodeId === null ? {} : { nodeId: input.run.rootNodeId }),
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: now,
          payload: item,
        },
      ],
    });
  });

  const carryOut = Effect.fn("ProviderFailoverWorker.carryOut")(function* (input: {
    readonly threadId: ThreadId;
    readonly decision: FailoverDecision;
    readonly runs: ReadonlyMap<string, OrchestrationV2Run>;
    readonly modelSelection: OrchestrationV2Run["modelSelection"];
  }) {
    const { decision, threadId } = input;
    if (decision.type === "stop") {
      const run = input.runs.get(decision.failedRunId)!;
      const message = `Provider failover stopped: ${decision.from} failed because ${failoverCauseText(decision.cause)}, and no other instance of the failover chain is usable (tried here: ${decision.tried.join(", ")}). The thread stays on ${decision.from}.`;
      yield* Effect.logWarning("orchestration-v2.provider-failover.stopped", {
        threadId,
        runId: decision.failedRunId,
        from: decision.from,
        cause: decision.cause,
        tried: decision.tried,
      });
      yield* writeNotice({
        threadId,
        run,
        signal: "provider-failover-stop",
        title: "Provider failover stopped",
        message,
      });
      return;
    }
    const target = ProviderInstanceId.make(decision.to);
    // Model and options stay; only the instance changes (same path as t3_thread_configure).
    const modelSelection = { ...input.modelSelection, instanceId: target };
    if (decision.type === "switch") {
      const run = input.runs.get(decision.failedRunId)!;
      yield* Effect.logWarning("orchestration-v2.provider-failover.switch", {
        threadId,
        runId: decision.failedRunId,
        from: decision.from,
        to: decision.to,
        cause: decision.cause,
      });
      yield* threads.dispatch({
        type: "provider.switch",
        commandId: CommandId.make(`provider-failover-switch:${decision.failedRunId}`),
        threadId,
        modelSelection,
      });
      yield* writeNotice({
        threadId,
        run,
        signal: "provider-failover",
        title: "Provider failover",
        message: `Switched from ${decision.from} to ${decision.to} because ${decision.from} failed: ${failoverCauseText(decision.cause)}. Continuing there.`,
      });
      const messageId = failoverContinuationMessageId(threadId, decision.failedRunId);
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(messageId),
        messageId: MessageId.make(messageId),
        threadId,
        text: failoverContinuationText(decision.from, decision.to, decision.cause),
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
      });
      return;
    }
    const run = input.runs.get(decision.lastRunId)!;
    yield* Effect.logInfo("orchestration-v2.provider-failover.return", {
      threadId,
      from: decision.from,
      to: decision.to,
    });
    yield* threads.dispatch({
      type: "provider.switch",
      commandId: CommandId.make(`provider-failover-return:${decision.lastRunId}`),
      threadId,
      modelSelection,
    });
    yield* writeNotice({
      threadId,
      run,
      signal: "provider-failover-return",
      title: "Provider failover: back",
      message: `Switched back from ${decision.from} to ${decision.to} because ${decision.to} is usable again. The next run starts there.`,
    });
  });

  return Effect.fn("ProviderFailoverWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    const chain = normalizeFailoverChain(preferences.providerFailoverChain);
    if (chain.length < 2) {
      yield* due.record(readVersion, Infinity, nowMs);
      return;
    }
    const health = new Map<string, InstanceHealth>();
    for (const provider of yield* providerRegistry.getProviders) {
      health.set(provider.instanceId, {
        usable:
          provider.enabled &&
          provider.installed &&
          provider.status !== "disabled" &&
          provider.auth.status !== "unauthenticated",
      });
    }
    const threadIds = yield* projections.getProviderFailoverThreadIds(
      DateTime.makeUnsafe(nowMs - LOOKBACK_MS),
    );
    // Read every candidate first so all failures count before any thread picks a target.
    const states: Array<{
      readonly threadId: ThreadId;
      readonly blocked: boolean;
      readonly threadInstanceId: ProviderInstanceId;
      readonly modelSelection: OrchestrationV2Run["modelSelection"];
      readonly runs: ReadonlyArray<OrchestrationV2Run>;
      readonly failoverRuns: ReadonlyArray<FailoverRun>;
      readonly noticedRunIds: ReadonlySet<string>;
    }> = [];
    for (const threadId of threadIds) {
      const records = yield* projections
        .getThreadRecords(threadId, ["runs", "turnItems", "runtimeRequests"], {
          turnItemTypes: ["error", "system_notice"],
        })
        .pipe(Effect.option);
      if (records._tag === "None") continue;
      const { thread, runs, turnItems, runtimeRequests } = records.value;
      const noticeIds = new Map(
        runs.flatMap((run) =>
          NOTICE_SIGNALS.map(
            (signal) =>
              [ids.derive.runSignalTurnItem({ runId: run.id, signal }) as string, run.id] as const,
          ),
        ),
      );
      const noticedRunIds = new Set<string>();
      for (const item of turnItems) {
        const runId = noticeIds.get(item.id);
        if (runId !== undefined) noticedRunIds.add(runId);
      }
      const failoverRuns = runs.map((run) => ({
        ...run,
        failure: latestRootProviderFailure(run, turnItems),
      }));
      for (const run of failoverRuns) {
        const exhausted = exhaustionFromRun(run);
        if (exhausted === null || nowMs - exhausted.untilMs > LOOKBACK_MS) continue;
        if ((exhaustedUntil.get(exhausted.instanceId) ?? 0) < exhausted.untilMs) {
          exhaustedUntil.set(exhausted.instanceId, exhausted.untilMs);
        }
      }
      states.push({
        threadId,
        blocked:
          thread.archivedAt !== null ||
          thread.deletedAt != null ||
          thread.settledOverride === "settled" ||
          isProviderNativeSubagentThread(thread) ||
          runtimeRequests.some((request) => request.status === "pending"),
        threadInstanceId: thread.providerInstanceId,
        modelSelection: thread.modelSelection,
        runs,
        failoverRuns,
        noticedRunIds,
      });
    }
    let acted = false;
    for (const state of states) {
      const decision = providerFailoverDecision({
        chain,
        threadId: state.threadId,
        threadInstanceId: state.threadInstanceId,
        runs: state.failoverRuns,
        blocked: state.blocked,
        noticedRunIds: state.noticedRunIds,
        health,
        exhaustedUntil,
        nowMs,
      });
      if (decision === null) continue;
      acted = true;
      yield* carryOut({
        threadId: state.threadId,
        decision,
        runs: new Map(state.runs.map((run) => [run.id as string, run])),
        modelSelection: state.modelSelection,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.provider-failover.failed", {
            threadId: state.threadId,
            decision: decision.type,
            cause,
          }),
        ),
      );
    }
    if (acted) return;
    // Wake when the next exhausted instance may be usable again, for the way back.
    let wakeAt = Infinity;
    for (const until of exhaustedUntil.values()) {
      if (until > nowMs && until < wakeAt) wakeAt = until;
    }
    yield* due.record(readVersion, wakeAt, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("provider-failover", sweep());
  }),
);
