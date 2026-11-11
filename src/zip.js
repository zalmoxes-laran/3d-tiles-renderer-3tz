/**
 * The small part of the ZIP format a .3tz reader needs.
 *
 * A ZIP file is read from its END. The last record, the "End Of Central
 * Directory" (EOCD), says where the central directory starts and how long
 * it is. The central directory lists every entry: its name, its size, and
 * the offset of its "local header", which sits just before the entry's
 * bytes. Archives over 4 GB (or with more than 65535 entries) use the
 * ZIP64 variant, whose sizes and offsets are 64-bit and live in an extra
 * record just before the EOCD.
 *
 * Reference: PKWARE APPNOTE.TXT, sections 4.3 and 4.5.
 */

const SIG_LOCAL_HEADER = 0x04034b50;
const SIG_CENTRAL_HEADER = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

/** How many bytes to read past an entry's name, in the same request, to
 *  cover the local "extra field". A canonical .3tz has none (20 bytes with
 *  ZIP64); if an archive has a longer one, a second request fetches it. */
export const EXTRA_MARGIN = 64;

/** Paths are compared in Unicode NFC, with forward slashes and no leading
 *  slash, as the 3TZ specification asks (a ZIP made on macOS may store NFD). */
export const normalizePath = p => p.normalize( 'NFC' ).replace( /\\/g, '/' ).replace( /^\/+/, '' );

/** A 64-bit little-endian integer, as a JS number (exact up to 2^53). */
export const readU64 = ( view, at ) => view.getUint32( at, true ) + view.getUint32( at + 4, true ) * 2 ** 32;

const viewOf = bytes => new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );

// a macrotask: timers, input and rendering get their turn
const yieldToPage = () => new Promise( resolve => setTimeout( resolve, 0 ) );

export function concat( a, b ) {

	const out = new Uint8Array( a.length + b.length );
	out.set( a );
	out.set( b, a.length );
	return out;

}

/**
 * Open a ZIP from its end, with as few requests as possible.
 *
 * One read of the last `tailBytes` brings the EOCD, the ZIP64 records when
 * present, and in most tilesets the whole central directory. A longer
 * directory costs one more request; a directory over `maxDirectoryBytes`
 * is not read at all (`directory` is then null) and the caller uses the
 * .3tz index instead.
 *
 * @param {import('./sources.js').ByteSource} source
 * @param {{ tailBytes: number, maxDirectoryBytes: number }} limits
 */
export async function readEnd( source, { tailBytes, maxDirectoryBytes } ) {

	let requests = 1;
	const { bytes: tail, size } = await source.tail( tailBytes );
	const tailStart = size - tail.length;
	const tv = viewOf( tail );

	// The EOCD is 22 bytes plus an optional comment of up to 65535 bytes:
	// scan backwards for its signature.
	let eocd = - 1;
	for ( let i = tail.length - 22, stop = Math.max( 0, tail.length - 22 - 0xffff ); i >= stop; i -- ) {

		if ( tv.getUint32( i, true ) === SIG_EOCD ) {

			eocd = i;
			break;

		}

	}

	if ( eocd < 0 ) throw new Error( 'Not a ZIP file: no end of central directory found.' );

	// Bytes [at, at + length): from the tail when they are inside it.
	const bytesAt = async ( at, length ) => {

		if ( at >= tailStart && at + length <= size ) return tail.subarray( at - tailStart, at - tailStart + length );
		requests ++;
		return source.read( at, length );

	};

	let entries = tv.getUint16( eocd + 10, true );
	let directorySize = tv.getUint32( eocd + 12, true );
	let directoryOffset = tv.getUint32( eocd + 16, true );
	let zip64 = false;
	let zip64RecordOffset = - 1;

	if ( entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff ) {

		// ZIP64: the locator (20 bytes, just before the EOCD) points to the
		// ZIP64 end record, which holds the real values.
		const locator = eocd - 20;
		if ( locator < 0 || tv.getUint32( locator, true ) !== SIG_ZIP64_LOCATOR ) throw new Error( 'ZIP64 archive without its locator.' );
		zip64RecordOffset = readU64( tv, locator + 8 );
		if ( zip64RecordOffset + 56 > tailStart + locator ) throw new Error( 'Damaged ZIP64: its end record is not before its locator.' );
		const record = await bytesAt( zip64RecordOffset, 56 );
		const rv = viewOf( record );
		if ( rv.getUint32( 0, true ) !== SIG_ZIP64_EOCD ) throw new Error( 'ZIP64 end of central directory not found.' );
		entries = readU64( rv, 32 );
		directorySize = readU64( rv, 40 );
		directoryOffset = readU64( rv, 48 );
		zip64 = true;

	}

	// The directory must lie inside the file and end before the records that
	// describe it (the ZIP64 end record, or the EOCD). Values that say
	// otherwise come from a damaged or hostile archive: refused before any
	// further request is made.
	const directoryEnd = directoryOffset + directorySize;
	const recordsStart = zip64 ? zip64RecordOffset : tailStart + eocd;
	if ( ! Number.isSafeInteger( directoryEnd ) || directoryEnd > recordsStart ) {

		throw new Error( 'Damaged ZIP: the central directory does not end before the end records.' );

	}

	let directory = null;
	if ( directoryOffset >= tailStart ) {

		directory = tail.subarray( directoryOffset - tailStart, directoryEnd - tailStart );

	} else if ( directorySize <= maxDirectoryBytes ) {

		// only the directory's own bytes: never more than `directorySize`
		const before = await bytesAt( directoryOffset, Math.min( directorySize, tailStart - directoryOffset ) );
		directory = concat( before, tail.subarray( 0, Math.max( 0, directoryEnd - tailStart ) ) );

	}

	return {
		size, zip64, entries, directory, directorySize,
		// the last `length` bytes of the central directory
		directoryTail: length => bytesAt( directoryEnd - length, length ),
		requests: () => requests,
	};

}

