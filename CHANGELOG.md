# Changelog

## 0.3.0 — unreleased

Everything of 0.2.0 works as before.

- `Archive3tz#names()`: the path of every file when the archive was opened through its central directory, `null` when opened through the index.
- `Archive3tz.open( source, { requireIndex: false } )` reads a plain ZIP, without `@3dtilesIndex1@`, with the same limits as a .3tz. A plain ZIP whose directory is over `maxDirectoryBytes` and has no index has its directory read whole, up to `maxEntryBytes`.
- The central directory is read in slices of `yieldEvery` records (default 16 384), with the page let go between two slices. `yieldEvery: 0` reads it in one piece, as 0.2.0 did.
- Exported: `normalizePath`, `INDEX_NAME`, and the defaults `DEFAULT_TAIL_BYTES`, `DEFAULT_MAX_DIRECTORY_BYTES`, `DEFAULT_GUESS_BYTES`, `DEFAULT_MAX_ENTRY_BYTES`, `DEFAULT_YIELD_EVERY`, `DEFAULT_MAX_DOWNLOAD_BYTES`.
- Errors of `httpSource` carry `range` (the `Range` header asked) and, when a response came, `status`. A network failure keeps its own type, with `range` added.
- `httpSource( … ).stats()` also gives `url`, `etag` (of the first response that had one) and `pending` (the ranges asked and not yet answered).
- TypeScript declarations in `src/index.d.ts` (`types` in `package.json`), with the `ByteSource` and `SourceStats` types.
- The `Archive3tz` constructor's `guessBytes` defaults to `DEFAULT_GUESS_BYTES`.

## 0.2.0 — 2026-11-06

- Limits for archives from an untrusted source: the central directory's bounds, `maxEntryBytes` on each entry and on inflation, the index size, `Content-Range` checked against the range asked, `maxDownloadBytes` when a server ignores `Range`, and the plugin's `archiveOnly`.

## 0.1.0 — 2026-11-06

- First version: a .3tz read in 3DTilesRendererJS with HTTP `Range` requests (one to open, one per tile), the `@3dtilesIndex1@` index for very large archives, tests and an example.
