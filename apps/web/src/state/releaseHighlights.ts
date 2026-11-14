import { useAtomValue } from "@effect/atom-react";
import { cliReleaseIndexPageUrl } from "@t3tools/shared/cliRelease";
import {
  type ReleaseHighlight,
  releaseHighlightsBetween,
  type ReleaseWithNotes,
} from "@t3tools/shared/releaseHighlights";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

const ReleasesPage = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    body: Schema.optionalKey(Schema.NullOr(Schema.String)),
    draft: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeReleasesPage = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleasesPage));

/** One page covers weeks of nightlies; read once per session, only when something needs it. */
const releasesAtom = Atom.make(
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get(cliReleaseIndexPageUrl(1)).pipe(
          HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
        ),
      )
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const releases: ReadonlyArray<ReleaseWithNotes> = yield* decodeReleasesPage(
      yield* response.text,
    );
    return releases;
  }).pipe(Effect.provide(FetchHttpClient.layer)),
).pipe(Atom.keepAlive, Atom.withLabel("release-highlights:releases"));

const NO_HIGHLIGHTS: ReadonlyArray<ReleaseHighlight> = [];
const NO_RELEASES: ReadonlyArray<ReleaseWithNotes> = [];
const IDLE_RELEASES_ATOM: Atom.Atom<
  AsyncResult.AsyncResult<ReadonlyArray<ReleaseWithNotes>, unknown>
> = Atom.make(AsyncResult.success(NO_RELEASES)).pipe(Atom.withLabel("release-highlights:idle"));

/** Null while the releases load or when GitHub could not be read; empty when nothing is worth showing. */
export function useReleaseHighlights(
  fromVersion: string | null | undefined,
  toVersion: string | null,
  enabled = true,
): ReadonlyArray<ReleaseHighlight> | null {
  const result = useAtomValue<AsyncResult.AsyncResult<ReadonlyArray<ReleaseWithNotes>, unknown>>(
    enabled && toVersion !== null ? releasesAtom : IDLE_RELEASES_ATOM,
  );
  if (!enabled || toVersion === null) return NO_HIGHLIGHTS;
  if (!AsyncResult.isSuccess(result)) return null;
  return releaseHighlightsBetween(result.value, fromVersion, toVersion);
}
