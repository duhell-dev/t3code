// duhell: a device joins the linked environments its home environment (the one it signed in to)
// offers in its `deviceJoinEnvironmentIds` setting. Each pairing comes over the home
// environment's full-access link, like "Connect" in a linked thread, so no code is typed. What the
// user removes from the device stays removed. See DUHELL.md, "Joining a group of environments".
import { connectLinkedEnvironment } from "@t3tools/client-runtime/linked-thread";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "~/connection/catalog";
import { connectPairing, reachesEnvironment } from "~/connection/onboarding";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { planDeviceJoin } from "./deviceJoin.logic";
import { peerLinkEnvironment } from "./peerLinks";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";

const JOINED_KEY = "t3code:device-join:joined:v1";
const DISMISSED_KEY = "t3code:device-join:dismissed:v1";
const RETRY_MS = 60 * 60_000;
const FOCUS_RETRY_MS = 10 * 60_000;

const readIds = (key: string): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};
const writeIds = (key: string, ids: Iterable<string>) => {
  try {
    window.localStorage.setItem(key, JSON.stringify([...new Set(ids)]));
  } catch {}
};

const offerAtom = Atom.make((get) => {
  const home = get(primaryEnvironmentIdAtom);
  if (home === null) return null;
  const offered = get(serverEnvironment.settingsValueAtom(home))?.deviceJoinEnvironmentIds ?? [];
  return { home, offered };
}).pipe(Atom.withLabel("device-join:offer"));

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.option)).then((result) =>
    result._tag === "Some" ? result.value : null,
  );

async function joinOffered(home: EnvironmentId, offered: ReadonlyArray<EnvironmentId>) {
  if (!appAtomRegistry.get(peerLinkEnvironment.pairClient.permissionAtom(home))) return;
  const saved = new Set<string>(
    appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.keys(),
  );
  const plan = planDeviceJoin({
    home,
    offered,
    saved,
    joined: readIds(JOINED_KEY),
    dismissed: readIds(DISMISSED_KEY),
  });
  writeIds(DISMISSED_KEY, plan.dismissed);
  writeIds(JOINED_KEY, plan.joined);
  for (const environmentId of plan.join) {
    const outcome = await connectLinkedEnvironment({
      label: environmentId,
      requestPairing: () =>
        run(
          peerLinkEnvironment.pairClient.run(appAtomRegistry, {
            environmentId: home,
            input: { environmentId },
          }),
        ),
      reaches: async (host) =>
        (await run(reachesEnvironment.run(appAtomRegistry, { host, environmentId }))) === true,
      pair: async ({ host, pairingCode }) =>
        (await run(
          connectPairing.run(appAtomRegistry, {
            host,
            pairingCode,
            expectedEnvironmentId: environmentId,
          }),
        )) !== null,
    });
    // Out of reach or refused: tried again on the next round.
    if (outcome.type === "connected") writeIds(JOINED_KEY, [...readIds(JOINED_KEY), environmentId]);
  }
}

export function startDeviceJoin(): () => void {
  let running = false;
  let lastRunAt = 0;
  const attempt = () => {
    const offer = appAtomRegistry.get(offerAtom);
    if (running || offer === null || offer.offered.length === 0) return;
    running = true;
    lastRunAt = Date.now();
    void joinOffered(offer.home, offer.offered)
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  };
  const stopOffer = appAtomRegistry.subscribe(offerAtom, attempt, { immediate: true });
  const timer = window.setInterval(attempt, RETRY_MS);
  const onFocus = () => {
    if (Date.now() - lastRunAt >= FOCUS_RETRY_MS) attempt();
  };
  window.addEventListener("focus", onFocus);
  return () => {
    stopOffer();
    window.clearInterval(timer);
    window.removeEventListener("focus", onFocus);
  };
}