/**
 * @typedef {object} EntryLocation
 * @property {number} offset  where the local header starts
 * @property {number} compressedSize
 * @property {number} nameLength
 * @property {number} method  0 = stored, 8 = deflate
 */

/**
 * Every record of a central directory, as path → location. Also returns the
 * path of the last record, which in a .3tz must be the index.
 *
 * A long directory is read in slices of `yieldEvery` records, and the page is
 * let go between two slices (a `setTimeout`): 16 MB of directory, some
 * 250 000 records, would otherwise hold the main thread about 0.3 s.
 * `yieldEvery: 0` reads it in one piece.
 *
 * @param {Uint8Array} directory
 * @param {{ yieldEvery?: number }} [options]
 * @returns {Promise<{ entries: Map<string, EntryLocation>, lastPath: string }>}
 */
export async function parseDirectory( directory, { yieldEvery = 0 } = {} ) {

	const view = viewOf( directory );
	const decoder = new TextDecoder();
	const entries = new Map();
	let lastPath = '';
	let records = 0;

	let p = 0;
	while ( p + 46 <= directory.length && view.getUint32( p, true ) === SIG_CENTRAL_HEADER ) {

		if ( yieldEvery > 0 && ++ records % yieldEvery === 0 ) await yieldToPage();

		const method = view.getUint16( p + 10, true );
		let compressedSize = view.getUint32( p + 20, true );
		let uncompressedSize = view.getUint32( p + 24, true );
		const nameLength = view.getUint16( p + 28, true );
		const extraLength = view.getUint16( p + 30, true );
		const commentLength = view.getUint16( p + 32, true );
		let offset = view.getUint32( p + 42, true );
		const path = normalizePath( decoder.decode( directory.subarray( p + 46, p + 46 + nameLength ) ) );

		// ZIP64 values sit in extra field 0x0001, in this order, present only
		// for the fields set to 0xffffffff above.
		if ( uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff ) {

			let q = p + 46 + nameLength;
			const end = q + extraLength;
			while ( q + 4 <= end ) {

				const tag = view.getUint16( q, true );
				const length = view.getUint16( q + 2, true );
				if ( tag === 0x0001 ) {

					let r = q + 4;
					if ( uncompressedSize === 0xffffffff ) { uncompressedSize = readU64( view, r ); r += 8; }
					if ( compressedSize === 0xffffffff ) { compressedSize = readU64( view, r ); r += 8; }
					if ( offset === 0xffffffff ) offset = readU64( view, r );
					break;

				}

				q += 4 + length;

			}

		}

		if ( ! path.endsWith( '/' ) ) entries.set( path, { offset, compressedSize, nameLength, method } );
		lastPath = path;
		p += 46 + nameLength + extraLength + commentLength;

	}

	return { entries, lastPath };

}

