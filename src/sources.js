/**
 * Where the bytes of an archive come from.
 *
 * A source answers two questions: "give me the last N bytes, and tell me
 * how long the file is" (`tail`) and "give me N bytes from this offset"
 * (`read`). Everything else in this package is built on those two.
 *
 * - `blobSource`: a File or Blob already in the browser (a drag and drop,
 *   a file picker). Reads are `Blob.slice`, nothing goes on the network.
 * - `httpSource`: a URL. Reads are HTTP `Range` requests. If the server
 *   ignores `Range` and answers 200 with the whole file, the source keeps
 *   that single download and slices it from then on: the archive is then
 *   transferred once, as a plain download would be.
 *
 * An error of `httpSource` (an HTTP status, a network failure, an answer
 * that does not match the range) carries `range`, the `Range` header asked
 * (`'bytes=a-b'` or `'bytes=-n'`), and `status` when a response came.
 *
 * @typedef {object} ByteSource
 * @property {(length: number) => Promise<{ bytes: Uint8Array, size: number }>} tail
 * @property {(offset: number, length: number) => Promise<Uint8Array>} read
 * @property {() => SourceStats} stats
 */

/**
 * @typedef {object} SourceStats
 * @property {'blob' | 'http'} kind
 * @property {boolean | null} ranges  whether the server honoured `Range` (null before the first answer)
 * @property {number} requests
 * @property {number} bytes  received so far
 * @property {string} [url]  http only
 * @property {string | null} [etag]  http only: the ETag of the first response that had one
 * @property {string[]} [pending]  http only: the ranges asked and not yet answered
 */

/**
 * @param {Blob} blob
 * @returns {ByteSource}
 */
export function blobSource( blob ) {

	let requests = 0;
	let bytes = 0;

	const read = async ( offset, length ) => {

		requests ++;
		const end = Math.min( blob.size, offset + length );
		const out = new Uint8Array( await blob.slice( offset, end ).arrayBuffer() );
		bytes += out.byteLength;
		return out;

	};

	return {
		async tail( length ) {

			const start = Math.max( 0, blob.size - length );
			return { bytes: await read( start, blob.size - start ), size: blob.size };

		},
		read,
		stats: () => ( { kind: 'blob', ranges: true, requests, bytes } ),
	};

}

/** When a server ignores `Range`, the most this source will download and
 *  keep in memory before refusing (1 GiB). */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 2 ** 30;

/**
 * @param {string} url
 * @param {{ fetch?: typeof fetch, fetchOptions?: RequestInit, maxDownloadBytes?: number }} [options]
 *   `maxDownloadBytes`: the limit on the whole-file fallback, when the server ignores `Range`
 * @returns {ByteSource}
 */
export function httpSource( url, options = {} ) {

	const fetchFn = options.fetch || globalThis.fetch.bind( globalThis );
	const maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
	const baseOptions = options.fetchOptions || {};

	let whole = null; // the full archive, when the server ignored Range
	let ranges = null; // true once a 206 came back, false after a 200
	let size = null;
	let requests = 0;
	let bytes = 0;
	let etag = null;
	const pending = new Set();

	// Every error leaves with the range asked and, when a response came, its
	// status: a log can then say which bytes did not arrive.
	const ask = async ( range, wanted ) => {

		requests ++;
		pending.add( range );
		let status;
		try {

			return await answer( range, wanted, s => { status = s; } );

		} catch ( error ) {

			const e = error !== null && typeof error === 'object' ? error : new Error( `${ url }: ${ error }` );
			try {

				if ( ! ( 'range' in e ) ) e.range = range;
				if ( status !== undefined && ! ( 'status' in e ) ) e.status = status;

			} catch { /* a frozen error stays as it is */ }

			throw e;

		} finally {

			pending.delete( range );

		}

	};

	// Ask for a byte range. Returns the bytes for a 206, or null after a 200
	// (in which case `whole` now holds the entire archive). A 206 must say,
	// in Content-Range, the very range asked for (a suffix range: at most
	// `suffix` bytes ending at the end of the file), and its body is read up
	// to that length and no further.
	const answer = async ( range, { offset = null, length = null, suffix = null }, setStatus ) => {

		const headers = { ...( baseOptions.headers || {} ), Range: range };
		const res = await fetchFn( url, { ...baseOptions, headers } );
		setStatus( res.status );
		if ( etag === null && res.headers.get( 'etag' ) ) etag = res.headers.get( 'etag' );

		if ( res.status === 206 ) {

			ranges = true;
			const match = /^bytes (\d+)-(\d+)\/(\d+)\s*$/.exec( res.headers.get( 'content-range' ) || '' );
			const bad = () => new Error( `${ url }: the answer to Range ${ range } does not match it (Content-Range: ${ res.headers.get( 'content-range' ) }).` );
			if ( ! match ) {

				if ( res.body ) await res.body.cancel();
				throw bad();

			}

			const [ start, end, total ] = match.slice( 1 ).map( Number );
			const expected = suffix !== null ? Math.min( suffix, total ) : Math.min( length, total - offset );
			const ok = end >= start && end - start + 1 === expected && ( suffix !== null ? end === total - 1 : start === offset );
			if ( ! ok ) {

				if ( res.body ) await res.body.cancel();
				throw bad();

			}

			size = total;
			const out = await readCapped( res, expected, bad );
			if ( out.byteLength !== expected ) throw bad();
			bytes += out.byteLength;
			return out;

		}

		if ( ! res.ok ) throw new Error( `${ url }: HTTP ${ res.status }` );

		ranges = false;
		whole = await readCapped( res, maxDownloadBytes, () => new Error(
			`${ url }: the server ignored Range and sent the whole file, which is over the limit of ${ maxDownloadBytes } bytes (maxDownloadBytes).` ) );
		bytes += whole.byteLength;
		size = whole.byteLength;
		return null;

	};

	return {
		async tail( length ) {

			if ( ! whole ) {

				// a "suffix" range: the last `length` bytes, and the total size
				// in the Content-Range header
				const out = await ask( `bytes=-${ length }`, { suffix: length } );
				if ( out ) {

					if ( size === null ) throw new Error( `${ url }: the server did not say the file size` );
					return { bytes: out, size };

				}

			}

			return { bytes: whole.subarray( Math.max( 0, whole.byteLength - length ) ), size: whole.byteLength };

		},
		async read( offset, length ) {

			if ( ! whole ) {

				const out = await ask( `bytes=${ offset }-${ offset + length - 1 }`, { offset, length } );
				if ( out ) return out;

			}

			return whole.subarray( offset, offset + length );

		},
		stats: () => ( { kind: 'http', ranges, requests, bytes, url, etag, pending: [ ...pending ] } ),
	};

}

// The body of a response, refused as soon as it passes `limit` bytes (its
// declared length first, then what actually arrives).
async function readCapped( res, limit, error ) {

	const declared = Number( res.headers.get( 'content-length' ) );
	if ( declared > limit ) {

		if ( res.body ) await res.body.cancel();
		throw error();

	}

	if ( ! res.body ) {

		const out = new Uint8Array( await res.arrayBuffer() );
		if ( out.byteLength > limit ) throw error();
		return out;

	}

	const reader = res.body.getReader();
	const parts = [];
	let total = 0;
	for ( ;; ) {

		const { done, value } = await reader.read();
		if ( done ) break;
		total += value.length;
		if ( total > limit ) {

			await reader.cancel();
			throw error();

		}

		parts.push( value );

	}

	const out = new Uint8Array( total );
	let at = 0;
	for ( const part of parts ) { out.set( part, at ); at += part.length; }
	return out;

}
