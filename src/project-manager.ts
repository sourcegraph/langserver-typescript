import iterate from 'iterare';
import { memoize } from 'lodash';
import { Span } from 'opentracing';
import * as os from 'os';
import * as path_ from 'path';
import * as ts from 'typescript';
import { Disposable } from 'vscode-languageserver';
import { CancellationToken, CancellationTokenSource, throwIfCancelledError, throwIfRequested } from './cancellation';
import { FileSystemUpdater } from './fs';
import { Logger, NoopLogger } from './logging';
import { InMemoryFileSystem, walkInMemoryFs } from './memfs';
import * as util from './util';

/**
 * ProjectManager translates VFS files to one or many projects denoted by [tj]config.json.
 * It uses either local or remote file system to fetch directory tree and files from and then
 * makes one or more LanguageService objects. By default all LanguageService objects contain no files,
 * they are added on demand - current file for hover or definition, project's files for references and
 * all files from all projects for workspace symbols.
 */
export class ProjectManager implements Disposable {

	/**
	 * Cancellations to do when the object is disposed
	 */
	private cancellationSources = new Set<CancellationTokenSource>();

	/**
	 * Root path (as passed to `initialize` request)
	 */
	private rootPath: string;

	/**
	 * Workspace subtree (folder) -> JS/TS configuration mapping.
	 * Configuration settings for a source file A are located in the closest parent folder of A.
	 * Map keys are relative (to workspace root) paths
	 */
	private configs: Map<string, ProjectConfiguration>;

	/**
	 * When on, indicates that client is responsible to provide file content (VFS),
	 * otherwise we are working with a local file system
	 */
	private strict: boolean;

	/**
	 * Local side of file content provider which keeps cache of fetched files
	 */
	private localFs: InMemoryFileSystem;

	/**
	 * File system updater that takes care of updating the in-memory file system
	 */
	private updater: FileSystemUpdater;

	/**
	 * Relative file path -> version map. Every time file content is about to change or changed (didChange/didOpen/...), we are incrementing it's version
	 * signalling that file is changed and file's user must invalidate cached and requery file content
	 */
	private versions: Map<string, number>;

	/**
	 * Enables module resolution tracing by TS compiler
	 */
	private traceModuleResolution: boolean;

	/**
	 * Flag indicating that we fetched module struture (tsconfig.json, jsconfig.json, package.json files) from the remote file system.
	 * Without having this information we won't be able to split workspace to sub-projects
	 */
	ensuredModuleStructure?: Promise<void>;

	/**
	 * Tracks if source file denoted by the given URI is fetched from remote file system and available locally.
	 * For hover or definition we only need a single file (and maybe its transitive includes/references as reported by TS compiler).
	 * This map prevents fetching of file content from remote filesystem twice
	 */
	ensuredFilesForHoverAndDefinition = new Map<string, Promise<void>>();

	/**
	 * For references/symbols we need all the source files making workspace so this flag tracks if we already did it
	 */
	private ensuredAllFiles?: Promise<void>;

	/**
	 * @param rootPath root path as passed to `initialize`
	 * @param inMemoryFileSystem File system that keeps structure and contents in memory
	 * @param strict indicates if we are working in strict mode (VFS) or with a local file system
	 * @param traceModuleResolution allows to enable module resolution tracing (done by TS compiler)
	 */
	constructor(rootPath: string, inMemoryFileSystem: InMemoryFileSystem, updater: FileSystemUpdater, strict: boolean, traceModuleResolution?: boolean, protected logger: Logger = new NoopLogger()) {
		this.rootPath = util.toUnixPath(rootPath);
		this.configs = new Map<string, ProjectConfiguration>();
		this.updater = updater;
		this.localFs = inMemoryFileSystem;
		this.versions = new Map<string, number>();
		this.strict = strict;
		this.traceModuleResolution = traceModuleResolution || false;
	}

