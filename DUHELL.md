# duhell build of T3 Code

This branch (`duhell`) is a fork build of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).
`main` mirrors upstream. Every push to `duhell` builds a release for Linux x64 and Windows x64
(`.github/workflows/duhell-release.yml`).

## Upstream sync

`.github/workflows/sync-upstream.yml` runs every 30 minutes (at :07 and :37). It mirrors upstream
into `main`, merges `main` into `duhell` and pushes, which starts a release build. It needs the
`SYNC_TOKEN` secret (fine-grained, this repository only, Contents and Workflows read/write);
without it, upstream changes under `.github/workflows/` cannot be pushed and the run opens an issue
instead. A merge conflict also opens an issue and changes nothing.

## Updating the installs

Nothing updates itself. On pc1 the self-update timer (`t3up.timer`) is off: a new fork build is
installed by hand, and only while no agents are working. When the private T3 gets a new version,
`t3-duell-nachziehen.path` brings the Duell T3 to the same version. pc2 is updated through its
homelab orchestrator.

Other operating notes are kept outside this repository.
