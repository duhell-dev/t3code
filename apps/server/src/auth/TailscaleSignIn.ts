// duhell: signs a device in with the Tailscale identity Tailscale Serve vouches for, instead of a
// pairing code. Off unless T3CODE_TAILSCALE_SIGN_IN_LOGINS names the logins that may sign in.
// The server's own node is always refused: every local process (other OS users included) reaches
// Serve from it and would carry the node owner's login.
import * as NodeNet from "node:net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

const TAILSCALE_SIGN_IN_PATH = "/api/auth/tailscale";
const TAILSCALE_SIGN_IN_LOGINS_ENV = "T3CODE_TAILSCALE_SIGN_IN_LOGINS";
const TAILSCALE_SIGN_IN_REFUSE_NODES_ENV = "T3CODE_TAILSCALE_SIGN_IN_REFUSE_NODES";
// Redeemed right away by the browser it is handed to.
const SIGN_IN_PAIRING_TTL = Duration.minutes(1);
const TAILSCALE_TIMEOUT = Duration.seconds(5);

export interface TailscaleWhois {
  readonly nodeId: string;
  /** The node's MagicDNS name without the trailing dot, e.g. `laptop.example.ts.net`. */
  readonly nodeName: string;
  readonly tags: ReadonlyArray<string>;
  /** Tailnet addresses without their prefix length. */
  readonly addresses: ReadonlyArray<string>;
  readonly login: string | null;
}

export interface TailscaleSelf {
  readonly nodeId: string | null;
  readonly addresses: ReadonlyArray<string>;
}

export type TailscaleSignInDecision =
  | { readonly type: "allow"; readonly nodeName: string }
  | { readonly type: "refuse"; readonly reason: string };

/** A comma-separated environment variable as a list of trimmed, non-empty, lower-case entries. */
export function parseListEnv(value: string | undefined): ReadonlyArray<string> {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

const shortName = (nodeName: string) => nodeName.split(".")[0] ?? nodeName;

/**
 * Whether the device behind this request may sign in. Every check fails closed: without a known
 * own node, a whois answer or a matching login, the device is refused.
 */
export function decideTailscaleSignIn(input: {
  /** The TCP peer is loopback, so the request came through Tailscale Serve on this machine. */
  readonly peerIsLoopback: boolean;
  /** `Tailscale-User-Login` as Serve set it. */
  readonly headerLogin: string | undefined;
  /** The device's tailnet address, the last `X-Forwarded-For` entry Serve appended. */
  readonly clientIp: string | undefined;
  readonly whois: TailscaleWhois | null;
  readonly self: TailscaleSelf | null;
  readonly allowedLogins: ReadonlyArray<string>;
  readonly refuseNodes: ReadonlyArray<string>;
}): TailscaleSignInDecision {
  const refuse = (reason: string) => ({ type: "refuse", reason }) as const;
  if (input.allowedLogins.length === 0) return refuse("Tailscale sign-in is off on this server.");
  if (!input.peerIsLoopback) return refuse("The request did not come through Tailscale Serve.");
  const headerLogin = input.headerLogin?.trim().toLowerCase();
  if (!headerLogin || !input.clientIp) return refuse("Tailscale did not identify this device.");
  if (input.self === null) return refuse("This server could not read its own Tailscale node.");
  if (input.whois === null) return refuse("Tailscale could not identify this device.");
  const { whois, self } = input;
  if (
    (self.nodeId !== null && whois.nodeId === self.nodeId) ||
    whois.addresses.some((address) => self.addresses.includes(address)) ||
    self.addresses.includes(input.clientIp)
  ) {
    return refuse("The server's own machine cannot sign in this way.");
  }
  if (whois.tags.length > 0) return refuse("Tagged devices cannot sign in this way.");
  const login = whois.login?.trim().toLowerCase();
  if (!login || login !== headerLogin) return refuse("The device's Tailscale login did not match.");
  if (!input.allowedLogins.includes(login)) {
    return refuse("This Tailscale login may not sign in here.");
  }
  const refused = new Set(input.refuseNodes);
  if (
    refused.has(whois.nodeName.toLowerCase()) ||
    refused.has(shortName(whois.nodeName).toLowerCase()) ||
    whois.addresses.some((address) => refused.has(address))
  ) {
    return refuse("This device may not sign in this way.");
  }
  return { type: "allow", nodeName: shortName(whois.nodeName) };
}

const stripPrefix = (address: string) => address.split("/")[0] ?? address;
const stringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const WhoisJson = Schema.Struct({
  Node: Schema.Struct({
    ID: Schema.Unknown,
    Name: Schema.optional(Schema.Unknown),
    ComputedName: Schema.optional(Schema.Unknown),
    Tags: Schema.optional(Schema.Unknown),
    Addresses: Schema.optional(Schema.Unknown),
  }),
  UserProfile: Schema.optional(Schema.Struct({ LoginName: Schema.optional(Schema.Unknown) })),
});
const decodeWhois = Schema.decodeUnknownOption(Schema.fromJsonString(WhoisJson));

/** `tailscale whois --json` output, or null when it is not a node this version can read. */
export function parseTailscaleWhois(stdout: string): TailscaleWhois | null {
  const parsed = decodeWhois(stdout);
  if (parsed._tag === "None") return null;
  const { Node: node, UserProfile: profile } = parsed.value;
  const nodeId = typeof node.ID === "string" || typeof node.ID === "number" ? String(node.ID) : "";
  const rawName =
    typeof node.Name === "string" && node.Name.length > 0
      ? node.Name
      : typeof node.ComputedName === "string"
        ? node.ComputedName
        : "";
  const nodeName = rawName.replace(/\.$/u, "");
  if (nodeId === "" || nodeName === "") return null;
  return {
    nodeId,
    nodeName,
    tags: stringList(node.Tags),
    addresses: stringList(node.Addresses).map(stripPrefix),
    login: typeof profile?.LoginName === "string" ? profile.LoginName : null,
  };
}

const StatusJson = Schema.Struct({
  Self: Schema.optional(
    Schema.Struct({
      ID: Schema.optional(Schema.Unknown),
      TailscaleIPs: Schema.optional(Schema.Unknown),
    }),
  ),
});
const decodeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(StatusJson));