	/**
	 * Disposes the object and cancels any asynchronous operations that are still active
	 */
	dispose(): void {
		for (const source of this.cancellationSources) {
			source.cancel();
		}
	}

	/**
	 * @return root path (as passed to `initialize`)
	 */
	getRemoteRoot(): string {
		return this.rootPath;
	}

	/**
	 * @return local side of file content provider which keeps cached copies of fethed files
	 */
	getFs(): InMemoryFileSystem {
		return this.localFs;
	}

	/**
	 * @param filePath file path (both absolute or relative file paths are accepted)
	 * @return true if there is a fetched file with a given path
	 */
	hasFile(filePath: string) {
		return this.localFs.fileExists(filePath);
	}

	/**
	 * @return all sub-projects we have identified for a given workspace.
	 * Sub-project is mainly a folder which contains tsconfig.json, jsconfig.json, package.json,
	 * or a root folder which serves as a fallback
	 */
	getConfigurations(): ProjectConfiguration[] {
		const ret: ProjectConfiguration[] = [];
		this.configs.forEach((v, k) => {
			ret.push(v);
		});
		return ret;
	}

	/**
	 * ensureModuleStructure ensures that the module structure of the
	 * project exists in localFs. TypeScript/JavaScript module
	 * structure is determined by [jt]sconfig.json, filesystem layout,
	 * global*.d.ts files. For performance reasons, we only read in
	 * the contents of some files and store "var dummy_0ff1bd;" as the
	 * contents of all other files.
	 */
	ensureModuleStructure(): Promise<void> {
		if (!this.ensuredModuleStructure) {
			this.ensuredModuleStructure = this.refreshFileTree(this.rootPath, true).then(() => {
				this.createConfigurations();
			});
			this.ensuredModuleStructure.catch(err => {
				this.logger.error('Failed to fetch module structure: ', err);
				this.ensuredModuleStructure = undefined;
			});
		}
		return this.ensuredModuleStructure;
	}

	/**
	 * refreshFileTree refreshes the local in-memory filesytem's (this.localFs) files under the
	 * specified path (root) with the contents of the remote filesystem (this.remoteFs). It will
	 * also reset the ProjectConfigurations that are affected by the refreshed files.
	 *
	 * If moduleStructureOnly is true, then only files related to module structure (package.json,
	 * tsconfig.json, etc.) will be refreshed.
	 *
	 * This method is public because a ProjectManager instance assumes there are no changes made to
	 * the remote filesystem structure after initialization. If such changes are made, it is
	 * necessary to call this method to alert the ProjectManager instance of the change.
	 *
	 * @param rootPath root path
	 * @param moduleStructureOnly indicates if we need to fetch only configuration files such as tsconfig.json,
	 * jsconfig.json or package.json (otherwise we want to fetch them plus source files)
	 */
	async refreshFileTree(rootPath: string, moduleStructureOnly: boolean): Promise<void> {
		rootPath = util.normalizeDir(rootPath);
		const filesToFetch: string[] = [];
		await this.updater.fetchStructure();
		for (const uri of this.localFs.uris()) {
			const file = util.uri2path(uri);
			const rel = path_.posix.relative(this.rootPath, util.toUnixPath(file));
			if (!moduleStructureOnly || util.isGlobalTSFile(rel) || util.isConfigFile(rel) || util.isPackageJsonFile(rel)) {
				filesToFetch.push(file);
			} else if (!this.localFs.fileExists(rel)) {
				this.localFs.add(uri, localFSPlaceholder);
			}
		}
		await this.ensureFiles(filesToFetch);

		// require re-fetching of dependency files (but not for
		// workspace/symbol and textDocument/references, because those
		// should not be affected by new external modules)
		this.ensuredFilesForHoverAndDefinition.clear();

		// require re-parsing of projects whose file set may have been affected
		for (let [dir, config] of this.configs) {
			dir = util.normalizeDir(dir);

			if (dir.startsWith(rootPath + '/') || rootPath.startsWith(dir + '/') || rootPath === dir) {
				config.reset();
			}
		}
	}

