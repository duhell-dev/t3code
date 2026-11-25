import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadListResult,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { LIVE_THREAD_LISTING, providerActivity } from "./providerActivity.ts";

const here = EnvironmentId.make("environment:here");
const laptop = EnvironmentId.make("environment:laptop");
const offline = EnvironmentId.make("environment:offline");
const scope = { environmentId: here } as McpInvocationScope;

const thread = (threadId: string, providerInstanceId: string) =>
  ({
    threadId,
    title: threadId,
    status: "running",
    providerInstanceId,
    model: "model",
  }) as unknown as OrchestratorMcpThreadListItem;
const listing = (
  threads: ReadonlyArray<OrchestratorMcpThreadListItem>,
  nextCursor: number | null = null,
) =>
  ({
    projectId: null,
    currentThreadId: null,
    threads,
    nextCursor,
    total: threads.length,
  }) as OrchestratorMcpThreadListResult;

it.effect("groups live threads by provider instance here and on every linked environment", () =>
  Effect.gen(function* () {
    const asked: Array<unknown> = [];
    const result = yield* providerActivity({
      scope,
      filter: {},
      listHere: (input) => {
        asked.push(input);
        return Effect.succeed(
          listing([thread("a", "claude"), thread("b", "claude-second"), thread("c", "claude")]),
        );
      },
      linked: Effect.succeed([
        { environmentId: laptop, label: "Laptop" },
        { environmentId: offline, label: "Offline" },
      ]),
      listThere: (environmentId) =>
        environmentId === laptop
          ? Effect.succeed(listing([thread("d", "codex")], 100))
          : Effect.fail(
              new OrchestratorMcpFailure({ code: "orchestration_error", message: "no answer" }),
            ),
    });

    assert.deepStrictEqual(asked, [LIVE_THREAD_LISTING]);
    assert.deepStrictEqual(
      result.environments.map((environment) => [
        environment.environmentId,
        environment.reachable,
        environment.error,
        environment.truncated,
        environment.providers.map((provider): [string, Array<string>] => [
          provider.providerInstanceId,
          provider.threads.map((entry) => String(entry.threadId)),
        ]),
      ]),
      [
        [
          here,
          true,
          null,
          false,
          [
            ["claude", ["a", "c"]],
            ["claude-second", ["b"]],
          ],
        ],
        [laptop, true, null, true, [["codex", ["d"]]]],
        [offline, false, "no answer", false, []],
      ],
    );
  }),
);

it.effect("keeps only the provider instance asked for", () =>
  Effect.gen(function* () {
    const result = yield* providerActivity({
      scope,
      filter: { providerInstanceId: ProviderInstanceId.make("claude-second") },
      listHere: () =>
        Effect.succeed(listing([thread("a", "claude"), thread("b", "claude-second")])),
      linked: Effect.succeed([]),
      listThere: () => Effect.die("no linked environments"),
    });
    assert.deepStrictEqual(
      result.environments[0]!.providers.map((provider) => provider.providerInstanceId),
      ["claude-second"],
    );
  }),
);
