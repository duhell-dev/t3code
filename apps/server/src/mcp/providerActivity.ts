import type {
  OrchestratorMcpProviderActivityEnvironment,
  OrchestratorMcpProviderActivityInput,
  OrchestratorMcpProviderActivityResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListItem,
  OrchestratorMcpThreadListResult,
  EnvironmentId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { McpInvocationScope } from "./McpInvocationContext.ts";

const LIVE_STATUSES = ["queued", "preparing", "starting", "running", "waiting"] as const;
const LISTING_LIMIT = 100;

/** Every project's live threads, subagents included; one page is enough to see who is busy. */
export const LIVE_THREAD_LISTING = {
  allProjects: true,
  includeSubagents: true,
  statuses: [...LIVE_STATUSES],
  limit: LISTING_LIMIT,
} satisfies OrchestratorMcpThreadListInput;

const groupByProvider = (
  listing: OrchestratorMcpThreadListResult,
  providerInstanceId: OrchestratorMcpProviderActivityInput["providerInstanceId"],
): Pick<OrchestratorMcpProviderActivityEnvironment, "providers" | "truncated"> => {
  const byProvider = new Map<string, Array<OrchestratorMcpThreadListItem>>();
  for (const thread of listing.threads) {
    if (providerInstanceId !== undefined && thread.providerInstanceId !== providerInstanceId)
      continue;
    const threads = byProvider.get(thread.providerInstanceId) ?? [];
    threads.push(thread);
    byProvider.set(thread.providerInstanceId, threads);
  }
  return {
    providers: [...byProvider.values()].map((threads) => ({
      providerInstanceId: threads[0]!.providerInstanceId,
      threads: threads.map((thread) => ({
        threadId: thread.threadId,
        title: thread.title,
        ...(thread.link === undefined ? {} : { link: thread.link }),
        status: thread.status,
        model: thread.model,
      })),
    })),
    truncated: listing.nextCursor !== null,
  };
};

/**
 * Live threads by provider instance here and on each linked environment. A linked environment
 * that does not answer is listed with its error rather than failing the whole answer.
 */
export const providerActivity = Effect.fn("providerActivity")(function* (input: {
  readonly scope: McpInvocationScope;
  readonly filter: OrchestratorMcpProviderActivityInput;
  readonly listHere: (
    listing: OrchestratorMcpThreadListInput,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
  readonly linked: Effect.Effect<
    ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>,
    OrchestratorMcpFailure
  >;
  readonly listThere: (
    environmentId: EnvironmentId,
    listing: OrchestratorMcpThreadListInput,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
}) {
  const here = yield* input.listHere(LIVE_THREAD_LISTING);
  const links = yield* input.linked;
  const there = yield* Effect.forEach(
    links,
    (link) =>
      input.listThere(link.environmentId, LIVE_THREAD_LISTING).pipe(
        Effect.map((listing): OrchestratorMcpProviderActivityEnvironment => ({
          environmentId: link.environmentId,
          label: link.label,
          reachable: true,
          error: null,
          ...groupByProvider(listing, input.filter.providerInstanceId),
        })),
        Effect.catch((failure) =>
          Effect.succeed<OrchestratorMcpProviderActivityEnvironment>({
            environmentId: link.environmentId,
            label: link.label,
            reachable: false,
            error: failure.message,
            providers: [],
            truncated: false,
          }),
        ),
      ),
    { concurrency: 4 },
  );
  return {
    environments: [
      {
        environmentId: input.scope.environmentId,
        label: null,
        reachable: true,
        error: null,
        ...groupByProvider(here, input.filter.providerInstanceId),
      },
      ...there,
    ],
  } satisfies OrchestratorMcpProviderActivityResult;
});