	/**
	 * Ensures that all the files needed to produce hover and definitions for a given
	 * source file URI were fetched from the remote file system. Set of the needed files includes:
	 * - file itself
	 * - file's includes and dependencies (transitive) reported by TS compiler up to depth 30
	 * There is no need to fetch/parse/compile all the workspace files to produce hover of a symbol in the file F because
	 * definition of this symbol must be in one of files references by F or its dependencies
	 *
	 * @param uri target file URI
	 */
	async ensureFilesForHoverAndDefinition(uri: string, childOf = new Span()): Promise<void> {
		const span = childOf.tracer().startSpan('Ensure files for hover and definition', { childOf });
		span.addTags({ uri });
		try {
			const existing = this.ensuredFilesForHoverAndDefinition.get(uri);
			if (existing) {
				return existing;
			}
			const promise = (async () => {
				try {
					await this.ensureModuleStructure();
					// Include dependencies up to depth 30
					await this.ensureTransitiveFileDependencies(uri, 30, undefined, span);
				} catch (err) {
					this.ensuredFilesForHoverAndDefinition.delete(uri);
					throw err;
				}
			})();
			this.ensuredFilesForHoverAndDefinition.set(uri, promise);
			await promise;
		} catch (err) {
			span.setTag('error', true);
			span.log({ 'event': 'error', 'error.object': err });
			throw err;
		} finally {
			span.finish();
		}
	}

	/**
	 * Ensures all files needed for a workspace/symbol request are available in memory.
	 * This includes all js/ts files, tsconfig files and package.json files.
	 * It excludes files in node_modules.
	 * Invalidates project configurations after execution
	 */
	ensureFilesForWorkspaceSymbol = memoize(async (): Promise<void> => {
		try {
			await this.updater.ensureStructure();
			const filesToEnsure = [];
			for (const uri of this.localFs.uris()) {
				const file = util.uri2path(uri);
				if (
					util.toUnixPath(file).indexOf('/node_modules/') === -1
					&& (util.isJSTSFile(file) || util.isConfigFile(file) || util.isPackageJsonFile(file))
				) {
					filesToEnsure.push(file);
				}
			}
			await this.ensureFiles(filesToEnsure);
			await this.createConfigurations();
		} catch (e) {
			this.ensureFilesForWorkspaceSymbol.cache = new WeakMap();
			throw e;
		}
	});

	/**
	 * Ensures all files were fetched from the remote file system.
	 * Invalidates project configurations after execution
	 */
	ensureAllFiles(): Promise<void> {
		if (this.ensuredAllFiles) {
			return this.ensuredAllFiles;
		}

		const promise = this.updater.ensureStructure()
			.then(() => this.ensureFiles(
				iterate(this.localFs.uris())
					.map(uri => util.uri2path(uri))
					.filter(file => util.isJSTSFile(file))
			))
			.then(() => this.createConfigurations());

		this.ensuredAllFiles = promise;
		promise.catch(err => {
			this.logger.error('Failed to fetch files for references:', err);
			this.ensuredAllFiles = undefined;
		});

		return promise;
	}

	/**
	 * Ensures that we have all the files needed to retrieve all the references to a symbol in the given file.
	 * Pretty much it's the same set of files needed to produce workspace symbols unless file is located in `node_modules`
	 * in which case we need to fetch the whole tree
	 *
	 * @param uri target file URI
	 */
	ensureFilesForReferences(uri: string): Promise<void> {
		const fileName: string = util.uri2path(uri);
		if (util.toUnixPath(fileName).indexOf(`${path_.posix.sep}node_modules${path_.posix.sep}`) !== -1) {
			return this.ensureFilesForWorkspaceSymbol();
		}

		return this.ensureAllFiles();
	}

