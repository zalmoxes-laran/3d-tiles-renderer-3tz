import { readEnd, parseDirectory, readEntryAt, normalizePath } from './zip.js';
import { INDEX_NAME, RECORD_BYTES, lookup } from './index3tz.js';

/** How much of the end of the archive the first request asks for. It holds
 *  the EOCD and, for most tilesets, the whole central directory (3000 tiles
 *  take about 190 KB). */
export const DEFAULT_TAIL_BYTES = 256 * 1024;

/** Above this size the central directory is not read; the index is. */
export const DEFAULT_MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;

/** Through the index the entry size is unknown before its local header:
 *  the first request takes this much data along with the header. */
export const DEFAULT_GUESS_BYTES = 64 * 1024;

/** The most a single entry may take, compressed or once decompressed. Real
 *  tiles are far smaller; the limit stops a damaged or hostile archive from
 *  filling the browser's memory. */
export const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;

/** Records of the central directory read between two yields to the page
 *  (see `parseDirectory`). 0: the directory is read in one piece. */
export const DEFAULT_YIELD_EVERY = 16384;

/**
 * A .3tz archive opened for reading, one entry at a time.
 *
 * ```js
 * const archive = await Archive3tz.open( httpSource( 'https://example.org/site.3tz' ) );
 * const tileset = await archive.read( 'tileset.json' );
 * ```
 */
export class Archive3tz {

	/**
	 * @param {import('./sources.js').ByteSource} source
	 * @param {{ tailBytes?: number, maxDirectoryBytes?: number, guessBytes?: number, maxEntryBytes?: number,
	 *   requireIndex?: boolean, yieldEvery?: number }} [options]
	 *   `requireIndex: false` also opens a plain ZIP, without `@3dtilesIndex1@`
	 *   (a tileset zipped by hand): its entries are found through the central
	 *   directory, with the same limits as a .3tz.
	 */
	static async open( source, options = {} ) {

		const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
		const maxDirectoryBytes = options.maxDirectoryBytes ?? DEFAULT_MAX_DIRECTORY_BYTES;
		const guessBytes = options.guessBytes ?? DEFAULT_GUESS_BYTES;
		const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
		const requireIndex = options.requireIndex ?? true;
		const yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY;
		const end = await readEnd( source, { tailBytes, maxDirectoryBytes } );

		// the whole central directory: path → location of every entry
		const byDirectory = async ( directory, requests ) => {

			const { entries, lastPath } = await parseDirectory( directory, { yieldEvery } );
			if ( requireIndex ) checkIndexEntry( lastPath, entries.get( INDEX_NAME ) );
			entries.delete( INDEX_NAME );
			return new Archive3tz( source, { entries, index: null, guessBytes, maxEntryBytes, openRequests: requests, zip64: end.zip64 } );

		};

		if ( end.directory ) return byDirectory( end.directory, end.requests() );

		// The central directory is too large: read only its last record (the
		// index entry), then the index itself.
		let location;
		try {

			const { entries, lastPath } = await parseDirectory( await findLastRecord( end, INDEX_NAME ) );
			location = entries.get( INDEX_NAME );
			checkIndexEntry( lastPath, location );

		} catch ( error ) {

			// A plain ZIP has no index to fall back on (or not a usable one):
			// its directory is read whole, held to the limit of any one entry.
			if ( requireIndex || ! error.noIndex ) throw error;
			if ( end.directorySize > maxEntryBytes ) throw new Error( `The ZIP's central directory (${ end.directorySize } bytes) is over the limit of ${ maxEntryBytes } bytes (maxEntryBytes), and there is no ${ INDEX_NAME } to read instead.` );
			const directory = await end.directoryTail( end.directorySize );
			return byDirectory( directory, end.requests() );

		}

		// the index holds 24 bytes per file: never more than the archive has entries
		if ( location.compressedSize > end.entries * RECORD_BYTES ) throw new Error( `Damaged .3tz: ${ INDEX_NAME } is larger than its ${ end.entries } entries need.` );
		const index = await readEntryAt( source, INDEX_NAME, location.offset, location, 0, maxEntryBytes );
		if ( index.length % RECORD_BYTES !== 0 ) throw new Error( 'The .3tz index length is not a multiple of 24.' );
		return new Archive3tz( source, { entries: null, index, guessBytes, maxEntryBytes, openRequests: end.requests() + 1, zip64: end.zip64 } );

	}

	constructor( source, { entries, index, guessBytes = DEFAULT_GUESS_BYTES, maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES, openRequests, zip64 } ) {

		this.source = source;
		this._entries = entries;
		this._index = index;
		this._guessBytes = guessBytes;
		this._maxEntryBytes = maxEntryBytes;
		/** How the archive was opened: useful for logs and tests. */
		this.info = {
			files: entries ? entries.size : index.length / RECORD_BYTES,
			lookup: entries ? 'central-directory' : 'index',
			openRequests,
			zip64,
		};

	}

	/**
	 * The path of every file in the archive (folders and the index left out),
	 * when it was opened through its central directory; null when it was
	 * opened through the index, which finds a path but does not list them.
	 * @returns {string[] | null}
	 */
	names() {

		return this._entries ? [ ...this._entries.keys() ] : null;

	}

	/** True when the archive holds `path`. */
	has( path ) {

		const p = normalizePath( path );
		return this._entries ? this._entries.has( p ) : lookup( this._index, p ) !== null;

	}

	/**
	 * The bytes of `path`, or null when the archive does not hold it.
	 * @param {string} path
	 * @returns {Promise<Uint8Array | null>}
	 */
	async read( path ) {

		const p = normalizePath( path );
		if ( this._entries ) {

			const location = this._entries.get( p );
			return location ? readEntryAt( this.source, p, location.offset, location, 0, this._maxEntryBytes ) : null;

		}

		const offset = lookup( this._index, p );
		return offset === null ? null : readEntryAt( this.source, p, offset, null, Math.min( this._guessBytes, this._maxEntryBytes ), this._maxEntryBytes );

	}

}

function checkIndexEntry( lastPath, location ) {

	const noIndex = message => Object.assign( new Error( message ), { noIndex: true } );
	if ( lastPath !== INDEX_NAME || ! location ) throw noIndex( `Not a .3tz: the last entry is not ${ INDEX_NAME }.` );
	if ( location.method !== 0 ) throw noIndex( `Not a .3tz: ${ INDEX_NAME } must be stored without compression.` );

}

// The last central-directory record whose name is `name`, with everything
// after it. The index record is short (no extra field in a canonical .3tz),
// so 1 KB from the end of the directory is normally enough.
async function findLastRecord( end, name ) {

	const wanted = new TextEncoder().encode( name );
	const search = bytes => {

		const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
		for ( let i = bytes.length - 46; i >= 0; i -- ) {

			if ( view.getUint32( i, true ) !== 0x02014b50 ) continue;
			const length = view.getUint16( i + 28, true );
			if ( length === wanted.length && bytes.subarray( i + 46, i + 46 + length ).every( ( x, k ) => x === wanted[ k ] ) ) return i;

		}

		return - 1;

	};

	for ( const length of [ 1024, 46 + wanted.length + 0xffff ] ) {

		const bytes = await end.directoryTail( Math.min( end.directorySize, length ) );
		const at = search( bytes );
		if ( at >= 0 ) return bytes.subarray( at );
		if ( bytes.length >= end.directorySize ) break;

	}

	throw Object.assign( new Error( `Not a .3tz: the last entry is not ${ INDEX_NAME }.` ), { noIndex: true } );

}
