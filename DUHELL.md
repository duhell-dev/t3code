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

Operating notes are kept outside this repository.
