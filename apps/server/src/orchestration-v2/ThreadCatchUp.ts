import {
  idleCompactionOf,
  OrchestrationV2ConversationMessageJson,
  ProjectId,
  ThreadCatchUpError,
  type ThreadCatchUpInput,
  type ThreadCatchUpResult,
  type ThreadCatchUpSummary,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

/** Below both, the reader catches up from the "New" line alone. */
const CATCH_UP_MIN_ANSWERS = 3;
const CATCH_UP_MIN_CHARACTERS = 2_000;
// About 20k tokens: Haiku answers in a few seconds, and a long chain still fits.
const PROMPT_BUDGET_CHARACTERS = 80_000;
const MESSAGE_BUDGET_CHARACTERS = 4_000;
const CACHE_CAPACITY = 64;

type CatchUpMessage = OrchestrationV2ConversationMessageJson;

interface CatchUpMaterial {
  readonly messages: ReadonlyArray<CatchUpMessage>;
  readonly answerCount: number;
  readonly characterCount: number;
}

/** What the reader missed: replies and agent input, without the user's own words. */
function catchUpMaterial(messages: ReadonlyArray<CatchUpMessage>): CatchUpMaterial {
  const answers = new Set<string>();
  let characterCount = 0;
  const kept: CatchUpMessage[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.text.trim().length === 0) continue;
    if (idleCompactionOf(message) !== undefined) continue;
    if (message.role === "user" && message.createdBy === "user") continue;
    kept.push(message);
    if (message.role === "assistant") {
      answers.add(message.runId ?? message.id);
      characterCount += message.text.length;
    }
  }
  return { messages: kept, answerCount: answers.size, characterCount };
}

function catchUpIsWorthwhile(material: CatchUpMaterial): boolean {
  return (
    material.answerCount >= CATCH_UP_MIN_ANSWERS ||
    material.characterCount > CATCH_UP_MIN_CHARACTERS
  );
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)} […]`;
}

function speaker(message: CatchUpMessage): string {
  if (message.role === "assistant") return "Agent";
  if (message.delegatedCompletion !== undefined) return "Delegated task finished";
  if (message.notification !== undefined) return "Notification";
  if (message.senderThreadId !== undefined || message.linkedSender !== undefined)
    return "Message from another agent";
  return message.createdBy === "user" ? "User" : "Automatic input";
}

function buildCatchUpPrompt(input: {
  readonly messages: ReadonlyArray<CatchUpMessage>;
  readonly userLanguageSample: string | null;
}): string {
  const blocks: string[] = [];
  let used = 0;
  // Newest first into the budget, so a long chain loses its oldest messages.
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]!;
    const block = `[${DateTime.formatIso(message.createdAt).slice(11, 16)} UTC] ${speaker(message)}:\n${clip(message.text.trim(), MESSAGE_BUDGET_CHARACTERS)}`;
    if (used + block.length > PROMPT_BUDGET_CHARACTERS && blocks.length > 0) {
      blocks.push("(earlier messages omitted)");
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  blocks.reverse();
  const language =
    input.userLanguageSample === null
      ? "Write in the language the messages are written in."
      : `Write in the language of this sample of the user's own writing: <user_sample>${clip(input.userLanguageSample, 400)}</user_sample>`;
  return `The user of a coding-agent app stepped away from a thread. Below is everything the agents wrote there since the user last read it, oldest first. Summarize it so the user can catch up without reading it all. ${language}

Return a JSON object with one key, transcription, holding these lines separated by newlines, without headings or Markdown emphasis:
- First, one line per thing the user has to decide or do now, each starting with "TODO: ". Name the open question or approval and the agent's recommendation if it gave one. Leave these out when nothing waits on the user.
- Then 2 to 6 lines starting with "- ": results first, then what changed. One short sentence each, with the concrete names and numbers from the messages.
At most 8 lines in total. Do not invent anything the messages do not say.

<messages>
${blocks.join("\n\n")}
</messages>`;
}

function parseCatchUpLines(text: string): Pick<ThreadCatchUpSummary, "todo" | "points"> {
  const todo: string[] = [];
  const points: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw
      .trim()
      .replace(/^[-*•]\s+/, "")
      .replace(/^\*\*(.+)\*\*$/, "$1")
      .trim();
    if (line.length === 0) continue;
    const task = /^TODO:\s*(.+)$/i.exec(line);
    if (task) todo.push(task[1]!.trim());
    else points.push(line);
  }
  return { todo: todo.slice(0, 8), points: points.slice(0, Math.max(0, 8 - todo.length)) };
}