/**
 * The bytes of one entry, given where its local header is.
 *
 * When the compressed size is known (from the central directory) this is
 * ONE request: the local header, the name, a small margin for the extra
 * field, and the data. When it is not known (found through the .3tz index)
 * the first request also takes `guessBytes` of data, and a larger entry
 * costs a second request.
 *
 * The name written in the local header must be the one asked for: this
 * guards against a hash collision in the index or a damaged directory.
 *
 * @param {import('./sources.js').ByteSource} source
 * @param {string} path
 * @param {number} offset
 * @param {EntryLocation | null} known
 * @param {number} guessBytes
 * @param {number} [maxEntryBytes]  the most an entry may take, compressed or
 *   once decompressed: a larger one is refused (a damaged or hostile archive,
 *   a "zip bomb")
 */
export async function readEntryAt( source, path, offset, known, guessBytes, maxEntryBytes = Infinity ) {

	const wanted = normalizePath( path );
	const tooLarge = what => new Error( `${ path }: ${ what } is over the limit of ${ maxEntryBytes } bytes (maxEntryBytes).` );
	if ( known && known.compressedSize > maxEntryBytes ) throw tooLarge( 'its size' );
	const nameLength = known ? known.nameLength : new TextEncoder().encode( wanted ).length;
	const first = 30 + nameLength + EXTRA_MARGIN + ( known ? known.compressedSize : guessBytes );

	let buffer = await source.read( offset, first );
	const ensure = async n => {

		if ( buffer.length < n ) buffer = concat( buffer, await source.read( offset + buffer.length, n - buffer.length ) );

	};

	await ensure( 30 );
	let view = viewOf( buffer );
	if ( view.getUint32( 0, true ) !== SIG_LOCAL_HEADER ) throw new Error( `${ path }: no local header at offset ${ offset }.` );

	const flags = view.getUint16( 6, true );
	const method = view.getUint16( 8, true );
	const localNameLength = view.getUint16( 26, true );
	const localExtraLength = view.getUint16( 28, true );
	const dataStart = 30 + localNameLength + localExtraLength;

	let compressedSize;
	if ( known ) {

		compressedSize = known.compressedSize;

	} else {

		await ensure( dataStart );
		view = viewOf( buffer );
		compressedSize = view.getUint32( 18, true );
		if ( compressedSize === 0xffffffff ) {

			for ( let q = 30 + localNameLength; q + 4 <= dataStart; ) {

				const tag = view.getUint16( q, true );
				const length = view.getUint16( q + 2, true );
				// extra 0x0001 in a local header holds both sizes: uncompressed, then compressed
				if ( tag === 0x0001 ) { compressedSize = readU64( view, q + 12 ); break; }
				q += 4 + length;

			}

		}

		if ( ( flags & 0x8 ) && ! compressedSize ) throw new Error( `${ path }: sizes stored after the data (not a canonical .3tz).` );

	}

	if ( compressedSize > maxEntryBytes ) throw tooLarge( 'its size' );
	await ensure( dataStart + compressedSize );

	const name = normalizePath( new TextDecoder().decode( buffer.subarray( 30, 30 + localNameLength ) ) );
	if ( name !== wanted ) throw new Error( `Asked for ${ path }, found ${ name } at offset ${ offset }.` );

	const data = buffer.subarray( dataStart, dataStart + compressedSize );
	if ( method === 0 ) return data;
	if ( method === 8 ) return inflateRaw( data, maxEntryBytes, () => tooLarge( 'its decompressed size' ) );
	throw new Error( `${ path }: compression method ${ method } is not supported (only stored and deflate).` );

}

// Inflate, stopping as soon as the output passes `limit` bytes: a few KB
// of deflate can expand to gigabytes, so the size is checked while reading.
async function inflateRaw( data, limit, error ) {

	const reader = new Blob( [ data ] ).stream().pipeThrough( new DecompressionStream( 'deflate-raw' ) ).getReader();
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
