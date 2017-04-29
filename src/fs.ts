import * as fs from 'mz/fs';
import { LanguageClient } from './lang-handler';
import glob = require('glob');
import iterate from 'iterare';
import { Span } from 'opentracing';
import Semaphore from 'semaphore-async-await';
import { URL } from 'whatwg-url';
import { InMemoryFileSystem } from './memfs';
import { path2uri, uri2path } from './util';

export interface FileSystem {
	/**
	 * Returns all files in the workspace under base
	 *
	 * @param base A URI under which to search, resolved relative to the rootUri
	 * @return A promise that is fulfilled with an array of URIs
	 */
	getWorkspaceFiles(base?: URL, childOf?: Span): Promise<Iterable<URL>>;

	/**
	 * Returns the content of a text document
	 *
	 * @param uri The URI of the text document, resolved relative to the rootUri
	 * @return A promise that is fulfilled with the text document content
	 */
	getTextDocumentContent(uri: URL, childOf?: Span): Promise<string>;
}

export class RemoteFileSystem implements FileSystem {

	constructor(private client: LanguageClient) {}

	/**
	 * The files request is sent from the server to the client to request a list of all files in the workspace or inside the directory of the base parameter, if given.
	 * A language server can use the result to index files by filtering and doing a content request for each text document of interest.
	 */
	async getWorkspaceFiles(base?: URL, childOf = new Span()): Promise<Iterable<URL>> {
		return iterate(await this.client.workspaceXfiles({ base: base && base.href }, childOf))
			.map(textDocument => new URL(textDocument.uri));
	}

	/**
	 * The content request is sent from the server to the client to request the current content of any text document. This allows language servers to operate without accessing the file system directly.
	 */
	async getTextDocumentContent(uri: URL, childOf = new Span()): Promise<string> {
		const textDocument = await this.client.textDocumentXcontent({ textDocument: { uri: uri.href } }, childOf);
		return textDocument.text;
	}
}

/**
 * FileSystem implementation that reads from the local disk
 */
export class LocalFileSystem implements FileSystem {

	/**
	 * @param rootUri The workspace root URI that is used when no base is given
	 */
	constructor(protected rootUri: URL) {}

	/**
	 * Returns the file path where a given URI should be located on disk
	 */
	protected resolveUriToPath(uri: URL): string {
		return uri2path(uri);
	}

	async getWorkspaceFiles(base: URL = this.rootUri): Promise<Iterable<URL>> {
		const files = await new Promise<string[]>((resolve, reject) => {
			glob('*', {
				// Search the base directory
				cwd: this.resolveUriToPath(base),
				// Don't return directories
				nodir: true,
				// Search directories recursively
				matchBase: true,
				// Return absolute file paths
				absolute: true
			} as any, (err, matches) => err ? reject(err) : resolve(matches));
		});
		return iterate(files).map(filePath => path2uri(base, filePath));
	}

	async getTextDocumentContent(uri: URL): Promise<string> {
		return fs.readFile(this.resolveUriToPath(uri), 'utf8');
	}
}

/**
 * Synchronizes a remote file system to an in-memory file system
 *
 * TODO: Implement Disposable with Disposer
 */
export class FileSystemUpdater {

	/**
	 * Promise for a pending or fulfilled structure fetch
	 */
	private structureFetch?: Promise<void>;

	/**
	 * Map from URI to Promise of pending or fulfilled content fetch
	 */
	private fetches = new Map<string, Promise<void>>();

	/**
	 * Limits concurrent fetches to not fetch thousands of files in parallel
	 */
	private concurrencyLimit = new Semaphore(100);

	constructor(private remoteFs: FileSystem, private inMemoryFs: InMemoryFileSystem) {}

	/**
	 * Fetches the file content for the given URI and adds the content to the in-memory file system
	 *
	 * @param uri URI of the file to fetch
	 * @param childOf A parent span for tracing
	 */
	async fetch(uri: URL, childOf = new Span()): Promise<void> {
		// Limit concurrent fetches
		const promise = this.concurrencyLimit.execute(async () => {
			try {
				const content = await this.remoteFs.getTextDocumentContent(uri);
				this.inMemoryFs.add(uri, content);
				this.inMemoryFs.getContent(uri);
			} catch (err) {
				this.fetches.delete(uri.href);
				throw err;
			}
		});
		this.fetches.set(uri.href, promise);
		return promise;
	}

	/**
	 * Returns a promise that is resolved when the given URI has been fetched (at least once) to the in-memory file system.
	 * This function cannot be cancelled because multiple callers get the result of the same operation.
	 *
	 * @param uri URI of the file to ensure
	 * @param span An OpenTracing span for tracing
	 */
	ensure(uri: URL, span = new Span()): Promise<void> {
		return this.fetches.get(uri.href) || this.fetch(uri, span);
	}

	/**
	 * Fetches the file/directory structure for the given directory from the remote file system and saves it in the in-memory file system
	 *
	 * @param childOf A parent span for tracing
	 */
	fetchStructure(childOf = new Span()): Promise<void> {
		const promise = (async () => {
			const span = childOf.tracer().startSpan('Fetch workspace structure', { childOf });
			try {
				const uris = await this.remoteFs.getWorkspaceFiles(undefined, span);
				for (const uri of uris) {
					this.inMemoryFs.add(uri);
				}
			} catch (err) {
				this.structureFetch = undefined;
				span.setTag('error', true);
				span.log({ 'event': 'error', 'error.object': err, 'message': err.message, 'stack': err.stack });
				throw err;
			} finally {
				span.finish();
			}
		})();
		this.structureFetch = promise;
		return promise;
	}

	/**
	 * Returns a promise that is resolved as soon as the file/directory structure for the given directory has been synced
	 * from the remote file system to the in-memory file system (at least once)
	 *
	 * @param span An OpenTracing span for tracing
	 */
	ensureStructure(span = new Span()) {
		return this.structureFetch || this.fetchStructure(span);
	}

	/**
	 * Invalidates the content fetch cache of a file.
	 * The next call to `ensure` will do a refetch.
	 *
	 * @param uri URI of the file that changed
	 */
	invalidate(uri: URL): void {
		this.fetches.delete(uri.href);
	}

	/**
	 * Invalidates the structure fetch cache.
	 * The next call to `ensureStructure` will do a refetch.
	 */
	invalidateStructure(): void {
		this.structureFetch = undefined;
	}
}