	/**
	 * Recursively collects file(s) dependencies up to given level.
	 * Dependencies are extracted by TS compiler from import and reference statements
	 *
	 * Dependencies include:
	 * - all the configuration files
	 * - files referenced by the given file
	 * - files included by the given file
	 *
	 * @param uri File to process
	 * @param maxDepth stop collecting when reached given recursion level
	 * @param seen tracks visited files to avoid cycles
	 * @param childOf OpenTracing parent span for tracing
	 */
	private async ensureTransitiveFileDependencies(uri: string, maxDepth: number, seen = new Set<string>(), childOf = new Span()): Promise<void> {
		const span = childOf.tracer().startSpan('Ensure file imports', { childOf });
		span.addTags({ uri, maxDepth });
		try {
			seen.add(uri);

			await this.updater.ensure(uri, span);

			if (maxDepth > 0) {
				const filePath = util.uri2path(uri);
				const importPaths = new Set<string>();
				const config = this.getConfiguration(filePath);
				await config.ensureBasicFiles();
				const contents = this.localFs.getContent(uri);
				const info = ts.preProcessFile(contents, true, true);
				const compilerOpt = config.getHost().getCompilationSettings();
				for (const imp of info.importedFiles) {
					const resolved = ts.resolveModuleName(util.toUnixPath(imp.fileName), filePath, compilerOpt, config.moduleResolutionHost());
					if (!resolved || !resolved.resolvedModule) {
						// This means we didn't find a file defining
						// the module. It could still exist as an
						// ambient module, which is why we fetch
						// global*.d.ts files.
						continue;
					}
					importPaths.add(resolved.resolvedModule.resolvedFileName);
				}
				const resolver = !this.strict && os.platform() === 'win32' ? path_ : path_.posix;
				for (const ref of info.referencedFiles) {
					// Resolving triple slash references relative to current file
					// instead of using module resolution host because it behaves
					// differently in "nodejs" mode
					const refFilePath = util.toUnixPath(path_.relative(this.rootPath,
						resolver.resolve(this.rootPath,
							resolver.dirname(filePath),
							util.toUnixPath(ref.fileName))));
					importPaths.add(refFilePath);
				}
				await Promise.all(
					iterate(importPaths).map(async importPath => {
						try {
							await this.ensureTransitiveFileDependencies(importPath, maxDepth - 1, seen, span);
						} catch (err) {
							// Continue even if an import wasn't found
							this.logger.error('Error ensuring transitive file imports: ', err);
						}
					})
				);
			}
		} catch (err) {
			span.setTag('error', true);
			span.log({ 'event': 'error', 'error.object': err });
			throw err;
		} finally {
			span.finish();
		}
	}

	/**
	 * @param filePath source file path relative to project root
	 * @return project configuration for a given source file. Climbs directory tree up to workspace root if needed
	 */
	getConfiguration(filePath: string): ProjectConfiguration {
		let dir = filePath;
		let config;
		while (dir && dir !== this.rootPath) {
			config = this.configs.get(dir);
			if (config) {
				return config;
			}
			dir = path_.posix.dirname(dir);
			if (dir === '.') {
				dir = '';
			}
		}
		config = this.configs.get('');
		if (config) {
			return config;
		}
		throw new Error(`TypeScript config file for ${filePath} not found`);
	}

	/**
	 * Called when file was opened by client. Current implementation
	 * does not differenciates open and change events
	 * @param filePath path to a file relative to project root
	 * @param text file's content
	 */
	didOpen(filePath: string, text: string) {
		this.didChange(filePath, text);
	}

	/**
	 * Called when file was closed by client. Current implementation invalidates compiled version
	 * @param filePath path to a file relative to project root
	 */
	didClose(filePath: string) {
		this.localFs.didClose(filePath);
		let version = this.versions.get(filePath) || 0;
		this.versions.set(filePath, ++version);
		const config = this.getConfiguration(filePath);
		config.ensureConfigFile().then(() => {
			config.getHost().incProjectVersion();
			config.syncProgram();
		});
	}

