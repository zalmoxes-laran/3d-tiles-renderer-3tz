// What 0.3.0 adds: names(), plain ZIPs, a directory read in slices, the
// exported helpers, structured source errors, the ETag and pending ranges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as pkg from '../src/index.js';
import { parseDirectory } from '../src/zip.js';
import { make3tz, fakeServer, sampleFiles } from './helpers.js';

const { Archive3tz, blobSource, httpSource, normalizePath, INDEX_NAME } = pkg;
const URL3TZ = 'https://example.org/data/site.3tz';
const text = bytes => new TextDecoder().decode( bytes );

test( 'names(): every path through the central directory, null through the index', async () => {

	const bytes = make3tz( sampleFiles( 2 ) );
	const archive = await Archive3tz.open( blobSource( new Blob( [ bytes ] ) ) );
	assert.deepEqual( archive.names(), [ 'tileset.json', 'tiles/0.glb', 'tiles/1.glb' ] );
	assert.ok( ! archive.names().includes( INDEX_NAME ) );

	const byIndex = await Archive3tz.open( blobSource( new Blob( [ bytes ] ) ), { maxDirectoryBytes: 10, tailBytes: 100 } );
	assert.equal( byIndex.info.lookup, 'index' );
	assert.equal( byIndex.names(), null );

} );

test( 'requireIndex: false opens a plain zip through its central directory', async () => {

	const files = sampleFiles( 5 ).map( ( f, i ) => ( { ...f, deflate: i % 2 === 0 } ) );
	const server = fakeServer( make3tz( files, { index: false } ) );
	const archive = await Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch } ), { requireIndex: false } );
	assert.equal( archive.info.lookup, 'central-directory' );
	assert.equal( archive.info.files, 6 );
	assert.equal( server.log.length, 1 );
	for ( const f of files.slice( 1 ) ) assert.deepEqual( await archive.read( f.path ), f.data );
	assert.match( text( await archive.read( 'tileset.json' ) ), /"version":"1.1"/ );

	// a canonical .3tz opens the same way, its index left out of the names
	const canonical = await Archive3tz.open( blobSource( new Blob( [ make3tz( files ) ] ) ), { requireIndex: false } );
	assert.equal( canonical.names().length, 6 );

	// by default a plain zip is still refused
	await assert.rejects( Archive3tz.open( blobSource( new Blob( [ make3tz( files, { index: false } ) ] ) ) ), /last entry is not @3dtilesIndex1@/ );

} );

test( 'requireIndex: false keeps the limits: a bomb inside a plain zip is refused', async () => {

	const bomb = new Uint8Array( 8 * 1024 * 1024 );
	const bytes = make3tz( [ { path: 'tileset.json', data: '{}' }, { path: 'bomb.glb', data: bomb, deflate: true } ], { index: false } );
	const archive = await Archive3tz.open( blobSource( new Blob( [ bytes ] ) ), { requireIndex: false, maxEntryBytes: 1024 * 1024 } );
	await assert.rejects( archive.read( 'bomb.glb' ), /decompressed size is over the limit/ );
	assert.equal( ( await archive.read( 'tileset.json' ) ).length, 2 );

} );

test( 'requireIndex: false, a directory over maxDirectoryBytes and no index: the directory is read whole, within maxEntryBytes', async () => {

	const files = sampleFiles( 40 );
	const server = fakeServer( make3tz( files, { index: false } ) );
	const archive = await Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch } ), { requireIndex: false, maxDirectoryBytes: 10, tailBytes: 300 } );
	assert.equal( archive.info.lookup, 'central-directory' );
	assert.equal( archive.names().length, 41 );
	assert.deepEqual( await archive.read( 'tiles/39.glb' ), files[ 40 ].data );

	await assert.rejects(
		Archive3tz.open( blobSource( new Blob( [ make3tz( files, { index: false } ) ] ) ), { requireIndex: false, maxDirectoryBytes: 10, tailBytes: 300, maxEntryBytes: 100 } ),
		/central directory .* is over the limit/ );

	// with an index, a large directory is still read through the index
	const indexed = await Archive3tz.open( blobSource( new Blob( [ make3tz( files ) ] ) ), { requireIndex: false, maxDirectoryBytes: 10, tailBytes: 300 } );
	assert.equal( indexed.info.lookup, 'index' );

} );

// a plain zip of `n` tiny entries, and its central directory
function bigDirectory( n ) {

	const files = Array.from( { length: n }, ( _, i ) => ( { path: `t/${ i }.glb`, data: 'x' } ) );
	const bytes = make3tz( files, { index: false } );
	const v = new DataView( bytes.buffer );
	const size = v.getUint32( bytes.length - 22 + 12, true );
	const offset = v.getUint32( bytes.length - 22 + 16, true );
	return bytes.subarray( offset, offset + size );

}

