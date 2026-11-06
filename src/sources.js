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
 * @typedef {object} ByteSource
 * @property {(length: number) => Promise<{ bytes: Uint8Array, size: number }>} tail
 * @property {(offset: number, length: number) => Promise<Uint8Array>} read
 * @property {() => { kind: 'blob' | 'http', ranges: boolean | null, requests: number, bytes: number }} stats
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

/**
 * @param {string} url
 * @param {{ fetch?: typeof fetch, fetchOptions?: RequestInit }} [options]
 * @returns {ByteSource}
 */
export function httpSource( url, options = {} ) {

	const fetchFn = options.fetch || globalThis.fetch.bind( globalThis );
	const baseOptions = options.fetchOptions || {};

	let whole = null; // the full archive, when the server ignored Range
	let ranges = null; // true once a 206 came back, false after a 200
	let size = null;
	let requests = 0;
	let bytes = 0;

	// Ask for a byte range. Returns the bytes for a 206, or null after a 200
	// (in which case `whole` now holds the entire archive).
	const ask = async ( range ) => {

		requests ++;
		const headers = { ...( baseOptions.headers || {} ), Range: range };
		const res = await fetchFn( url, { ...baseOptions, headers } );

		if ( res.status === 206 ) {

			ranges = true;
			const match = /\/(\d+)\s*$/.exec( res.headers.get( 'content-range' ) || '' );
			if ( match ) size = Number( match[ 1 ] );
			const out = new Uint8Array( await res.arrayBuffer() );
			bytes += out.byteLength;
			return out;

		}

		if ( ! res.ok ) throw new Error( `${ url }: HTTP ${ res.status }` );

		ranges = false;
		whole = new Uint8Array( await res.arrayBuffer() );
		bytes += whole.byteLength;
		size = whole.byteLength;
		return null;

	};

	return {
		async tail( length ) {

			if ( ! whole ) {

				// a "suffix" range: the last `length` bytes, and the total size
				// in the Content-Range header
				const out = await ask( `bytes=-${ length }` );
				if ( out ) {

					if ( size === null ) throw new Error( `${ url }: the server did not say the file size` );
					return { bytes: out, size };

				}

			}

			return { bytes: whole.subarray( Math.max( 0, whole.byteLength - length ) ), size: whole.byteLength };

		},
		async read( offset, length ) {

			if ( ! whole ) {

				const out = await ask( `bytes=${ offset }-${ offset + length - 1 }` );
				if ( out ) return out;

			}

			return whole.subarray( offset, offset + length );

		},
		stats: () => ( { kind: 'http', ranges, requests, bytes } ),
	};

}