export class ThreadCatchUp extends Context.Service<
  ThreadCatchUp,
  {
    readonly getCatchUp: (
      input: ThreadCatchUpInput,
    ) => Effect.Effect<ThreadCatchUpResult, ThreadCatchUpError>;
  }
>()("t3/orchestration-v2/ThreadCatchUp") {}

const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  // Keyed by thread, boundary and newest message, so opening twice costs one generation.
  const cache = new Map<string, Deferred.Deferred<ThreadCatchUpSummary, ThreadCatchUpError>>();

  const failed = (detail: string) => (cause: unknown) =>
    new ThreadCatchUpError({
      detail:
        cause instanceof Error && cause.message.length > 0 ? `${detail}: ${cause.message}` : detail,
    });

  const readThread = Effect.fn("ThreadCatchUp.readThread")(function* (
    threadId: ThreadId,
    since: DateTime.Utc,
  ) {
    const sinceIso = DateTime.formatIso(since);
    const unreadable = failed("Could not read this thread");
    const threadRows = yield* sql<{ readonly project_id: string }>`
      SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `.pipe(Effect.mapError(unreadable));
    const projectId = threadRows[0]?.project_id;
    if (projectId === undefined) {
      return yield* new ThreadCatchUpError({ detail: "This thread no longer exists." });
    }
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId} AND created_at > ${sinceIso}
      ORDER BY created_at ASC, message_id ASC
    `.pipe(Effect.mapError(unreadable));
    const sampleRows = yield* sql<{ readonly text: string | null }>`
      SELECT json_extract(payload_json, '$.text') AS text
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId} AND role = 'user'
        AND json_extract(payload_json, '$.createdBy') = 'user'
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1
    `.pipe(Effect.mapError(unreadable));
    const messages = yield* Effect.forEach(rows, (row) => decodeMessage(row.payload_json)).pipe(
      Effect.mapError(unreadable),
    );
    return {
      projectId: ProjectId.make(projectId),
      messages,
      userLanguageSample: sampleRows[0]?.text?.trim() || null,
    };
  });

  const generate = Effect.fn("ThreadCatchUp.generate")(function* (input: {
    readonly projectId: ProjectId;
    readonly material: CatchUpMaterial;
    readonly userLanguageSample: string | null;
  }) {
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings.pipe(Effect.mapError(failed("Could not read settings"))),
      input.projectId,
    ).settings;
    // Summaries read no checkout.
    const cwd = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-catch-up-" })
      .pipe(Effect.mapError(failed("Could not prepare the summary")));
    // The transcript-cleanup operation is every driver's plain prompt-in, text-out path.
    const generated = yield* textGeneration
      .generateTranscriptionPostProcessing({
        cwd,
        prompt: buildCatchUpPrompt({
          messages: input.material.messages,
          userLanguageSample: input.userLanguageSample,
        }),
        modelSelection: settings.textGenerationModelSelection,
      })
      .pipe(Effect.mapError(failed("Could not summarize this thread")));
    return {
      ...parseCatchUpLines(generated.transcription),
      messageCount: input.material.answerCount,
      model: settings.textGenerationModelSelection.model,
    } satisfies ThreadCatchUpSummary;
  }, Effect.scoped);

  const getCatchUp = Effect.fn("ThreadCatchUp.getCatchUp")(function* (input: ThreadCatchUpInput) {
    const parsed = DateTime.make(input.since);
    if (Option.isNone(parsed)) {
      return yield* new ThreadCatchUpError({ detail: "The catch-up boundary is not a time." });
    }
    const since = parsed.value;
    const thread = yield* readThread(input.threadId, since);
    const material = catchUpMaterial(thread.messages);
    if (!catchUpIsWorthwhile(material)) return { summary: null };
    const newest = material.messages.at(-1)!;
    const key = `${input.threadId}|${DateTime.formatIso(since)}|${newest.id}|${DateTime.formatIso(newest.updatedAt)}`;
    const cached = cache.get(key);
    if (cached !== undefined) return { summary: yield* Deferred.await(cached) };
    const deferred = yield* Deferred.make<ThreadCatchUpSummary, ThreadCatchUpError>();
    cache.set(key, deferred);
    while (cache.size > CACHE_CAPACITY) cache.delete(cache.keys().next().value!);
    const exit = yield* Effect.exit(
      generate({
        projectId: thread.projectId,
        material,
        userLanguageSample: thread.userLanguageSample,
      }),
    );
    // A failure is not cached; the next open tries again.
    if (Exit.isFailure(exit)) cache.delete(key);
    yield* Deferred.done(deferred, exit);
    return { summary: yield* exit };
  });

  return ThreadCatchUp.of({ getCatchUp });
});

export const layer = Layer.effect(ThreadCatchUp, make);