	/**
	 * Called when file was changed by client. Current implementation invalidates compiled version
	 * @param filePath path to a file relative to project root
	 * @param text file's content
	 */
	didChange(filePath: string, text: string) {
		this.localFs.didChange(filePath, text);
		let version = this.versions.get(filePath) || 0;
		this.versions.set(filePath, ++version);
		const config = this.getConfiguration(filePath);
		config.ensureConfigFile().then(() => {
			config.getHost().incProjectVersion();
			config.syncProgram();
		});
	}

	/**
	 * Called when file was saved by client
	 * @param filePath path to a file relative to project root
	 */
	didSave(filePath: string) {
		this.localFs.didSave(filePath);
	}

	/**
	 * ensureFiles ensures the following files have been fetched to
	 * localFs. The files parameter is expected to contain paths in
	 * the remote FS. ensureFiles only syncs unfetched file content
	 * from remoteFs to localFs. It does not update project
	 * state. Callers that want to do so after file contents have been
	 * fetched should call this.createConfigurations().
	 *
	 * If one file fetch failed, the error will be caught and logged.
	 *
	 * @param files File paths
	 */
	async ensureFiles(files: Iterable<string>, token: CancellationToken = CancellationToken.None): Promise<void> {
		const source = new CancellationTokenSource();
		token.onCancellationRequested(() => source.cancel());
		this.cancellationSources.add(source);
		token = source.token;
		try {
			await Promise.all(iterate(files).map(async path => {
				throwIfRequested(token);
				try {
					await this.updater.ensure(util.path2uri('', path));
				} catch (err) {
					// if cancellation was requested, break out of the loop
					throwIfCancelledError(err);
					throwIfRequested(token);
					// else log error and continue
					this.logger.error(`Ensuring file ${path} failed`, err);
				}
			}));
		} finally {
			this.cancellationSources.delete(source);
		}
	}

	/**
	 * Detects projects and creates projects denoted by tsconfig.json and jsconfig.json fiels.
	 * Previously detected projects are NOT discarded.
	 * If there is no root configuration, adds it to catch all orphan files
	 */
	createConfigurations() {
		const rootdirs = new Set<string>();
		for (const uri of this.localFs.uris()) {
			const relativeFilePath = path_.posix.relative(this.rootPath, util.uri2path(uri));
			if (!/(^|\/)[tj]sconfig\.json$/.test(relativeFilePath)) {
				continue;
			}
			if (/(^|\/)node_modules\//.test(relativeFilePath)) {
				continue;
			}
			let dir = path_.posix.dirname(relativeFilePath);
			if (dir === '.') {
				dir = '';
			}
			if (!this.configs.has(dir)) {
				this.configs.set(dir, new ProjectConfiguration(this.localFs, path_.posix.join('/', dir), this.versions, relativeFilePath, undefined, this.traceModuleResolution, this.logger));
			}
			rootdirs.add(dir);
		}
		if (!rootdirs.has('') && !this.configs.has('')) {
			// collecting all the files in workspace by making fake configuration object
			this.configs.set('', new ProjectConfiguration(this.localFs, '/', this.versions, '', {
				compilerOptions: {
					module: ts.ModuleKind.CommonJS,
					allowNonTsExtensions: false,
					allowJs: true
				}
			}, this.traceModuleResolution, this.logger));
		}
	}
}

/**
 * Implementaton of LanguageServiceHost that works with in-memory file system.
 * It takes file content from local cache and provides it to TS compiler on demand
 *
 * @implements ts.LanguageServiceHost
 */
export class InMemoryLanguageServiceHost implements ts.LanguageServiceHost {

	complete: boolean;

	/**
	 * Root path
	 */
	private rootPath: string;

	/**
	 * Compiler options to use when parsing/analyzing source files.
	 * We are extracting them from tsconfig.json or jsconfig.json
	 */
	private options: ts.CompilerOptions;

	/**
	 * Local file cache where we looking for file content
	 */
	private fs: InMemoryFileSystem;

