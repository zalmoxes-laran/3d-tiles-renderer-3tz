// Archives from an untrusted source: the limits that keep a damaged or
// hostile .3tz from filling the browser's memory or the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Archive3tz, Tiles3tzPlugin, httpSource } from '../src/index.js';
import { make3tz, fakeServer, sampleFiles } from './helpers.js';

const URL3TZ = 'https://example.org/data/site.3tz';

// the EOCD's directory size (offset 12) and offset (16), rewritten
function withDirectory( bytes, { size, offset } ) {

	const out = bytes.slice();
	const v = new DataView( out.buffer );
	const eocd = out.length - 22;
	if ( size !== undefined ) v.setUint32( eocd + 12, size, true );
	if ( offset !== undefined ) v.setUint32( eocd + 16, offset, true );
	return out;

}

test( 'a zip bomb is stopped while it inflates', async () => {

	const bomb = new Uint8Array( 8 * 1024 * 1024 ); // 8 MB of zeros: about 8 KB deflated
	const server = fakeServer( make3tz( [ { path: 'tileset.json', data: '{}' }, { path: 'bomb.glb', data: bomb, deflate: true } ] ) );
	const archive = await Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch } ), { maxEntryBytes: 1024 * 1024 } );
	await assert.rejects( archive.read( 'bomb.glb' ), /decompressed size is over the limit/ );
	assert.equal( ( await archive.read( 'tileset.json' ) ).length, 2, 'the other entries still read' );

} );

test( 'an entry larger than the limit is refused before it is downloaded', async () => {

	const server = fakeServer( make3tz( sampleFiles( 3, 5000 ) ) );
	const archive = await Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch } ), { maxEntryBytes: 1000 } );
	const before = server.log.length;
	await assert.rejects( archive.read( 'tiles/1.glb' ), /its size is over the limit/ );
	assert.equal( server.log.length, before, 'no request made' );

} );

test( 'the same limit holds through the index, where sizes are known only from the local header', async () => {

	const server = fakeServer( make3tz( sampleFiles( 3, 5000 ) ) );
	const archive = await Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch } ), { maxDirectoryBytes: 10, tailBytes: 300, maxEntryBytes: 1000 } );
	assert.equal( archive.info.lookup, 'index' );
	await assert.rejects( archive.read( 'tiles/1.glb' ), /its size is over the limit/ );

} );

test( 'a directory that does not end before the end records is refused, with no more requests', async () => {

	const bytes = make3tz( sampleFiles( 200 ) );
	const server = fakeServer( withDirectory( bytes, { size: 0xfffffff0 } ) );
	await assert.rejects( Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch } ), { tailBytes: 1024 } ), /Damaged ZIP/ );
	assert.equal( server.log.length, 1 );

} );

test( 'a directory offset moved back asks for no more than the declared directory size', async () => {

	const bytes = make3tz( sampleFiles( 200 ) );
	const v = new DataView( bytes.buffer );
	const size = v.getUint32( bytes.length - 22 + 12, true );
	// an offset far before the real directory: the gap to the tail is much larger than `size`
	const server = fakeServer( withDirectory( bytes, { offset: 0 } ) );
	await assert.rejects( Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch } ), { tailBytes: 1024 } ) );
	assert.equal( server.log.length, 2 );
	const [ , a, b ] = /bytes=(\d+)-(\d+)/.exec( server.log[ 1 ].range ).map( Number );
	assert.ok( b - a + 1 <= size, `asked ${ b - a + 1 } bytes, the directory says ${ size }` );

} );

test( 'a server that ignores Range: the whole-file fallback has a limit', async () => {

	const server = fakeServer( make3tz( sampleFiles( 20 ) ), { ranges: false } );
	await assert.rejects(
		Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch, maxDownloadBytes: 10000 } ) ),
		/ignored Range.*over the limit/ );

} );

test( 'plugin: archiveOnly answers 403 outside the archives', async () => {

	const server = fakeServer( make3tz( sampleFiles( 2 ) ) );
	const open = new Tiles3tzPlugin( { fetch: server.fetch } );
	assert.equal( open.fetchData( 'https://elsewhere.example/x.glb', {} ), null, 'default: left to the renderer' );

	const closed = new Tiles3tzPlugin( { fetch: server.fetch, archiveOnly: true } );
	closed.init( { fetchOptions: {} } );
	const root = closed.preprocessURL( URL3TZ, null );
	assert.equal( ( await closed.fetchData( root, {} ) ).status, 200 );
	assert.equal( ( await closed.fetchData( 'https://elsewhere.example/x.glb', {} ) ).status, 403 );

} );

test( 'the index is held to the entry limit too', async () => {

	// 4 files: an index of 96 bytes, against a limit of 10
	const server = fakeServer( make3tz( sampleFiles( 3, 5 ) ) );
	await assert.rejects(
		Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch } ), { maxDirectoryBytes: 10, tailBytes: 300, maxEntryBytes: 10 } ),
		/@3dtilesIndex1@: its size is over the limit/ );

} );

// a server that answers 206 but not what was asked
function lyingServer( bytes, lie ) {

	return async ( url, init = {} ) => {

		const range = init.headers.Range;
		const total = bytes.length;
		if ( lie === 'big' ) return new Response( new Uint8Array( 1024 * 1024 ), { status: 206, headers: { 'Content-Range': `bytes 0-${ 1024 * 1024 - 1 }/${ total }` } } );
		if ( lie === 'long-body' ) {

			const n = Number( /bytes=-(\d+)/.exec( range )[ 1 ] );
			return new Response( new Uint8Array( 1024 * 1024 ), { status: 206, headers: { 'Content-Range': `bytes ${ total - n }-${ total - 1 }/${ total }` } } );

		}

		return new Response( bytes.slice( 0, 10 ), { status: 206 } ); // no Content-Range

	};

}

test( 'a 206 must be the range asked for, and its body no longer', async () => {

	const bytes = make3tz( sampleFiles( 3 ) );
	for ( const lie of [ 'big', 'long-body', 'no-header' ] ) {

		await assert.rejects(
			Archive3tz.open( httpSource( URL3TZ, { fetch: lyingServer( bytes, lie ) } ), { tailBytes: 1024 } ),
			/does not match it/, lie );

	}

} );
