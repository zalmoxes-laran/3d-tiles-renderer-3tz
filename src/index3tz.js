/**
 * The .3tz index, `@3dtilesIndex1@`.
 *
 * The 3TZ specification asks that the last entry of the archive be an index
 * that finds any file without reading the central directory: one 24-byte
 * record per file, made of the MD5 hash of the file's path (16 bytes) and the
 * offset of its local header (8 bytes, little-endian). Records are sorted by
 * the hash read as two 64-bit little-endian numbers, so a file is found by
 * binary search.
 *
 * This reader uses the index only for archives whose central directory is
 * too large to read cheaply (by default over 16 MB, i.e. some 250 000 files);
 * for the others the central directory is faster, because it also gives each
 * entry's size and so lets a tile be read in a single request.
 *
 * Reference: https://github.com/Maxar-Public/3tz-specification
 */

export const INDEX_NAME = '@3dtilesIndex1@';
export const RECORD_BYTES = 24;

/**
 * Find the local-header offset of a path in the index, or null.
 *
 * @param {Uint8Array} index
 * @param {string} normalizedPath
 */
export function lookup( index, normalizedPath ) {

	const key = md5( new TextEncoder().encode( normalizedPath ) );
	const view = new DataView( index.buffer, index.byteOffset, index.byteLength );
	let lo = 0;
	let hi = index.length / RECORD_BYTES - 1;
	while ( lo <= hi ) {

		const mid = ( lo + hi ) >> 1;
		const c = compareKey( index, mid * RECORD_BYTES, key );
		if ( c === 0 ) return view.getUint32( mid * RECORD_BYTES + 16, true ) + view.getUint32( mid * RECORD_BYTES + 20, true ) * 2 ** 32;
		if ( c < 0 ) lo = mid + 1;
		else hi = mid - 1;

	}

	return null;

}

// Compare two 16-byte keys as two uint64 little-endian numbers: for each
// 8-byte half, the most significant byte is the last one.
function compareKey( a, at, b ) {

	for ( const half of [ 0, 8 ] ) {

		for ( let i = 7; i >= 0; i -- ) {

			const x = a[ at + half + i ];
			const y = b[ half + i ];
			if ( x !== y ) return x - y;

		}

	}

	return 0;

}

// MD5 (RFC 1321). Here only to compute index keys: it is not used for
// security. Kept inline so the package has no dependencies.
const K = Array.from( { length: 64 }, ( _, i ) => Math.floor( Math.abs( Math.sin( i + 1 ) ) * 2 ** 32 ) >>> 0 );
const SHIFTS = [ 7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21 ];

export function md5( bytes ) {

	const n = bytes.length;
	const padded = new Uint8Array( ( ( n + 8 ) >>> 6 << 6 ) + 64 );
	padded.set( bytes );
	padded[ n ] = 0x80;
	const dv = new DataView( padded.buffer );
	dv.setUint32( padded.length - 8, ( n * 8 ) >>> 0, true );
	dv.setUint32( padded.length - 4, Math.floor( n / 0x20000000 ), true );

	let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
	for ( let off = 0; off < padded.length; off += 64 ) {

		let a = a0, b = b0, c = c0, d = d0;
		for ( let i = 0; i < 64; i ++ ) {

			let f, g;
			if ( i < 16 ) { f = ( b & c ) | ( ~ b & d ); g = i; }
			else if ( i < 32 ) { f = ( d & b ) | ( ~ d & c ); g = ( 5 * i + 1 ) % 16; }
			else if ( i < 48 ) { f = b ^ c ^ d; g = ( 3 * i + 5 ) % 16; }
			else { f = c ^ ( b | ~ d ); g = ( 7 * i ) % 16; }
			const tmp = d;
			d = c;
			c = b;
			const x = ( a + f + K[ i ] + dv.getUint32( off + g * 4, true ) ) >>> 0;
			const s = SHIFTS[ ( i >> 4 ) * 4 + ( i % 4 ) ];
			b = ( b + ( ( x << s ) | ( x >>> ( 32 - s ) ) ) ) >>> 0;
			a = tmp;

		}

		a0 = ( a0 + a ) >>> 0;
		b0 = ( b0 + b ) >>> 0;
		c0 = ( c0 + c ) >>> 0;
		d0 = ( d0 + d ) >>> 0;

	}

	const out = new Uint8Array( 16 );
	const ov = new DataView( out.buffer );
	[ a0, b0, c0, d0 ].forEach( ( v, i ) => ov.setUint32( i * 4, v, true ) );
	return out;

}