	/**
	 * List of files that project consist of (based on tsconfig includes/excludes and wildcards).
	 * Each item is a relative file path
	 */
	expectedFilePaths: string[];

	/**
	 * Current list of files that were implicitly added to project
	 * (every time when we need to extract data from a file that we haven't touched yet).
	 * Each item is a relative file path
	 */
	private filePaths: string[];

	/**
	 * Current project version. When something significant is changed, incrementing it to signal TS compiler that
	 * files should be updated and cached data should be invalidated
	 */
	private projectVersion: number;

	/**
	 * Tracks individual files versions to invalidate TS compiler data when single file is changed
	 */
	private versions: Map<string, number>;

	constructor(rootPath: string, options: ts.CompilerOptions, fs: InMemoryFileSystem, expectedFiles: string[], versions: Map<string, number>, private logger: Logger = new NoopLogger()) {
		this.rootPath = rootPath;
		this.options = options;
		this.fs = fs;
		this.expectedFilePaths = expectedFiles;
		this.versions = versions;
		this.projectVersion = 1;
		this.filePaths = [];
	}

	/**
	 * TypeScript uses this method (when present) to compare project's version
	 * with the last known one to decide if internal data should be synchronized
	 */
	getProjectVersion(): string {
		return '' + this.projectVersion;
	}

	/**
	 * Incrementing current project version, telling TS compiler to invalidate internal data
	 */
	incProjectVersion() {
		this.projectVersion++;
	}

	getCompilationSettings(): ts.CompilerOptions {
		return this.options;
	}

	getScriptFileNames(): string[] {
		return this.filePaths;
	}

	/**
	 * Adds a file and increments project version, used in conjunction with getProjectVersion()
	 * which may be called by TypeScript to check if internal data is up to date
	 *
	 * @param filePath relative file path
	 */
	addFile(filePath: string) {
		this.filePaths.push(filePath);
		this.incProjectVersion();
	}

	/**
	 * @param fileName relative or absolute file path
	 */
	getScriptVersion(fileName: string): string {
		if (path_.posix.isAbsolute(fileName) || path_.isAbsolute(fileName)) {
			fileName = path_.posix.relative(this.rootPath, util.toUnixPath(fileName));
		}
		let version = this.versions.get(fileName);
		if (!version) {
			version = 1;
			this.versions.set(fileName, version);
		}
		return '' + version;
	}

	/**
	 * @param fileName relative or absolute file path
	 */
	getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
		let exists = this.fs.fileExists(fileName);
		if (!exists) {
			fileName = path_.posix.join(this.rootPath, fileName);
			exists = this.fs.fileExists(fileName);
		}
		if (!exists) {
			return undefined;
		}
		return ts.ScriptSnapshot.fromString(this.fs.readFile(fileName));
	}

	getCurrentDirectory(): string {
		return this.rootPath;
	}

	getDefaultLibFileName(options: ts.CompilerOptions): string {
		return util.toUnixPath(ts.getDefaultLibFilePath(options));
	}

	trace(message: string) {
		// empty
	}

	log(message: string) {
		// empty
	}

	error(message: string) {
		this.logger.error(message);
	}

}

const localFSPlaceholder = 'var dummy_0ff1bd;';

/**
 * ProjectConfiguration instances track the compiler configuration (as
 * defined by {tj}sconfig.json if it exists) and state for a single
 * TypeScript project. It represents the world of the view as
 * presented to the compiler.
 *
 * For efficiency, a ProjectConfiguration instance may hide some files
 * from the compiler, preventing them from being parsed and
 * type-checked. Depending on the use, the caller should call one of
 * the ensure* methods to ensure that the appropriate files have been
 * made available to the compiler before calling any other methods on
 * the ProjectConfiguration or its public members. By default, no
 * files are parsed.
 */
export class ProjectConfiguration {

	private service?: ts.LanguageService;

