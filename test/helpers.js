// Test helpers: a minimal .3tz writer and an in-memory HTTP server.
import { deflateRawSync } from 'node:zlib';
import { md5 } from '../src/index3tz.js';

const CRC_TABLE = Array.from( { length: 256 }, ( _, n ) => {

	let c = n;
	for ( let k = 0; k < 8; k ++ ) c = c & 1 ? 0xedb88320 ^ ( c >>> 1 ) : c >>> 1;
	return c >>> 0;

} );

function crc32( bytes ) {

	let c = 0xffffffff;
	for ( const b of bytes ) c = CRC_TABLE[ ( c ^ b ) & 0xff ] ^ ( c >>> 8 );
	return ( c ^ 0xffffffff ) >>> 0;

}

/**
 * Write a .3tz in memory.
 * files: [{ path, data: Uint8Array|string, deflate?: boolean, localExtra?: number, storedName?: string }]
 * options: { zip64?: boolean, index?: boolean, compressIndex?: boolean }
 */
export function make3tz( files, options = {} ) {

	const enc = new TextEncoder();
	const chunks = [];
	const central = [];
	const records = [];
	let offset = 0;

	const add = ( { path, data, deflate = false, localExtra = 0, storedName } ) => {

		const raw = typeof data === 'string' ? enc.encode( data ) : data;
		const body = deflate ? new Uint8Array( deflateRawSync( raw ) ) : raw;
		const name = enc.encode( storedName ?? path );
		const header = new Uint8Array( 30 + name.length + localExtra );
		const hv = new DataView( header.buffer );
		hv.setUint32( 0, 0x04034b50, true );
		hv.setUint16( 4, 20, true );
		hv.setUint16( 8, deflate ? 8 : 0, true );
		hv.setUint32( 14, crc32( raw ), true );
		hv.setUint32( 18, body.length, true );
		hv.setUint32( 22, raw.length, true );
		hv.setUint16( 26, name.length, true );
		hv.setUint16( 28, localExtra, true );
		header.set( name, 30 );
		if ( localExtra >= 4 ) {

			hv.setUint16( 30 + name.length, 0xcafe, true ); // an unknown extra block
			hv.setUint16( 32 + name.length, localExtra - 4, true );

		}

		const entry = { name, offset, method: deflate ? 8 : 0, crc: crc32( raw ), csize: body.length, usize: raw.length };
		chunks.push( header, body );
		offset += header.length + body.length;
		central.push( entry );
		return entry;

	};

	for ( const f of files ) {

		const entry = add( f );
		const key = md5( enc.encode( f.path.normalize( 'NFC' ) ) );
		records.push( { key, offset: entry.offset } );

	}

	if ( options.index !== false ) {

		const sortKey = k => {

			const v = new DataView( k.buffer, k.byteOffset, 16 );
			return [ v.getBigUint64( 0, true ), v.getBigUint64( 8, true ) ];

		};

		records.sort( ( a, b ) => {

			const [ a0, a1 ] = sortKey( a.key ), [ b0, b1 ] = sortKey( b.key );
			return a0 < b0 ? - 1 : a0 > b0 ? 1 : a1 < b1 ? - 1 : a1 > b1 ? 1 : 0;

		} );
		const index = new Uint8Array( records.length * 24 );
		const iv = new DataView( index.buffer );
		records.forEach( ( r, i ) => {

			index.set( r.key, i * 24 );
			iv.setBigUint64( i * 24 + 16, BigInt( r.offset ), true );

		} );
		add( { path: '@3dtilesIndex1@', data: index, deflate: !! options.compressIndex } );

	}

	const cdStart = offset;
	for ( const e of central ) {

		const rec = new Uint8Array( 46 + e.name.length );
		const v = new DataView( rec.buffer );
		v.setUint32( 0, 0x02014b50, true );
		v.setUint16( 4, 20, true );
		v.setUint16( 6, 20, true );
		v.setUint16( 10, e.method, true );
		v.setUint32( 16, e.crc, true );
		v.setUint32( 20, e.csize, true );
		v.setUint32( 24, e.usize, true );
		v.setUint16( 28, e.name.length, true );
		v.setUint32( 42, e.offset, true );
		rec.set( e.name, 46 );
		chunks.push( rec );
		offset += rec.length;

	}

	const cdSize = offset - cdStart;

	if ( options.zip64 ) {

		const z = new Uint8Array( 56 + 20 );
		const v = new DataView( z.buffer );
		v.setUint32( 0, 0x06064b50, true );
		v.setBigUint64( 4, 44n, true );
		v.setUint16( 12, 45, true );
		v.setUint16( 14, 45, true );
		v.setBigUint64( 24, BigInt( central.length ), true );
		v.setBigUint64( 32, BigInt( central.length ), true );
		v.setBigUint64( 40, BigInt( cdSize ), true );
		v.setBigUint64( 48, BigInt( cdStart ), true );
		v.setUint32( 56, 0x07064b50, true );
		v.setBigUint64( 64, BigInt( offset ), true );
		v.setUint32( 72, 1, true );
		chunks.push( z );
		offset += z.length;

	}

	const eocd = new Uint8Array( 22 );
	const ev = new DataView( eocd.buffer );
	ev.setUint32( 0, 0x06054b50, true );
	ev.setUint16( 8, options.zip64 ? 0xffff : central.length, true );
	ev.setUint16( 10, options.zip64 ? 0xffff : central.length, true );
	ev.setUint32( 12, options.zip64 ? 0xffffffff : cdSize, true );
	ev.setUint32( 16, options.zip64 ? 0xffffffff : cdStart, true );
	chunks.push( eocd );

	const out = new Uint8Array( chunks.reduce( ( n, c ) => n + c.length, 0 ) );
	let p = 0;
	for ( const c of chunks ) { out.set( c, p ); p += c.length; }
	return out;

}

/**
 * A fetch function serving `bytes` at any URL, counting requests.
 * With { ranges: false } it ignores Range and always sends everything.
 */
export function fakeServer( bytes, { ranges = true } = {} ) {

	const log = [];
	const fetchFn = async ( url, init = {} ) => {

		const range = init.headers && init.headers.Range;
		log.push( { url, range } );
		if ( ! ranges || ! range ) return new Response( bytes.slice(), { status: 200 } );
		let start, end;
		const suffix = /^bytes=-(\d+)$/.exec( range );
		const span = /^bytes=(\d+)-(\d+)$/.exec( range );
		if ( suffix ) { start = Math.max( 0, bytes.length - Number( suffix[ 1 ] ) ); end = bytes.length - 1; }
		else { start = Number( span[ 1 ] ); end = Math.min( bytes.length - 1, Number( span[ 2 ] ) ); }
		return new Response( bytes.slice( start, end + 1 ), {
			status: 206,
			headers: { 'Content-Range': `bytes ${ start }-${ end }/${ bytes.length }` },
		} );

	};

	return { fetch: fetchFn, log };

}

/** A small tileset: tileset.json plus `n` tiles of `size` bytes. */
export function sampleFiles( n = 50, size = 2000 ) {

	const files = [ { path: 'tileset.json', data: JSON.stringify( { asset: { version: '1.1' }, root: { content: { uri: 'tiles/0.glb' } } } ) } ];
	for ( let i = 0; i < n; i ++ ) {

		const data = new Uint8Array( size );
		for ( let k = 0; k < size; k ++ ) data[ k ] = ( i * 31 + k ) & 0xff;
		files.push( { path: `tiles/${ i }.glb`, data } );

	}

	return files;

}
