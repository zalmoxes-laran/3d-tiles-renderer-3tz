# 3d-tiles-renderer-3tz

A plugin for [3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) that reads a 3D Tiles tileset straight from a **.3tz** archive. You don't need to unpack the archive. The plugin only fetches the tiles the renderer asks for, using HTTP `Range` requests.

```js
import { TilesRenderer } from '3d-tiles-renderer';
import { Tiles3tzPlugin } from '3d-tiles-renderer-3tz';

const tiles = new TilesRenderer( 'https://example.org/site.3tz' );
tiles.registerPlugin( new Tiles3tzPlugin() );
```

A file already in the browser, from a file picker or a drag and drop, works the same way:

```js
const plugin = new Tiles3tzPlugin();
const tiles = new TilesRenderer( plugin.addFile( file ) );
tiles.registerPlugin( plugin );
```

## Why

[.3tz](https://github.com/Maxar-Public/3tz-specification) packs a tileset into a single ZIP file. That file ends with an index, so a reader can find any tile without unpacking the archive. It is a community format, not an OGC or Cesium standard, and 3DTilesRendererJS does not include it in its core. This plugin adds it from the outside, in a separate repository, as the 3DTilesRendererJS maintainer suggested ([#722](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/722), [#1568](https://github.com/NASA-AMMOS/3DTilesRendererJS/pull/1568)). When the format was proposed in 2020 ([CesiumGS/3d-tiles#422](https://github.com/CesiumGS/3d-tiles/issues/422)), one of its requirements was a single file, easy to transfer and kind to systems that struggle with many files: that is exactly our need.

We use it in cultural heritage work, within the StratiGraph project, where tilesets live in the object-storage buckets of the European Collaborative Cloud for Cultural Heritage, next to the rest of a project's data. There a bucket holds fewer than a million objects, and a single photogrammetric survey can count hundreds of thousands of tiles (one of ours, a single temple, has 236,607). One tileset as one object is therefore easier to handle than thousands of small files:

- **Fewer objects.** A survey takes one object in the bucket instead of hundreds of thousands.
- **One thing to describe.** A single file can carry a checksum, a version and a licence, and can be the subject of statements in a knowledge graph.
- **Same speed as a folder.** Reading it this way costs the same number of requests as reading the unpacked folder (see *Measurements*).

## How it works

The plugin makes the archive look like a folder. The archive `https://example.org/site.3tz` is served under the address `https://example.org/site.3tz/`:

- its `tileset.json` is at `https://example.org/site.3tz/tileset.json`;
- every tile is at the path it has inside the archive.

So relative tile URLs resolve exactly as they would in an unpacked tileset, and the renderer is unaware of the archive. The plugin uses two renderer hooks:

- `preprocessURL`: a root URL ending in `.3tz` becomes the URL of its `tileset.json`;
- `fetchData`: a request under an archive's address is answered from the archive. Other requests are left to the renderer.

Reading the archive takes three steps.

1. **Opening.** A ZIP file is read from its end. One request asks for the last 256 KB of the archive. Those bytes hold the "end of central directory" record, the ZIP64 records when the archive has them, and for most tilesets the whole central directory: the list of entries, each with its size and position. A longer directory costs one more request.
2. **A tile.** The central directory gives the tile's position and size. One request then fetches its local header, its name and its data together. Stored and deflate-compressed entries are supported.
3. **Very large archives.** When the central directory is over 16 MB (about 250 000 files), the plugin does not read it. It reads instead the archive's index, `@3dtilesIndex1@`, which the .3tz specification places as the last entry: a sorted list of the MD5 hash of each path and the position of its entry. A tile is then found by binary search. Its first request also asks for 64 KB of data, and a larger tile needs a second request.

If the server ignores `Range` and returns the whole file, the plugin keeps that single download and serves tiles from it. Each archive is then transferred once, as a plain download would be.

A long central directory is read in slices of 16 384 records (`yieldEvery`), and the page is let go between two slices: a directory of 16 MB does not freeze the page while it is read.

The code is in five short files, with their type declarations:

| File | What it does |
|---|---|
| `src/sources.js` | where the bytes come from: a `Blob`, or a URL with `Range` |
| `src/zip.js` | the part of the ZIP format a reader needs |
| `src/index3tz.js` | the `@3dtilesIndex1@` index and MD5 |
| `src/Archive3tz.js` | opens an archive and reads an entry |
| `src/Tiles3tzPlugin.js` | the 3DTilesRendererJS plugin |
| `src/index.d.ts` | the TypeScript declarations |

There are no runtime dependencies.

## Reading an archive without the plugin

`Archive3tz` reads an archive on its own, for an application that wants the files rather than a rendered tileset:

```js
import { Archive3tz, httpSource, blobSource } from '3d-tiles-renderer-3tz';

const source = httpSource( 'https://example.org/site.3tz' );
const archive = await Archive3tz.open( source );
const tileset = await archive.read( 'tileset.json' ); // Uint8Array, or null if absent
archive.has( 'tiles/0.glb' );                        // true or false, no request
archive.names();                                     // every path, or null (see below)
archive.info;                                        // { files, lookup, openRequests, zip64 }
```

- **`names()`** lists every file when the archive was opened through its central directory. When it was opened through the index (a directory over `maxDirectoryBytes`), it returns `null`: the index finds a path but cannot list them.
- **A plain ZIP**, without `@3dtilesIndex1@` (a tileset zipped by hand), opens with `Archive3tz.open( source, { requireIndex: false } )`. Its entries are found through the central directory, with the same limits as a .3tz. If its directory is over `maxDirectoryBytes` and it has no index, the directory is read whole, up to `maxEntryBytes`.
- **Errors of `httpSource`** carry `range`, the `Range` header that was asked (`'bytes=0-1023'`, or `'bytes=-262144'` for the end of the file), and `status` when a response came. A network failure is passed on as it is, with `range` added.
- **`source.stats()`** says how many requests and bytes were made. For HTTP it also gives the `url`, the `etag` of the first response that had one (a key for a tile cache), and `pending`, the ranges asked and not yet answered.
- **`normalizePath`** (NFC, `/`, no leading `/`) is the rule the archive compares paths with; `INDEX_NAME` is `'@3dtilesIndex1@'`.
- **Defaults** are exported: `DEFAULT_TAIL_BYTES` (256 KB), `DEFAULT_MAX_DIRECTORY_BYTES` (16 MB), `DEFAULT_GUESS_BYTES` (64 KB), `DEFAULT_MAX_ENTRY_BYTES` (256 MB), `DEFAULT_YIELD_EVERY` (16 384 records), `DEFAULT_MAX_DOWNLOAD_BYTES` (1 GiB).

A source is any object with `tail( length )`, `read( offset, length )` and `stats()` (the `ByteSource` type in `src/index.d.ts`), so an application can read archives from somewhere else.

## Requirements and limits

- **Server.** It must answer `Range` requests. For a different origin, CORS must allow the `Range` header and expose `Content-Range`. S3-compatible stores such as MinIO and RustFS, nginx and Apache do this.
- **Archive.** By default it must be a .3tz whose last entry is the uncompressed index, as the specification asks; a plain ZIP of a tileset is refused, with a clear message. With `requireIndex: false` (in `archiveOptions` for the plugin) a plain ZIP is read too.
- **Supported content.** Entries may be stored or deflate-compressed, ZIP64 archives are supported, and paths are compared in Unicode NFC (so archives made on macOS work).
- **Not supported.** Encryption, multi-disk archives, and compression methods other than deflate.

## Archives from an untrusted source

An archive can be damaged, or built on purpose to harm whoever opens it. The reader checks what an archive says before it acts on it:

- **The central directory** must lie inside the file and end before the records that describe it; otherwise the archive is refused before any further request. When the directory is read, the request covers its declared size and no more.
- **Each entry** may take at most `maxEntryBytes` (256 MB by default), compressed or once decompressed. Decompression stops as soon as the limit is passed, so a "zip bomb" of a few kilobytes cannot fill the browser's memory. Real tiles are far smaller.
- **The index** may not be larger than the archive's entries need (24 bytes each), nor than `maxEntryBytes`.
- **Each answer to a `Range` request** must say, in `Content-Range`, the very range that was asked for, and its body is read up to that length and no further: a server that sends more than it was asked cannot fill the memory either.
- **A server that ignores `Range`** sends the whole archive; the reader keeps it up to `maxDownloadBytes` (1 GiB by default) and refuses it beyond.

```js
const plugin = new Tiles3tzPlugin( {
	archiveOptions: { maxEntryBytes: 64 * 1024 * 1024 },
	maxDownloadBytes: 256 * 1024 * 1024,
	archiveOnly: true,
} );
```

A tileset can also point to files outside the archive (an external tileset, a tile on another server), exactly as an unpacked tileset can. By default those requests are left to the renderer. With `archiveOnly: true` the plugin answers 403 to every request the renderer makes outside the registered archives. This covers what the renderer fetches (tiles, external tilesets); resources that a glTF loader fetches by itself, such as a texture referenced by URL inside a glTF, follow the loader's own settings.

The example page pins the three.js and 3DTilesRendererJS files it loads from the CDN with Subresource Integrity hashes, so the browser refuses a file whose content has changed.

## Measurements

The test was a synthetic tileset of 3000 tiles of 58 KB each, served with 20 ms of simulated latency and 6 requests at a time. It compares this reader with an earlier version of it that used three requests per tile.

| | Earlier reader | This reader | Unpacked folder |
|---|---|---|---|
| Total time | 37.0 s | 12.6 s | 13.1–13.7 s |
| Requests | 9008 | 3002 | 3001 |
| Opening | 106 ms | 22 ms | – |
| First tile | 240 ms | 65 ms | – |

On a real photogrammetric tileset (Templu Mare, Sarmizegetusa Regia: 7302 entries, 199 MB), loading 9 tiles took 12 requests instead of 35, and the first tile arrived in 94 ms instead of 240 ms.

A large archive, read over HTTP with `Range` from a local server: the 2013 survey of the same temple, 6.5 GB, 236 607 entries, ZIP64 with entries beyond the 4 GB mark. It opens with 2 requests in about 40 ms through the `@3dtilesIndex1@` index, and each file (the first, one in the middle, the last at 6.55 GB) comes with a single request, byte-identical to what Python's `zipfile` extracts.

Reading that archive's whole central directory (16.8 MB, which `names()` needs, with `maxDirectoryBytes: Infinity`) held Node's event loop for 102 ms at most in one piece, and for 12 ms at most in slices of 16 384 records.

Note for testing in Node: `fs.openAsBlob` (Node 22) reports a wrong size for files over 4 GB, so a Blob made that way cannot be read past that point. Browsers' `File` objects and HTTP are not affected.

## Example

`example/index.html` loads three.js and 3DTilesRendererJS from a CDN. You can give it a URL, as `?url=…/site.3tz`, or pick a file from your disk. Serve the repository folder with any static server and open `example/`.

## Tests

```sh
npm test
```

The tests use Node 18 or later and need no installed packages. They build small .3tz archives in memory and serve them through a fake server that counts requests. They cover:

- one request to open and one request per tile;
- a directory longer than the first read;
- the index path;
- deflate, ZIP64, and long local extra fields;
- names stored in NFD;
- a server without `Range`;
- rejection of archives that are not .3tz, and plain ZIPs read with `requireIndex: false` (a zip bomb inside one is still refused);
- `names()`, through the directory and through the index;
- a directory of 50 000 records read in slices, with a timer that keeps running;
- `normalizePath` and `INDEX_NAME`; `status` and `range` on source errors; the ETag and the pending ranges in `stats()`; every export declared in `index.d.ts`;
- the limits for untrusted archives: a zip bomb, an entry over the size limit (through the directory and through the index), a directory that does not end where it should, a directory offset moved back, the whole-file fallback over its limit, an index over the entry limit, a `206` answer that is not the range asked for or is longer than it, and `archiveOnly`.

## How this was written

The reader began inside EMStudio, the Extended Matrix editor developed at CNR-ISPC within the StratiGraph project, and was extracted from it for this repository. It was written with the help of an AI coding assistant (Claude, by Anthropic), tested on real archives (the numbers above), and is maintained by the author, who is responsible for it. Questions and issues are welcome here, in this repository.

## Licence

MIT — see `LICENSE`. To cite it, see `CITATION.cff`.

## Credits

Emanuel Demetrescu, CNR-ISPC (Istituto di Scienze del Patrimonio Culturale), Digital Heritage Innovation Lab.
