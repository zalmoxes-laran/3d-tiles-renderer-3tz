import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Archive3tz, httpSource } from '../src/index.js';
import { make3tz, sampleFiles } from './helpers.js';

const URL3TZ = 'https://example.org/data/site.3tz';

// A static host seen from another origin (GitHub Pages, raw.githubusercontent.com):
// a suffix range needs a CORS preflight, which it refuses (fetch rejects, no
// response); a HEAD gives Content-Length; a plain range gets a 206 whose
// Content-Range the page cannot read.
function staticHost( bytes, { head = true } = {} ) {

	const log = [];
	const fetchFn = async ( url, init = {} ) => {

		const range = init.headers && init.headers.Range;
		log.push( { method: init.method || 'GET', range } );
		if ( init.method === 'HEAD' ) {

			if ( ! head ) throw new TypeError( 'Failed to fetch' );
			return new Response( null, { status: 200, headers: { 'Content-Length': String( bytes.length ) } } );

		}

		if ( range && /^bytes=-/.test( range ) ) throw new TypeError( 'Failed to fetch' );
		const span = /^bytes=(\d+)-(\d+)$/.exec( range );
		const start = Number( span[ 1 ] ), end = Math.min( bytes.length - 1, Number( span[ 2 ] ) );
		return new Response( bytes.slice( start, end + 1 ), { status: 206 } );

	};

	return { fetch: fetchFn, log };

}

test( 'a static host: the size from a HEAD, then plain ranges whose Content-Range is hidden', async () => {

	const files = sampleFiles( 20 );
	const server = staticHost( make3tz( files ) );
	const archive = await Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch } ) );
	assert.equal( archive.info.files, 21 );
	assert.deepEqual( server.log.slice( 0, 3 ).map( r => r.method ), [ 'GET', 'HEAD', 'GET' ] );
	assert.match( server.log[ 2 ].range, /^bytes=\d+-\d+$/ );

	for ( const f of files.slice( 1 ) ) {

		const before = server.log.length;
		assert.deepEqual( await archive.read( f.path ), f.data );
		assert.equal( server.log.length - before, 1, f.path );

	}

} );

test( 'a static host without HEAD: the first error is the one thrown', async () => {

	const server = staticHost( make3tz( sampleFiles( 5 ) ), { head: false } );
	await assert.rejects( Archive3tz.open( httpSource( URL3TZ, { fetch: server.fetch } ) ), e => e instanceof TypeError && /^bytes=-\d+$/.test( e.range ) );

} );

test( 'a hidden Content-Range with a body of the wrong length is refused', async () => {

	const bytes = make3tz( sampleFiles( 5 ) );
	const short = async ( url, init = {} ) => {

		if ( init.method === 'HEAD' ) return new Response( null, { status: 200, headers: { 'Content-Length': String( bytes.length ) } } );
		const range = init.headers.Range;
		if ( /^bytes=-/.test( range ) ) throw new TypeError( 'Failed to fetch' );
		const [ , a, b ] = /^bytes=(\d+)-(\d+)$/.exec( range ).map( Number );
		return new Response( bytes.slice( a, b ), { status: 206 } ); // one byte short

	};

	await assert.rejects( Archive3tz.open( httpSource( URL3TZ, { fetch: short } ) ), /does not match/ );

} );
