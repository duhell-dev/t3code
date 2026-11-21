import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCatchUp from "./ThreadCatchUp.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread:catch-up");
const projectId = ProjectId.make("project:catch-up");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 10, minute));

const threadPayload = (lastVisitedAt: DateTime.Utc | null) => ({
  createdBy: "user" as const,
  creationSource: "web" as const,
  id: threadId,
  projectId,
  title: "Catch up",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: at(0),
  updatedAt: at(0),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt,
  deletedAt: null,
});

const message = (
  id: string,
  minute: number,
  role: "user" | "assistant",
  text: string,
  runId: string | null,
  createdBy: "user" | "agent" = role === "user" ? "user" : "agent",
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${id}`),
  type: "message.updated",
  threadId,
  occurredAt: at(minute),
  payload: {
    id: MessageId.make(id),
    threadId,
    runId: runId === null ? null : RunId.make(runId),
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: false,
    createdBy,
    creationSource: role === "user" ? "web" : "provider",
    createdAt: at(minute),
    updatedAt: at(minute),
  },
});

const seed = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* store.apply({
      id: EventId.make("event:created"),
      type: "thread.created",
      threadId,
      occurredAt: at(0),
      payload: threadPayload(at(10)),
    });
    for (const event of events) yield* store.apply(event);
  });

const makeLayer = (prompts: Array<string>) =>
  ThreadCatchUp.layer.pipe(
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({
        generateTranscriptionPostProcessing: (input) =>
          Effect.sync(() => {
            prompts.push(input.prompt);
            return {
              transcription:
                "TODO: Decide whether to rewrite the history. Recommended: no.\n- Release 27 is out.\n- **Disk at 85%.**",
            };
          }),
      }),
    ),
    Layer.provideMerge(ProjectionStore.layer),
    Layer.provideMerge(
      Layer.mergeAll(SqlitePersistence.layerMemory, ServerSettings.layerTest(), NodeServices.layer),
    ),
  );

describe("ThreadCatchUp", () => {
  it.effect("summarizes only what came after the boundary, once per newest message", () => {
    const prompts: Array<string> = [];
    return Effect.gen(function* () {
      yield* seed([
        message("seen", 5, "assistant", "Already read before the visit.", "run-0"),
        message("prompt", 6, "user", "Bitte baue beide Pläne.", null),
        message("a1", 12, "assistant", "Started the release.", "run-1"),
        message("wake", 13, "user", "Delegated task finished.", null, "agent"),
        message("a2", 14, "assistant", "Release 27 published.", "run-2"),
        message("a3", 15, "assistant", "Disk is at 85 percent.", "run-3"),
      ]);
      const catchUp = yield* ThreadCatchUp.ThreadCatchUp;
      const input = { threadId, since: DateTime.formatIso(at(10)) };
      const first = yield* catchUp.getCatchUp(input);
      assert.deepEqual(first.summary, {
        todo: ["Decide whether to rewrite the history. Recommended: no."],
        points: ["Release 27 is out.", "Disk at 85%."],
        messageCount: 3,
        model: (yield* ServerSettings.ServerSettingsService.pipe(
          Effect.flatMap((settings) => settings.getSettings),
        )).textGenerationModelSelection.model,
      });
      yield* catchUp.getCatchUp(input);
      assert.equal(prompts.length, 1);
      assert.include(prompts[0], "Release 27 published.");
      assert.include(prompts[0], "Delegated task finished");
      assert.include(prompts[0], "Bitte baue beide Pläne.");
      assert.notInclude(prompts[0], "Already read before the visit.");
    }).pipe(Effect.provide(makeLayer(prompts)));
  });

  it.effect("skips the model when one short answer is all that is new", () => {
    const prompts: Array<string> = [];
    return Effect.gen(function* () {
      yield* seed([message("a1", 12, "assistant", "Done.", "run-1")]);
      const catchUp = yield* ThreadCatchUp.ThreadCatchUp;
      const result = yield* catchUp.getCatchUp({ threadId, since: DateTime.formatIso(at(10)) });
      assert.isNull(result.summary);
      assert.equal(prompts.length, 0);
    }).pipe(Effect.provide(makeLayer(prompts)));
  });

  it.effect("the shell counts one answer per run since the visit, and none once visited", () =>
    Effect.gen(function* () {
      yield* seed([
        message("seen", 5, "assistant", "Before.", "run-0"),
        message("a1", 12, "assistant", "One.", "run-1"),
        message("a1b", 13, "assistant", "Still run one.", "run-1"),
        message("a2", 14, "assistant", "Two.", "run-2"),
      ]);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const count = Effect.map(
        store.getShellSnapshot(),
        (snapshot) => snapshot.threads.find((row) => row.id === threadId)?.unreadMessageCount,
      );
      assert.equal(yield* count, 2);
      assert.equal((yield* store.getThreadShell(threadId))?.unreadMessageCount, 2);
      yield* store.apply({
        id: EventId.make("event:visited"),
        type: "thread.visited",
        threadId,
        occurredAt: at(20),
        payload: { ...threadPayload(at(20)) },
      });
      assert.equal(yield* count, 0);
    }).pipe(Effect.provide(makeLayer([]))),
  );
});
