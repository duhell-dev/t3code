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

Operating notes are kept outside this repository.
