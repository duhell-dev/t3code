# duhell build of T3 Code

This branch (`duhell`) is a fork build of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).
`main` mirrors upstream. Every push to `duhell` builds a release for Linux x64 and Windows x64
(`.github/workflows/duhell-release.yml`). Windows files are built on Linux and not test-started on
Windows.

## Runner

Both workflows run on a self-hosted runner with the labels `self-hosted, linux, x64, t3code-runner`
(a fresh container per job, registered for this repository only). Until it is online, jobs wait in
the queue. Every build runs upstream code and its npm dependencies, so:

- Build jobs have read-only permissions and get no secrets.
- `SYNC_TOKEN` is only used by the `sync` job and the release `tag` job. Both run git and the
  GitHub API only, no install, no build, no script from the repository. Keep it that way.
- In the release workflow only `publish` may write (`contents: write`). It uploads the built files and runs
  no repository code.
- Workflows from fork pull requests always need approval.

## Upstream sync

`.github/workflows/sync-upstream.yml` runs every 2 hours (at :07). It mirrors upstream
into `main`, merges `main` into `duhell` and pushes, which starts a release build. It needs the
`SYNC_TOKEN` secret (fine-grained, this repository only, Contents and Workflows read/write);
without it, upstream changes under `.github/workflows/` cannot be pushed and the run opens an issue
instead. A merge conflict also opens an issue and changes nothing.

## Release notes

The read-only `notes` job writes each release's description with `scripts/duhell-release-notes.ts`.
It collects the highlights (`- **Title.** Sentence`) of every upstream nightly whose commit the
build contains and that the previous fork release did not list yet, plus the fork's own
highlights; fix counts and changelogs are left out. The newest upstream nightly covered is kept in
an HTML comment at the end of the description, so the next release starts after it.

A fork commit adds its own highlight with a trailer, one sentence after a short title:

    Highlight: Provider switch lines. A failover shows one line with the account names.

Only commits made directly on `duhell` count, not merges from `main`. Clients show these
highlights before a server update and once after the app moves to a new version.

## Update check in the browser

A browser has no desktop updater, and upstream offers a server update only when the open client
is newer than the server. So the web client reads this fork's release list itself
(`apps/web/src/state/forkReleases.ts`, without a token, once per load, then hourly while visible
and on focus after 15 minutes). The newest release on the client's channel becomes the update
target when it is newer than the client: the update button, Settings → Connections and the server
that served the page all offer it. A failed read leaves the target at the client's build. Once
the server that served the page runs a newer build, the page reloads into it after any update run
there has finished, once per build. The desktop app keeps using its own updater.

## Joining a group of environments

Three pieces let a device reach every environment of a group without pairing codes:

- **Sign in with Tailscale.** A server started with `T3CODE_TAILSCALE_SIGN_IN_LOGINS` (comma-separated
  Tailscale logins) offers this on its pairing page. Behind Tailscale Serve it checks the device with
  `tailscale whois`: an untagged node of an allowed login gets a one-minute pairing for that browser.
  The server's own node is always refused, since every local process reaches Serve from it; more
  nodes can be refused with `T3CODE_TAILSCALE_SIGN_IN_REFUSE_NODES`.
- **Device join.** The server setting `deviceJoinEnvironmentIds` lists linked environments a device
  signed in to this server joins by itself, each paired over this server's full-access link
  (`apps/web/src/state/deviceJoin.ts`). Only listed environments are joined, whatever else the
  server links to. An environment the user removes from a device is not joined again.
- **Browser sessions renew.** A browser cookie session moves 30 days out when the page checks its
  session, at most once a day, like a peer link in use. Revoking it still ends it.

Operating notes are kept outside this repository.
