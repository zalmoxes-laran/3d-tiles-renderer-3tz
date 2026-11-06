import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Archive3tz, Tiles3tzPlugin, blobSource, httpSource } from '../src/index.js';
import { md5 } from '../src/index3tz.js';
import { make3tz, fakeServer, sampleFiles } from './helpers.js';

const text = bytes => new TextDecoder().decode( bytes );
const URL3TZ = 'https://example.org/data/site.3tz';

test( 'md5 matches the RFC 1321 test vectors', () => {

	const hex = s => Buffer.from( md5( new TextEncoder().encode( s ) ) ).toString( 'hex' );
	assert.equal( hex( '' ), 'd41d8cd98f00b204e9800998ecf8427e' );
	assert.equal( hex( 'abc' ), '900150983cd24fb0d6963f7d28e17f72' );
	assert.equal( hex( 'a'.repeat( 1000 ) ), 'cabe45dcc9ae5b66ba86600cca6b8ba8' );

} );

test( 'opens with one request and reads each tile with one request', async () => {

	const files = sampleFiles( 50 );
	const server = fakeServer( make3tz( files ) );
	const archive = await Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch } ) );
	assert.equal( archive.info.lookup, 'central-directory' );
	assert.equal( archive.info.files, 51 );
	assert.equal( server.log.length, 1 );

	for ( const f of files.slice( 1 ) ) {

		const before = server.log.length;
		assert.deepEqual( await archive.read( f.path ), f.data );
		assert.equal( server.log.length - before, 1, f.path );

	}

	assert.match( text( await archive.read( 'tileset.json' ) ), /"version":"1.1"/ );
	assert.equal( await archive.read( 'nothing/here.glb' ), null );

} );

test( 'a central directory longer than the first read costs one more request', async () => {

	const server = fakeServer( make3tz( sampleFiles( 200 ) ) );
	const archive = await Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch } ), { tailBytes: 1024 } );
	assert.equal( archive.info.openRequests, 2 );
	assert.equal( server.log.length, 2 );
	assert.ok( await archive.read( 'tiles/7.glb' ) );

} );

test( 'large archives are read through the @3dtilesIndex1@ index', async () => {

	const files = sampleFiles( 100, 3000 );
	const server = fakeServer( make3tz( files ) );
	// pretend the directory is too large, and guess small so big tiles need two requests
	const archive = await Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch } ), { maxDirectoryBytes: 100, tailBytes: 512, guessBytes: 1000 } );
	assert.equal( archive.info.lookup, 'index' );
	assert.equal( archive.info.files, 101 );
	for ( const f of files.slice( 1, 20 ) ) assert.deepEqual( await archive.read( f.path ), f.data );
	assert.ok( archive.has( 'tiles/42.glb' ) );
	assert.equal( archive.has( 'tiles/4200.glb' ), false );
	assert.equal( await archive.read( 'tiles/4200.glb' ), null );

} );

test( 'deflated entries, ZIP64 end records and long local extra fields', async () => {

	const files = [
		{ path: 'tileset.json', data: '{"asset":{"version":"1.0"}}', deflate: true },
		{ path: 'a.b3dm', data: new Uint8Array( 5000 ).fill( 7 ), deflate: true },
		{ path: 'b.b3dm', data: new Uint8Array( 300 ).fill( 9 ), localExtra: 200 },
	];
	const bytes = make3tz( files, { zip64: true } );
	const server = fakeServer( bytes );
	const archive = await Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch } ) );
	assert.equal( archive.info.zip64, true );
	assert.equal( text( await archive.read( 'tileset.json' ) ), '{"asset":{"version":"1.0"}}' );
	assert.deepEqual( await archive.read( 'a.b3dm' ), files[ 1 ].data );
	const before = server.log.length;
	assert.deepEqual( await archive.read( 'b.b3dm' ), files[ 2 ].data );
	assert.equal( server.log.length - before, 2, 'an extra field past the margin needs a second request' );

} );

test( 'names stored in NFD (as macOS zips them) are found by their NFC form', async () => {

	const nfc = 'tiles/città.glb';
	const archive = await Archive3tz.open( blobSource( new Blob( [ make3tz( [ { path: nfc, data: 'x', storedName: nfc.normalize( 'NFD' ) } ] ) ] ) ) );
	assert.equal( text( await archive.read( nfc ) ), 'x' );

} );

test( 'a server without Range support: the archive is downloaded once', async () => {

	const files = sampleFiles( 10 );
	const server = fakeServer( make3tz( files ), { ranges: false } );
	const source = httpSource( URL3TZ, { fetch: server.fetch } );
	const archive = await Archive3tz.open( source );
	for ( const f of files.slice( 1 ) ) assert.deepEqual( await archive.read( f.path ), f.data );
	assert.equal( server.log.length, 1 );
	assert.equal( source.stats().ranges, false );

} );

test( 'refuses a plain zip and a compressed index', async () => {

	const open = bytes => Archive3tz.open( blobSource( new Blob( [ bytes ] ) ) );
	await assert.rejects( open( make3tz( sampleFiles( 3 ), { index: false } ) ), /last entry is not @3dtilesIndex1@/ );
	await assert.rejects( open( make3tz( sampleFiles( 3 ), { compressIndex: true } ) ), /stored without compression/ );
	await assert.rejects( open( new Uint8Array( 100 ) ), /Not a ZIP/ );

} );

test( 'plugin: a root URL ending in .3tz is served from the archive', async () => {

	const files = sampleFiles( 5 );
	const server = fakeServer( make3tz( files ) );
	const plugin = new Tiles3tzPlugin( { fetch: server.fetch } );
	plugin.init( { fetchOptions: {} } );

	const root = plugin.preprocessURL( URL3TZ, null );
	assert.equal( root, URL3TZ + '/tileset.json' );
	assert.equal( plugin.preprocessURL( URL3TZ, null ), root, 'calling it again opens nothing new' );
	assert.equal( plugin.preprocessURL( 'https://example.org/other/tileset.json', null ), 'https://example.org/other/tileset.json' );

	const tileset = await ( await plugin.fetchData( root, {} ) ).json();
	assert.equal( tileset.asset.version, '1.1' );

	// a tile URL resolved relative to the tileset, as the renderer does
	const tileURL = new URL( 'tiles/3.glb', root ).href;
	const res = await plugin.fetchData( tileURL, {} );
	assert.equal( res.status, 200 );
	assert.deepEqual( new Uint8Array( await res.arrayBuffer() ), files[ 4 ].data );

	assert.equal( ( await plugin.fetchData( URL3TZ + '/missing.glb', {} ) ).status, 404 );
	assert.equal( plugin.fetchData( 'https://example.org/elsewhere.glb', {} ), null, 'other URLs are left to the renderer' );

} );

test( 'plugin: a local File or Blob', async () => {

	const plugin = new Tiles3tzPlugin();
	const root = plugin.addFile( new Blob( [ make3tz( sampleFiles( 2 ) ) ] ) );
	assert.match( root, /\/__3tz__\/1\/tileset\.json$/ );
	const res = await plugin.fetchData( root.replace( 'tileset.json', 'tiles/1.glb' ), {} );
	assert.equal( res.status, 200 );

} );