	// program is "a collection of SourceFiles and a set of
	// compilation options that represent a compilation unit. The
	// program is the main entry point to the type system and code
	// generation."
	// (https://github.com/Microsoft/TypeScript-wiki/blob/master/Architectural-Overview.md#data-structures)
	private program?: ts.Program;

	/**
	 * Object TS service will use to fetch content of source files
	 */
	private host?: InMemoryLanguageServiceHost;

	/**
	 * Local file cache
	 */
	private fs: InMemoryFileSystem;

	/**
	 * Relative path to configuration file (tsconfig.json/jsconfig.json)
	 */
	private configFilePath: string;

	/**
	 * Configuration JSON object. May be used when there is no real configuration file to parse and use
	 */
	private configContent: any;

	/**
	 * Relative source file path (relative) -> version associations
	 */
	private versions: Map<string, number>;

	/**
	 * Enables module resolution tracing (done by TS service)
	 */
	private traceModuleResolution: boolean;

	/**
	 * Root file path, relative to workspace hierarchy root
	 */
	private rootFilePath: string;

	/**
	 * @param fs file system to use
	 * @param rootFilePath root file path, relative to workspace hierarchy root
	 * @param configFilePath configuration file path (relative to workspace root)
	 * @param configContent optional configuration content to use instead of reading configuration file)
	 */
	constructor(fs: InMemoryFileSystem, rootFilePath: string, versions: Map<string, number>, configFilePath: string, configContent?: any, traceModuleResolution?: boolean, private logger: Logger = new NoopLogger()) {
		this.fs = fs;
		this.configFilePath = configFilePath;
		this.configContent = configContent;
		this.versions = versions;
		this.traceModuleResolution = traceModuleResolution || false;
		this.rootFilePath = rootFilePath;
	}

	/**
	 * @return module resolution host to use by TS service
	 */
	moduleResolutionHost(): ts.ModuleResolutionHost {
		return this.fs;
	}

	/**
	 * reset resets a ProjectConfiguration to its state immediately
	 * after construction. It should be called whenever the underlying
	 * local filesystem (fs) has changed, and so the
	 * ProjectConfiguration can no longer assume its state reflects
	 * that of the underlying files.
	 */
	reset(): void {
		this.initialized = undefined;
		this.ensuredBasicFiles = undefined;
		this.ensuredAllFiles = undefined;
		this.service = undefined;
		this.program = undefined;
		this.host = undefined;
	}

	/**
	 * @return package name (project name) of a given project
	 */
	getPackageName(): string | null {
		// package.json may be located at the upper level as well
		let currentDir = this.rootFilePath;
		while (true) {
			const pkgJsonFile = path_.posix.join(currentDir, 'package.json');
			if (this.fs.fileExists(pkgJsonFile)) {
				return JSON.parse(this.fs.readFile(pkgJsonFile)).name;
			}
			const parentDir = path_.dirname(currentDir);
			if (parentDir === '.' || parentDir === '/' || parentDir === currentDir) {
				return null;
			}
			currentDir = parentDir;
		}
	}

	/**
	 * @return language service object
	 */
	getService(): ts.LanguageService {
		if (!this.service) {
			throw new Error('project is uninitialized');
		}
		return this.service;
	}

	/**
	 * Note that it does not perform any parsing or typechecking
	 * @return program object (cached result of parsing and typechecking done by TS service)
	 */
	getProgram(): ts.Program {
		if (!this.program) {
			throw new Error('project is uninitialized');
		}
		return this.program;
	}

	/**
	 * @return language service host that TS service uses to read the data
	 */
	getHost(): InMemoryLanguageServiceHost {
		if (!this.host) {
			throw new Error('project is uninitialized');
		}
		return this.host;
	}

	/**
	 * Tells TS service to recompile program (if needed) based on current list of files and compilation options.
	 * TS service relies on information provided by language servide host to see if there were any changes in
	 * the whole project or in some files
	 */
	syncProgram(): void {
		this.program = this.getService().getProgram();
	}

	private initialized?: Promise<void>;

