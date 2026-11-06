import { Archive3tz } from './Archive3tz.js';
import { blobSource, httpSource } from './sources.js';

/**
 * A 3DTilesRendererJS plugin that reads a tileset from a .3tz archive,
 * fetching only the parts of the archive that are needed (HTTP Range).
 *
 * The plugin presents the archive as if it were a folder: the archive
 * `https://example.org/site.3tz` is served under `https://example.org/site.3tz/`,
 * its `tileset.json` at `https://example.org/site.3tz/tileset.json`, and each
 * tile at the path it has inside the archive. Relative tile URLs therefore
 * resolve exactly as they do in an unpacked tileset, and the renderer is not
 * aware that an archive is involved.
 *
 * ```js
 * const tiles = new TilesRenderer( 'https://example.org/site.3tz' );
 * tiles.registerPlugin( new Tiles3tzPlugin() );
 * ```
 *
 * For a file already in the browser (file picker, drag and drop):
 *
 * ```js
 * const plugin = new Tiles3tzPlugin();
 * const tiles = new TilesRenderer( plugin.addFile( file ) );
 * tiles.registerPlugin( plugin );
 * ```
 */
export class Tiles3tzPlugin {

	/**
	 * @param {object} [options]
	 * @param {typeof fetch} [options.fetch]  used for the Range requests (default: global fetch)
	 * @param {object} [options.archiveOptions]  passed to `Archive3tz.open` (e.g. `maxEntryBytes`)
	 * @param {number} [options.maxDownloadBytes]  when a server ignores `Range`, the most it may send
	 * @param {boolean} [options.archiveOnly]  answer 403 to every request the renderer makes outside
	 *   the registered archives (for archives from an untrusted source: their tileset.json cannot
	 *   point the browser elsewhere). Default false, as for an unpacked tileset.
	 */
	constructor( options = {} ) {

		this.name = '3TZ_PLUGIN';
		// run before other plugins' fetchData, so archive URLs never reach the network
		this.priority = - 1;
		this.tiles = null;
		this.fetch = options.fetch || null;
		this.archiveOptions = options.archiveOptions || {};
		this.maxDownloadBytes = options.maxDownloadBytes;
		this.archiveOnly = !! options.archiveOnly;
		/** @type {Map<string, Promise<Archive3tz>>} base URL (ending in "/") → archive */
		this.archives = new Map();
		this._fileCount = 0;

	}

	init( tiles ) {

		this.tiles = tiles;

	}

	/**
	 * Register an archive held in a File or Blob. Returns the URL of its
	 * tileset.json, to give to the TilesRenderer.
	 * @param {Blob} blob
	 */
	addFile( blob ) {

		const origin = globalThis.location && /^https?:$/.test( globalThis.location.protocol ) ? globalThis.location.origin : 'https://3tz.invalid';
		const base = `${ origin }/__3tz__/${ ++ this._fileCount }/`;
		this.archives.set( base, Archive3tz.open( blobSource( blob ), this.archiveOptions ) );
		return base + 'tileset.json';

	}

	/**
	 * Register an archive behind a URL. Returns the URL of its tileset.json.
	 * Called for you when the root URL given to the renderer ends in ".3tz".
	 * @param {string} url
	 */
	addURL( url ) {

		const absolute = resolve( url );
		const base = absolute.split( /[?#]/ )[ 0 ] + '/';
		if ( ! this.archives.has( base ) ) {

			const fetchOptions = this.tiles ? this.tiles.fetchOptions : {};
			const source = httpSource( absolute, { fetch: this.fetch || undefined, fetchOptions, maxDownloadBytes: this.maxDownloadBytes } );
			this.archives.set( base, Archive3tz.open( source, this.archiveOptions ) );

		}

		return base + 'tileset.json';

	}

	/** The archive serving `url`, or null. */
	baseFor( url ) {

		for ( const base of this.archives.keys() ) {

			if ( url.startsWith( base ) ) return base;

		}

		return null;

	}

	// renderer hook: a root URL ending in .3tz becomes the URL of its tileset.json
	preprocessURL( url, tile ) {

		if ( tile !== null ) return url;
		const path = String( url ).split( /[?#]/ )[ 0 ];
		return /\.3tz$/i.test( path ) ? this.addURL( String( url ) ) : url;

	}

	// renderer hook: answer requests under an archive's base from the archive
	fetchData( url, options ) {

		const base = this.baseFor( url );
		if ( base === null ) {

			if ( ! this.archiveOnly ) return null;
			return Promise.resolve( new Response( null, { status: 403, statusText: `${ url } is outside the archive (archiveOnly)` } ) );

		}

		const path = decodeURIComponent( url.slice( base.length ).split( /[?#]/ )[ 0 ] );

		return this.archives.get( base ).then( async archive => {

			const bytes = await archive.read( path );
			if ( options && options.signal && options.signal.aborted ) throw new DOMException( 'Aborted', 'AbortError' );
			if ( bytes === null ) return new Response( null, { status: 404, statusText: `${ path } is not in the archive` } );
			return new Response( bytes, { status: 200 } );

		} );

	}

	dispose() {

		this.archives.clear();
		this.tiles = null;

	}

}

function resolve( url ) {

	try {

		return new URL( url, globalThis.location ? globalThis.location.href : undefined ).href;

	} catch {

		return url;

	}

}
