import * as fs from 'mz/fs';
import * as path from 'path';
import { CancellationToken } from './cancellation';
import { RemoteLanguageClient } from './lang-handler';
import glob = require('glob');
import iterate from 'iterare';
import { Span } from 'opentracing';
import Semaphore from 'semaphore-async-await';
import { InMemoryFileSystem } from './project-manager';
import { path2uri, uri2path } from './util';

export interface FileSystem {
	/**
	 * Returns all files in the workspace under base
	 *
	 * @param base A URI under which to search, resolved relative to the rootUri
	 * @return A promise that is fulfilled with an array of URIs
	 */
	getWorkspaceFiles(base?: string, token?: CancellationToken): Promise<Iterable<string>>;

	/**
	 * Returns the content of a text document
	 *
	 * @param uri The URI of the text document, resolved relative to the rootUri
	 * @return A promise that is fulfilled with the text document content
	 */
	getTextDocumentContent(uri: string, token?: CancellationToken): Promise<string>;
}

export class RemoteFileSystem implements FileSystem {

	constructor(private client: RemoteLanguageClient) {}

	/**
	 * The files request is sent from the server to the client to request a list of all files in the workspace or inside the directory of the base parameter, if given.
	 * A language server can use the result to index files by filtering and doing a content request for each text document of interest.
	 */
	async getWorkspaceFiles(base?: string): Promise<Iterable<string>> {
		return iterate(await this.client.workspaceXfiles({ base }))
			.map(textDocument => textDocument.uri);
	}

	/**
	 * The content request is sent from the server to the client to request the current content of any text document. This allows language servers to operate without accessing the file system directly.
	 */
	async getTextDocumentContent(uri: string): Promise<string> {
		const textDocument = await this.client.textDocumentContent({ textDocument: { uri } });
		return textDocument.text;
	}
}

export class LocalFileSystem implements FileSystem {

	/**
	 * @param rootPath The root directory path that relative URIs should be resolved to
	 */
	constructor(private rootPath: string) {}

	/**
	 * Converts the URI to an absolute path
	 */
	protected resolveUriToPath(uri: string): string {
		return path.resolve(this.rootPath, uri2path(uri));
	}

	async getWorkspaceFiles(base?: string): Promise<Iterable<string>> {
		const pattern = base ? path.posix.join(this.resolveUriToPath(base), '**/*.*') : this.resolveUriToPath('file:///**/*.*');
		const files = await new Promise<string[]>((resolve, reject) => {
			glob(pattern, { nodir: true }, (err, matches) => err ? reject(err) : resolve(matches));
		});
		return iterate(files).map(file => path2uri('', file));
	}

	async getTextDocumentContent(uri: string): Promise<string> {
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
	async fetch(uri: string, childOf = new Span()): Promise<void> {
		// Limit concurrent fetches
		const promise = this.concurrencyLimit.execute(async () => {
			try {
				const content = await this.remoteFs.getTextDocumentContent(uri);
				this.inMemoryFs.add(uri, content);
				this.inMemoryFs.getContent(uri);
			} catch (err) {
				this.fetches.delete(uri);
				throw err;
			}
		});
		this.fetches.set(uri, promise);
		return promise;
	}

	/**
	 * Returns a promise that is resolved when the given URI has been fetched (at least once) to the in-memory file system.
	 * This function cannot be cancelled because multiple callers get the result of the same operation.
	 *
	 * @param uri URI of the file to ensure
	 * @param childOf A parent span for tracing
	 */
	async ensure(uri: string, childOf = new Span()): Promise<void> {
		const span = childOf.tracer().startSpan('ensure file content', { childOf });
		span.addTags({ uri });
		try {
			return await (this.fetches.get(uri) || this.fetch(uri));
		} catch (err) {
			span.setTag('error', true);
			span.log({ 'event': 'error', 'error.object': err });
			throw err;
		} finally {
			span.finish();
		}
	}

	/**
	 * Fetches the file/directory structure for the given directory from the remote file system and saves it in the in-memory file system
	 *
	 * @param childOf A parent span for tracing
	 */
	fetchStructure(childOf = new Span()): Promise<void> {
		const promise = (async () => {
			const span = childOf.tracer().startSpan('fetch structure', { childOf });
			try {
				const uris = await this.remoteFs.getWorkspaceFiles();
				for (const uri of uris) {
					this.inMemoryFs.add(uri);
				}
			} catch (err) {
				this.structureFetch = undefined;
				span.setTag('error', true);
				span.log({ 'event': 'error', 'error.object': err });
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
	 * @param childOf A parent span for tracing
	 */
	async ensureStructure(childOf = new Span()) {
		const span = childOf.tracer().startSpan('ensure structure', { childOf });
		try {
			return await this.structureFetch || this.fetchStructure();
		} catch (err) {
			span.setTag('error', true);
			span.log({ 'event': 'error', 'error.object': err });
			throw err;
		} finally {
			span.finish();
		}
	}

	/**
	 * Invalidates the structure fetch cache.
	 * The next call to `ensureStructure` will do a refetch.
	 */
	invalidateStructure() {
		this.structureFetch = undefined;
	}
}