	/**
	 * Initializes (sub)project by parsing configuration and making proper internal objects
	 */
	private init(): Promise<void> {
		if (this.initialized) {
			return this.initialized;
		}
		this.initialized = new Promise<void>((resolve, reject) => {
			let configObject;
			if (!this.configContent) {
				const jsonConfig = ts.parseConfigFileTextToJson(this.configFilePath, this.fs.readFile(this.configFilePath));
				if (jsonConfig.error) {
					this.logger.error('Cannot parse ' + this.configFilePath + ': ' + jsonConfig.error.messageText);
					return reject(new Error('Cannot parse ' + this.configFilePath + ': ' + jsonConfig.error.messageText));
				}
				configObject = jsonConfig.config;
			} else {
				configObject = this.configContent;
			}
			let dir = path_.posix.dirname(this.configFilePath);
			if (dir === '.') {
				dir = '';
			}
			const base = dir || this.fs.path;
			const configParseResult = ts.parseJsonConfigFileContent(configObject, this.fs, base);
			const expFiles = configParseResult.fileNames;

			// Add globals that might exist in dependencies
			const nodeModulesDir = path_.posix.join(base, 'node_modules');
			const err = walkInMemoryFs(this.fs, nodeModulesDir, (path, isdir) => {
				if (!isdir && util.isGlobalTSFile(path)) {
					expFiles.push(path);
				}
			});
			if (err) {
				return reject(err);
			}

			const options = configParseResult.options;
			if (/(^|\/)jsconfig\.json$/.test(this.configFilePath)) {
				options.allowJs = true;
			}
			if (this.traceModuleResolution) {
				options.traceResolution = true;
			}
			this.host = new InMemoryLanguageServiceHost(
				this.fs.path,
				options,
				this.fs,
				expFiles,
				this.versions,
				this.logger
			);
			this.service = ts.createLanguageService(this.host, ts.createDocumentRegistry());
			this.program = this.service.getProgram();
			return resolve();
		});
		return this.initialized;
	}

	/**
	 * Ensures we are ready to process files from a given sub-project
	 */
	ensureConfigFile(): Promise<void> {
		return this.init();
	}

	private ensuredBasicFiles?: Promise<void>;

	/**
	 * Ensures we fetched basic files (global TS files, dependencies, declarations)
	 */
	async ensureBasicFiles(): Promise<void> {
		if (this.ensuredBasicFiles) {
			return this.ensuredBasicFiles;
		}

		this.ensuredBasicFiles = this.init().then(() => {
			let changed = false;
			for (const fileName of (this.getHost().expectedFilePaths || [])) {
				if (util.isGlobalTSFile(fileName) || (!util.isDependencyFile(fileName) && util.isDeclarationFile(fileName))) {
					const sourceFile = this.getProgram().getSourceFile(fileName);
					if (!sourceFile) {
						this.getHost().addFile(fileName);
						changed = true;
					}
				}
			}
			if (changed) {
				// requery program object to synchonize LanguageService's data
				this.program = this.getService().getProgram();
			}
		});
		return this.ensuredBasicFiles;
	}

	private ensuredAllFiles?: Promise<void>;

	/**
	 * Ensures we fetched all project's source file (as were defined in tsconfig.json)
	 */
	async ensureAllFiles(): Promise<void> {
		if (this.ensuredAllFiles) {
			return this.ensuredAllFiles;
		}

		this.ensuredAllFiles = this.init().then(() => {
			if (this.getHost().complete) {
				return;
			}
			let changed = false;
			for (const fileName of (this.getHost().expectedFilePaths || [])) {
				const sourceFile = this.getProgram().getSourceFile(fileName);
				if (!sourceFile) {
					this.getHost().addFile(fileName);
					changed = true;
				}
			}
			if (changed) {
				// requery program object to synchonize LanguageService's data
				this.program = this.getService().getProgram();
			}
			this.getHost().complete = true;
		});
		return this.ensuredAllFiles;
	}
}
