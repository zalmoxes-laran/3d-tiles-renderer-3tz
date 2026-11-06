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

[.3tz](https://github.com/Maxar-Public/3tz-specification) packs a tileset into a single ZIP file. That file ends with an index, so a reader can find any tile without unpacking the archive. It is a community format, not an OGC or Cesium standard, and 3DTilesRendererJS does not include it in its core. This plugin adds it from the outside, in a separate repository, as the 3DTilesRendererJS maintainer suggested ([#722](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/722), [#1568](https://github.com/NASA-AMMOS/3DTilesRendererJS/pull/1568)).

We use it in cultural heritage work, where tilesets live in object-storage buckets next to the rest of a project's data. In that setting one tileset as one object is easier to handle than thousands of small files:

- **Fewer objects.** A bucket that limits the number or type of objects is not filled up by tiles.
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

The code is in five short files:

| File | What it does |
|---|---|
| `src/sources.js` | where the bytes come from: a `Blob`, or a URL with `Range` |
| `src/zip.js` | the part of the ZIP format a reader needs |
| `src/index3tz.js` | the `@3dtilesIndex1@` index and MD5 |
| `src/Archive3tz.js` | opens an archive and reads an entry |
| `src/Tiles3tzPlugin.js` | the 3DTilesRendererJS plugin |

There are no runtime dependencies.

## Requirements and limits

- **Server.** It must answer `Range` requests. For a different origin, CORS must allow the `Range` header and expose `Content-Range`. S3-compatible stores such as MinIO and RustFS, nginx and Apache do this.
- **Archive.** It must be a .3tz whose last entry is the uncompressed index, as the specification asks. A plain ZIP of a tileset is refused, with a clear message.
- **Supported content.** Entries may be stored or deflate-compressed, ZIP64 archives are supported, and paths are compared in Unicode NFC (so archives made on macOS work).
- **Not supported.** Encryption, multi-disk archives, and compression methods other than deflate.

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
- rejection of archives that are not .3tz.

## How this was written

The reader began inside EMStudio, the Extended Matrix editor developed at CNR-ISPC within the StratiGraph project, and was extracted from it for this repository. It was written with the help of an AI coding assistant (Claude, by Anthropic), tested on real archives (the numbers above), and is maintained by the author, who is responsible for it. Questions and issues are welcome here, in this repository.

## Licence

MIT — see `LICENSE`. To cite it, see `CITATION.cff`.

## Credits

Emanuel Demetrescu, CNR-ISPC (Istituto di Scienze del Patrimonio Culturale), Digital Heritage Innovation Lab.
