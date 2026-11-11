// Type declarations for 3d-tiles-renderer-3tz (the package is plain JavaScript).

/** The figures a source keeps about itself. */
export interface SourceStats {
	kind: 'blob' | 'http';
	/** whether the server honoured `Range` (null before the first answer); always true for a blob */
	ranges: boolean | null;
	requests: number;
	/** bytes received so far */
	bytes: number;
	/** http only */
	url?: string;
	/** http only: the ETag of the first response that had one, else null */
	etag?: string | null;
	/** http only: the ranges asked and not yet answered (`'bytes=a-b'`, `'bytes=-n'`) */
	pending?: string[];
}

/** Where the bytes of an archive come from. */
export interface ByteSource {
	/** the last `length` bytes, and the size of the file */
	tail( length: number ): Promise<{ bytes: Uint8Array; size: number }>;
	/** `length` bytes from `offset` (fewer at the end of the file) */
	read( offset: number, length: number ): Promise<Uint8Array>;
	stats(): SourceStats;
}

/** An error thrown by `httpSource`: the range it had asked and, when a response came, its status. */
export interface SourceError extends Error {
	range?: string;
	status?: number;
}

export interface HttpSourceOptions {
	fetch?: typeof fetch;
	fetchOptions?: RequestInit;
	/** when the server ignores `Range`, the most it may send (default `DEFAULT_MAX_DOWNLOAD_BYTES`) */
	maxDownloadBytes?: number;
}

export function blobSource( blob: Blob ): ByteSource;
export function httpSource( url: string, options?: HttpSourceOptions ): ByteSource;

export interface ArchiveOptions {
	/** the first request: this much of the end of the archive (default `DEFAULT_TAIL_BYTES`) */
	tailBytes?: number;
	/** over this the central directory is not read, the index is (default `DEFAULT_MAX_DIRECTORY_BYTES`) */
	maxDirectoryBytes?: number;
	/** through the index, the data taken with an entry's local header (default `DEFAULT_GUESS_BYTES`) */
	guessBytes?: number;
	/** the most an entry may take, compressed or inflated (default `DEFAULT_MAX_ENTRY_BYTES`) */
	maxEntryBytes?: number;
	/** false: a plain ZIP without `@3dtilesIndex1@` is opened too (default true) */
	requireIndex?: boolean;
	/** central-directory records read between two yields to the page; 0 = one piece (default `DEFAULT_YIELD_EVERY`) */
	yieldEvery?: number;
}

/** Where an entry's local header is, as the central directory says. */
export interface EntryLocation {
	offset: number;
	compressedSize: number;
	nameLength: number;
	/** 0 = stored, 8 = deflate */
	method: number;
}

export class Archive3tz {
	static open( source: ByteSource, options?: ArchiveOptions ): Promise<Archive3tz>;
	/** Prefer `Archive3tz.open`. */
	constructor( source: ByteSource, init: {
		entries: Map<string, EntryLocation> | null;
		index: Uint8Array | null;
		guessBytes?: number;
		maxEntryBytes?: number;
		openRequests: number;
		zip64: boolean;
	} );
	readonly source: ByteSource;
	/** how the archive was opened */
	readonly info: { files: number; lookup: 'central-directory' | 'index'; openRequests: number; zip64: boolean };
	/** every file's path when opened through the central directory; null through the index */
	names(): string[] | null;
	has( path: string ): boolean;
	/** the bytes of `path`, or null when the archive does not hold it */
	read( path: string ): Promise<Uint8Array | null>;
}

export interface Tiles3tzPluginOptions {
	fetch?: typeof fetch;
	archiveOptions?: ArchiveOptions;
	maxDownloadBytes?: number;
	/** answer 403 to every request outside the registered archives */
	archiveOnly?: boolean;
}

export class Tiles3tzPlugin {
	constructor( options?: Tiles3tzPluginOptions );
	name: string;
	priority: number;
	archives: Map<string, Promise<Archive3tz>>;
	init( tiles: unknown ): void;
	/** register a File or Blob; returns the URL of its tileset.json */
	addFile( blob: Blob ): string;
	/** register an archive behind a URL; returns the URL of its tileset.json */
	addURL( url: string ): string;
	baseFor( url: string ): string | null;
	preprocessURL( url: string, tile: unknown ): string;
	fetchData( url: string, options?: RequestInit ): Promise<Response> | null;
	dispose(): void;
}

/** Paths as the archive compares them: Unicode NFC, `/`, no leading `/`. */
export function normalizePath( path: string ): string;
/** The name of the .3tz index entry, `@3dtilesIndex1@`. */
export const INDEX_NAME: '@3dtilesIndex1@';

export const DEFAULT_TAIL_BYTES: number;
export const DEFAULT_MAX_DIRECTORY_BYTES: number;
export const DEFAULT_GUESS_BYTES: number;
export const DEFAULT_MAX_ENTRY_BYTES: number;
export const DEFAULT_YIELD_EVERY: number;
export const DEFAULT_MAX_DOWNLOAD_BYTES: number;
