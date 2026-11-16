// duhell: the fork's release list, read without a token. It feeds the release highlights and, in a
// browser, the update target (DUHELL.md, "Update check in the browser").
import { useAtomValue } from "@effect/atom-react";
import { cliReleaseIndexPageUrl } from "@t3tools/shared/cliRelease";
import type { ReleaseWithNotes } from "@t3tools/shared/releaseHighlights";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

import { APP_VERSION } from "~/branding";
import { isElectron } from "~/env";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { releasesRefreshDue, releaseUpdateTarget } from "./forkReleases.logic";

const ReleasesPage = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    body: Schema.optionalKey(Schema.NullOr(Schema.String)),
    draft: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeReleasesPage = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleasesPage));

// Set when a read starts, failed ones included, so a failing GitHub is not asked more often.
let lastReadAt = 0;

/** One page covers weeks of nightlies. A failed refresh keeps the previous list. */
const forkReleasesAtom = Atom.make(
  Effect.gen(function* () {
    lastReadAt = yield* Clock.currentTimeMillis;
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
).pipe(Atom.keepAlive, Atom.withLabel("fork-releases"));

const NO_RELEASES: ReadonlyArray<ReleaseWithNotes> = [];
const IDLE_RELEASES_ATOM: Atom.Atom<
  AsyncResult.AsyncResult<ReadonlyArray<ReleaseWithNotes>, unknown>
> = Atom.make(AsyncResult.success(NO_RELEASES)).pipe(Atom.withLabel("fork-releases:idle"));

/** The last list read, or null while none has arrived (still loading, or GitHub failed). */
export function useForkReleases(enabled = true): ReadonlyArray<ReleaseWithNotes> | null {
  const result = useAtomValue<AsyncResult.AsyncResult<ReadonlyArray<ReleaseWithNotes>, unknown>>(
    enabled ? forkReleasesAtom : IDLE_RELEASES_ATOM,
  );
  if (!enabled) return NO_RELEASES;
  return Option.getOrNull(AsyncResult.value(result));
}

// The desktop app learns of releases from its own updater (localUpdateVersion), so only a browser
// reads the list for the target.
const READS_UPDATE_TARGET = !isElectron;

/**
 * The version servers update to when this client offers no download of its own: this build, or the
 * newest fork release on its channel when a browser has seen a newer one.
 */
export function useReleaseUpdateTarget(baseVersion: string = APP_VERSION): string {
  return releaseUpdateTarget(baseVersion, useForkReleases(READS_UPDATE_TARGET));
}

/** Reads the list again hourly while the window is visible, and on focus after 15 minutes. */
export function startForkReleaseRefresh(): () => void {
  if (!READS_UPDATE_TARGET) return () => {};
  const refresh = (onFocus: boolean) => {
    // Nothing has read the list yet; the first reader starts it.
    if (lastReadAt === 0 || !releasesRefreshDue(lastReadAt, Date.now(), onFocus)) return;
    appAtomRegistry.refresh(forkReleasesAtom);
  };
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible") refresh(false);
  }, 5 * 60_000);
  const onFocus = () => refresh(true);
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") refresh(true);
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
