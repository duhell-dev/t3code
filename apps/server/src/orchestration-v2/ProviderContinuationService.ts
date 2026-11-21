import {
  CommandId,
  type MessageId,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import type * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { isUndeliveredMailboxSteer } from "./NotificationMailbox.ts";
import { agentInputHoldUntil } from "./AgentInputQuietWindow.ts";
import * as ServerSettings from "../serverSettings.ts";

const CONTINUATION_MESSAGE_TEXT = "Background task completed.";

function delegatedCompletionText(taskIds: ReadonlyArray<string>): string {
  const taskList = taskIds.join(", ");
  return taskIds.length === 1
    ? `Delegated task ${taskList} reached a terminal state. Use task_status with taskId ${taskList} to read the result.`
    : `Delegated tasks ${taskList} reached terminal states. Use task_status with each taskId to read the results.`;
}

function currentDelegatedCompletionDelivery(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs" | "providerTurns">,
  completion: NonNullable<
    ProviderContinuationRequests.ProviderContinuationRequest["delegatedCompletion"]
  >,
) {
  const sourceRun = projection.runs.find((candidate) => candidate.id === completion.parentRunId);
  const delivery = sourceRun?.delegatedCompletion?.delivery;
  const alreadyDispatched = projection.messages.some(
    (message) => message.id === completion.messageId,
  );
  if (
    sourceRun?.delegatedCompletion?.disposition !== "open" ||
    delivery === null ||
    delivery === undefined ||
    delivery.generation !== completion.generation ||
    delivery.messageId !== completion.messageId ||
    (alreadyDispatched && !isUndeliveredMailboxSteer(projection, completion.messageId))
  ) {
    return undefined;
  }
  return delivery;
}

function delegatedCompletionRetryKey(
  request: ProviderContinuationRequests.ProviderContinuationRequest,
  completion: NonNullable<
    ProviderContinuationRequests.ProviderContinuationRequest["delegatedCompletion"]
  >,
): string {
  return `${request.threadId}:${completion.parentRunId}:${completion.generation}:${completion.messageId}`;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const ids = yield* IdAllocator.IdAllocatorV2;
    const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const retryAttempts = yield* Ref.make(new Map<string, number>());
    const continuations = yield* KeyedLock.makeRunner<ThreadId>();
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    // Completions an idle thread is collecting, per delivery; `token` names the latest timer.
    const quietHolds = new Map<
      string,
      { readonly firstHeldAtMs: number; readonly token: number; readonly released: boolean }
    >();

    // Holds a delegated completion to an idle thread until its quiet window ends, so siblings
    // finishing meanwhile join the same delivery and one run answers them all. Any new run on
    // the thread, like a person's message, releases it at once.
    const holdForQuietWindow = Effect.fn("ProviderContinuationService.holdForQuietWindow")(
      function* (
        request: ProviderContinuationRequests.ProviderContinuationRequest,
        completion: NonNullable<
          ProviderContinuationRequests.ProviderContinuationRequest["delegatedCompletion"]
        >,
        taskIds: ReadonlyArray<string>,
      ) {
        const key = delegatedCompletionRetryKey(request, completion);
        const existing = quietHolds.get(key);
        if (existing?.released === true) {
          quietHolds.delete(key);
          return false;
        }
        const quietSeconds = yield* serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.agentInputQuietSeconds),
          Effect.orElseSucceed(() => 0),
        );
        if (quietSeconds <= 0) return false;
        const projection = yield* threads.getThreadRecords(
          request.threadId,
          ["runs", "subagents"],
          {
            subagentRunIds: [completion.parentRunId],
          },
        );
        const nowMs = yield* Clock.currentTimeMillis;
        const dueAtMs = agentInputHoldUntil({
          quietMs: quietSeconds * 1_000,
          nowMs,
          firstHeldAtMs: existing?.firstHeldAtMs,
          threadIdle: !projection.runs.some(
            (run) => run.status === "queued" || ThreadManagementService.isActiveRun(run),
          ),
          siblingsRunning: projection.subagents.some(
            (task) =>
              task.runId === completion.parentRunId &&
              !taskIds.includes(task.id) &&
              (task.status === "pending" || task.status === "running"),
          ),
        });
        if (dueAtMs === null) {
          quietHolds.delete(key);
          return false;
        }
        const token = (existing?.token ?? 0) + 1;
        quietHolds.set(key, {
          firstHeldAtMs: existing?.firstHeldAtMs ?? nowMs,
          token,
          released: false,
        });
        const runStarted = threads.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "run.created" && event.threadId === request.threadId,
          ),
          Stream.runHead,
          Effect.ignore,
        );
        yield* runStarted.pipe(
          Effect.timeoutOrElse({
            duration: `${dueAtMs - nowMs} millis`,
            orElse: () => Effect.void,
          }),
          Effect.andThen(
            Effect.suspend(() => {
              const current = quietHolds.get(key);
              if (current?.token !== token) return Effect.void;
              quietHolds.set(key, { ...current, released: true });
              return requests.offer(request);
            }),
          ),
          Effect.forkScoped,
        );
        return true;
      },
    );

    const clearRetryAttempt = (key: string) =>
      Ref.update(retryAttempts, (current) => {
        if (!current.has(key)) return current;
        const updated = new Map(current);
        updated.delete(key);
        return updated;
      });

    const nextRetryDelay = (key: string) =>
      Ref.modify(retryAttempts, (current) => {
        const attempt = current.get(key) ?? 0;
        const updated = new Map(current);
        updated.set(key, attempt + 1);
        return [Math.min(100 * 2 ** Math.min(attempt, 6), 5_000), updated] as const;
      });

    // Cancelling or stopping a queued continuation ends it unstarted; only the request can release the adapter's wake latch.
    const releaseIfNeverStarted = Effect.fn("ProviderContinuationService.releaseIfNeverStarted")(
      function* (
        request: ProviderContinuationRequests.ProviderContinuationRequest,
        messageId: MessageId,
        dispatched: Orchestrator.OrchestratorV2DispatchResult,
      ) {
        const onRunEndedWithoutStarting = request.onRunEndedWithoutStarting;
        if (onRunEndedWithoutStarting === undefined) return;
        const runId = dispatched.storedEvents.flatMap(({ event }) =>
          event.type === "run.created" && event.payload.userMessageId === messageId
            ? [event.payload.id]
            : [],
        )[0];
        if (runId === undefined) return;
        yield* threads
          .streamStoredEventsFrom({
            threadId: request.threadId,
            afterSequence: dispatched.sequence,
            eventType: "run.updated",
          })
          .pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.payload.id === runId &&
                ThreadManagementService.isTerminalRunStatus(event.payload.status),
            ),
            Stream.runHead,
            Effect.flatMap((ended) =>
              Option.isSome(ended) &&
              ended.value.event.type === "run.updated" &&
              ended.value.event.payload.startedAt === null
                ? onRunEndedWithoutStarting()
                : Effect.void,
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.provider-continuation.run-watch-failed", {
                threadId: request.threadId,
                providerThreadId: request.providerThreadId,
                cause,
              }),
            ),
            Effect.forkScoped,
          );
      },
    );

    const dispatchContinuation = Effect.fn("ProviderContinuationService.dispatchContinuation")(
      function* (request: ProviderContinuationRequests.ProviderContinuationRequest) {
        const projection = yield* threads.getThreadRecords(
          request.threadId,
          ["messages", "runs", "providerTurns"],
          {
            messageIds:
              request.delegatedCompletion === undefined
                ? []
                : [request.delegatedCompletion.messageId],
          },
        );
        if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
          yield* Effect.logInfo("orchestration-v2.provider-continuation.thread-archived", {
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
          });
          if (request.delegatedCompletion !== undefined) {
            yield* clearRetryAttempt(
              delegatedCompletionRetryKey(request, request.delegatedCompletion),
            );
          }
          if (request.clearIfCurrent !== undefined) {
            yield* request.clearIfCurrent();
          } else if (request.dispatchIfCurrent !== undefined) {
            yield* request.dispatchIfCurrent(Effect.void);
          }
          return;
        }
        if (request.delegatedCompletion !== undefined) {
          const retryKey = delegatedCompletionRetryKey(request, request.delegatedCompletion);
          const delivery = currentDelegatedCompletionDelivery(
            projection,
            request.delegatedCompletion,
          );
          if (delivery === undefined) {
            yield* clearRetryAttempt(retryKey);
            return;
          }
          if (yield* holdForQuietWindow(request, request.delegatedCompletion, delivery.taskIds)) {
            return;
          }
          const commandId = yield* ids.allocate.command({
            fixtureName: "delegated-completion",
            commandName: "dispatch",
          });
          yield* threads
            .dispatch({
              type: "message.dispatch",
              commandId,
              threadId: request.threadId,
              messageId: delivery.messageId,
              text: delegatedCompletionText(delivery.taskIds),
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "server",
              delegatedCompletion: {
                parentRunId: request.delegatedCompletion.parentRunId,
                generation: delivery.generation,
                taskIds: delivery.taskIds,
              },
            })
            .pipe(
              Effect.catchTags({
                ThreadManagementProviderInstanceDisabledError: (error) =>
                  Effect.logInfo(
                    "orchestration-v2.provider-continuation.delegated-completion-disabled",
                    {
                      threadId: request.threadId,
                      projectId: error.projectId,
                      instanceId: error.instanceId,
                    },
                  ).pipe(
                    Effect.andThen(
                      Effect.forEach(
                        delivery.taskIds,
                        (taskId) =>
                          ids.allocate
                            .command({
                              fixtureName: "delegated-completion",
                              commandName: "dispose-disabled",
                            })
                            .pipe(
                              Effect.flatMap((disposeCommandId) =>
                                threads.dispatch({
                                  type: "delegated_task.completion-delivery.dispose",
                                  commandId: disposeCommandId,
                                  parentThreadId: request.threadId,
                                  taskId,
                                }),
                              ),
                            ),
                        { discard: true },
                      ),
                    ),
                    Effect.andThen(
                      request.clearIfCurrent !== undefined
                        ? request.clearIfCurrent()
                        : request.dispatchIfCurrent !== undefined
                          ? request.dispatchIfCurrent(Effect.void)
                          : Effect.void,
                    ),
                  ),
              }),
            );
          yield* clearRetryAttempt(retryKey);
          return;
        }
        const messageId =
          request.messageId ??
          (yield* ids.allocate.message({
            threadId: request.threadId,
            ordinal: projection.messages.length + 1,
          }));
        const commandId = CommandId.make(`provider-continuation:${messageId}`);
        const dispatch = threads
          .dispatch({
            type: "message.dispatch",
            commandId,
            threadId: request.threadId,
            messageId,
            text: request.detail ?? CONTINUATION_MESSAGE_TEXT,
            notification: request.notification ?? {
              source: { kind: "background_task" },
              outcome: "updated",
              summary: "Background activity updated",
            },
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            // Only buffered wakes use creationSource "provider"; Claude would drain an empty buffer instead of prompting message_text.
            creationSource: request.delivery === "message_text" ? "server" : "provider",
          })
          .pipe(Effect.tap((dispatched) => releaseIfNeverStarted(request, messageId, dispatched)));
        // Catch after dispatchIfCurrent so adapters see raw failures first; clearIfCurrent is idempotent and covers others.
        const logInstanceDisabled = (
          error: ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
        ) =>
          Effect.logInfo("orchestration-v2.provider-continuation.instance-disabled", {
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
            projectId: error.projectId,
            instanceId: error.instanceId,
          }).pipe(
            Effect.andThen(
              request.clearIfCurrent !== undefined ? request.clearIfCurrent() : Effect.void,
            ),
          );
        if (request.dispatchIfCurrent === undefined) {
          yield* dispatch.pipe(
            Effect.catchTags({
              ThreadManagementProviderInstanceDisabledError: logInstanceDisabled,
            }),
          );
          return;
        }
        yield* request.dispatchIfCurrent(dispatch).pipe(
          Effect.catchTags({
            ThreadManagementProviderInstanceDisabledError: logInstanceDisabled,
          }),
        );
      },
    );

    yield* requests.take.pipe(
      Effect.flatMap((request) =>
        dispatchContinuation(request).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("orchestration-v2.provider-continuation.dispatch-failed", {
                threadId: request.threadId,
                providerThreadId: request.providerThreadId,
                cause,
              });
              if (request.delegatedCompletion !== undefined) {
                const completion = request.delegatedCompletion;
                const retryKey = delegatedCompletionRetryKey(request, completion);
                const retryDelay = yield* nextRetryDelay(retryKey);
                yield* Effect.gen(function* () {
                  yield* Effect.sleep(`${retryDelay} millis`);
                  const projection = yield* threads.getThreadRecords(
                    request.threadId,
                    ["messages", "runs", "providerTurns"],
                    {
                      messageIds:
                        request.delegatedCompletion === undefined
                          ? []
                          : [request.delegatedCompletion.messageId],
                    },
                  );
                  if (currentDelegatedCompletionDelivery(projection, completion) !== undefined) {
                    yield* requests.offer(request);
                  } else {
                    yield* clearRetryAttempt(retryKey);
                  }
                }).pipe(
                  Effect.catchCause((retryCause) =>
                    Effect.logWarning("orchestration-v2.provider-continuation.retry-check-failed", {
                      threadId: request.threadId,
                      providerThreadId: request.providerThreadId,
                      cause: retryCause,
                    }).pipe(Effect.andThen(requests.offer(request))),
                  ),
                  Effect.forkScoped,
                );
              } else if (request.clearIfCurrent !== undefined) {
                yield* request.clearIfCurrent();
              }
            }),
          ),
          // A dispatch can wait on its parent's lock, so only its own thread's later requests queue behind it.
          (handled) => continuations.run(request.threadId, handled),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