test( 'parseDirectory lets the page go every `yieldEvery` records', async () => {

	const directory = bigDirectory( 50000 );
	const run = async yieldEvery => {

		let ticks = 0, on = true, last = performance.now(), longest = 0;
		const tick = () => {

			if ( ! on ) return;
			const now = performance.now();
			longest = Math.max( longest, now - last );
			last = now;
			ticks ++;
			setTimeout( tick, 0 );

		};

		setTimeout( tick, 0 );
		const { entries } = await parseDirectory( directory, { yieldEvery } );
		on = false;
		longest = Math.max( longest, performance.now() - last );
		assert.equal( entries.size, 50000 );
		return { ticks, longest };

	};

	const whole = await run( 0 );
	assert.equal( whole.ticks, 0, 'in one piece, no timer runs' );
	const sliced = await run( 5000 );
	assert.ok( sliced.ticks >= 9, `${ sliced.ticks } turns of the timer` );
	assert.ok( sliced.longest < 50, `the timer waited ${ sliced.longest.toFixed( 1 ) } ms at most` );

} );

test( 'normalizePath and INDEX_NAME are exported', () => {

	assert.equal( INDEX_NAME, '@3dtilesIndex1@' );
	assert.equal( normalizePath( 'tiles/città.glb' ), 'tiles/città.glb' );
	assert.equal( normalizePath( '\\tiles\\0.glb' ), 'tiles/0.glb' );
	assert.equal( normalizePath( '//tileset.json' ), 'tileset.json' );

} );

test( 'httpSource errors carry status and range', async () => {

	const notFound = async () => new Response( null, { status: 404 } );
	const e404 = await httpSource( URL3TZ, { fetch: notFound } ).read( 100, 50 ).catch( e => e );
	assert.equal( e404.status, 404 );
	assert.equal( e404.range, 'bytes=100-149' );
	assert.match( e404.message, /HTTP 404/ );

	const offline = async () => { throw new TypeError( 'fetch failed' ); };
	const eNet = await httpSource( URL3TZ, { fetch: offline } ).tail( 1024 ).catch( e => e );
	assert.ok( eNet instanceof TypeError, 'the network error itself, not a wrapper' );
	assert.equal( eNet.range, 'bytes=-1024' );
	assert.equal( eNet.status, undefined );

	// an answer that does not match the range: status 206, the range asked
	const wrong = async () => new Response( new Uint8Array( 10 ), { status: 206, headers: { 'Content-Range': 'bytes 0-9/1000' } } );
	const eBad = await httpSource( URL3TZ, { fetch: wrong } ).read( 500, 10 ).catch( e => e );
	assert.equal( eBad.status, 206 );
	assert.equal( eBad.range, 'bytes=500-509' );

	// Archive3tz.open lets them through
	const eOpen = await Archive3tz.open( httpSource( URL3TZ, { fetch: notFound } ) ).catch( e => e );
	assert.equal( eOpen.status, 404 );
	assert.equal( eOpen.range, 'bytes=-262144' );

} );

test( 'stats(): the url, the ETag of the first response, the ranges still pending', async () => {

	const server = fakeServer( make3tz( sampleFiles( 3 ) ) );
	let release;
	const gate = new Promise( r => { release = r; } );
	let held = false;
	const fetchFn = async ( url, init ) => {

		const res = await server.fetch( url, init );
		if ( held ) await gate;
		const headers = new Headers( res.headers );
		headers.set( 'ETag', '"v1"' );
		return new Response( res.body, { status: res.status, headers } );

	};

	const source = httpSource( URL3TZ, { fetch: fetchFn } );
	assert.equal( source.stats().etag, null );
	const archive = await Archive3tz.open( source );
	assert.equal( source.stats().etag, '"v1"' );
	assert.equal( source.stats().url, URL3TZ );
	assert.deepEqual( source.stats().pending, [] );

	held = true;
	const reading = archive.read( 'tiles/1.glb' );
	await new Promise( r => setTimeout( r, 5 ) );
	assert.equal( source.stats().pending.length, 1 );
	assert.match( source.stats().pending[ 0 ], /^bytes=\d+-\d+$/ );
	release();
	await reading;
	assert.deepEqual( source.stats().pending, [] );

} );

test( 'every runtime export is declared in index.d.ts', () => {

	const dts = readFileSync( new URL( '../src/index.d.ts', import.meta.url ), 'utf8' );
	for ( const name of Object.keys( pkg ) ) {

		assert.match( dts, new RegExp( `export (declare )?(class|function|const) ${ name }\\b` ), name );

	}

	assert.match( dts, /export interface ByteSource\b/ );
	assert.equal( typeof pkg.DEFAULT_MAX_DOWNLOAD_BYTES, 'number' );
	assert.equal( pkg.DEFAULT_YIELD_EVERY, 16384 );

} );