/** This machine's node from `tailscale status --json`, or null when it has none. */
export function parseTailscaleSelf(stdout: string): TailscaleSelf | null {
  const parsed = decodeStatus(stdout);
  if (parsed._tag === "None" || parsed.value.Self === undefined) return null;
  const self = parsed.value.Self;
  const addresses = stringList(self.TailscaleIPs).map(stripPrefix);
  const nodeId =
    typeof self.ID === "string" || typeof self.ID === "number" ? String(self.ID) : null;
  if (nodeId === null && addresses.length === 0) return null;
  return { nodeId, addresses };
}

const isLoopback = (address: string | undefined) =>
  address !== undefined &&
  ((NodeNet.isIPv4(address) && address.startsWith("127.")) ||
    address === "::1" ||
    address === "::ffff:127.0.0.1");

function peerAddress(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const source = request.source as {
    readonly socket?: { readonly remoteAddress?: string | null };
    readonly remoteAddress?: string | null;
  } | null;
  return source?.socket?.remoteAddress ?? source?.remoteAddress ?? undefined;
}

const runTailscale = Effect.fn("TailscaleSignIn.runTailscale")(
  function* (args: ReadonlyArray<string>) {
    const runner = yield* ProcessRunner.ProcessRunner;
    const result = yield* runner.run({
      command: "tailscale",
      args,
      timeout: TAILSCALE_TIMEOUT,
      timeoutBehavior: "timedOutResult",
    });
    return result.code === 0 ? result.stdout : null;
  },
  Effect.orElseSucceed(() => null),
);

const noStore = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export const layer = HttpRouter.add(
  "GET",
  TAILSCALE_SIGN_IN_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const environment = yield* HostProcess.Environment;
    const allowedLogins = parseListEnv(environment[TAILSCALE_SIGN_IN_LOGINS_ENV]);
    const url = new URL(request.url, "http://localhost");
    if (url.searchParams.get("check") === "1") {
      return yield* HttpServerResponse.json(
        { available: allowedLogins.length > 0 },
        { headers: noStore },
      );
    }
    const peer = peerAddress(request);
    const forwarded = request.headers["x-forwarded-for"]?.split(",").at(-1)?.trim();
    const clientIp = forwarded && NodeNet.isIP(forwarded) !== 0 ? forwarded : undefined;
    const enabled = allowedLogins.length > 0;
    const whoisOut =
      enabled && clientIp ? yield* runTailscale(["whois", "--json", clientIp]) : null;
    const statusOut = enabled ? yield* runTailscale(["status", "--json"]) : null;
    const decision = decideTailscaleSignIn({
      peerIsLoopback: isLoopback(peer),
      headerLogin: request.headers["tailscale-user-login"],
      clientIp,
      whois: whoisOut === null ? null : parseTailscaleWhois(whoisOut),
      self: statusOut === null ? null : parseTailscaleSelf(statusOut),
      allowedLogins,
      refuseNodes: parseListEnv(environment[TAILSCALE_SIGN_IN_REFUSE_NODES_ENV]),
    });
    if (decision.type === "refuse") {
      yield* Effect.logWarning("Refused a Tailscale sign-in.", {
        reason: decision.reason,
        client: clientIp,
      });
      return HttpServerResponse.text(decision.reason, { status: 403, headers: noStore });
    }
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const link = yield* auth.createPairingLink({
      ttl: SIGN_IN_PAIRING_TTL,
      label: `${decision.nodeName} · Tailscale`,
    });
    yield* Effect.logInfo("Signed in a device with its Tailscale identity.", {
      node: decision.nodeName,
      client: clientIp,
    });
    // The fragment never reaches a server; the pairing page redeems it in this browser.
    return HttpServerResponse.empty({
      status: 302,
      headers: { ...noStore, location: `/pair#token=${encodeURIComponent(link.credential)}` },
    });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("Tailscale sign-in failed.", { cause }).pipe(
        Effect.as(HttpServerResponse.text("Tailscale sign-in failed.", { status: 500 })),
      ),
    ),
  ),
);
