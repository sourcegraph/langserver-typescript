import * as vscode from 'vscode-languageserver';

export interface InitializeParams extends vscode.InitializeParams {
	capabilities: ClientCapabilities;
}

export interface ClientCapabilities extends vscode.ClientCapabilities {

	/**
	 * The client provides support for workspace/xfiles.
	 */
	xfilesProvider?: boolean;

	/**
	 * The client provides support for textDocument/xcontent.
	 */
	xcontentProvider?: boolean;
}

export interface ServerCapabilities extends vscode.ServerCapabilities {
	xworkspaceReferencesProvider?: boolean;
	xdefinitionProvider?: boolean;
	xdependenciesProvider?: boolean;
	xpackagesProvider?: boolean;
}

export interface TextDocumentContentParams {

	/**
	 * The text document to receive the content for.
	 */
	textDocument: vscode.TextDocumentIdentifier;
}

export interface WorkspaceFilesParams {

	/**
	 * The URI of a directory to search.
	 * Can be relative to the rootPath.
	 * If not given, defaults to rootPath.
	 */
	base?: string;
}

/**
 * Represents information about a programming construct that can be used to identify and locate the
 * construct's symbol. The identification does not have to be unique, but it should be as unique as
 * possible. It is up to the language server to define the schema of this object.
 *
 * In contrast to `SymbolInformation`, `SymbolDescriptor` includes more concrete, language-specific,
 * metadata about the symbol.
 */
export interface SymbolDescriptor {
	kind: string;
	name: string;
	containerKind: string;
	containerName: string;
	package?: PackageDescriptor;
}

export namespace SymbolDescriptor {
	export function create(kind: string, name: string, containerKind: string, containerName: string, pkg?: PackageDescriptor): SymbolDescriptor {
		return { kind, name, containerKind, containerName, package: pkg };
	}
}

/*
 * WorkspaceReferenceParams holds parameters for the extended
 * workspace/symbols endpoint (an extension of the original LSP spec).
 * If both properties are set, the requirements are AND'd.
 */
export interface WorkspaceSymbolParams {
	/**
	 * A non-empty query string.
	 */
	query?: string;

	/**
	 * A set of properties that describe the symbol to look up.
	 */
	symbol?: Partial<SymbolDescriptor>;

	/**
	 * The number of items to which to restrict the results set size.
	 */
	limit?: number;
}

/*
 * WorkspaceReferenceParams holds parameters for the
 * workspace/xreferences endpoint (an extension of the original LSP
 * spec).
 */
export interface WorkspaceReferenceParams {

	/**
	 * Metadata about the symbol that is being searched for.
	 */
	query: Partial<SymbolDescriptor>;

	/**
	 * Hints provides optional hints about where the language server should look in order to find
	 * the symbol (this is an optimization). It is up to the language server to define the schema of
	 * this object.
	 */
	hints?: DependencyHints;
}

export interface SymbolLocationInformation {

	/**
	 * The location where the symbol is defined, if any
	 */
	location?: vscode.Location;

	/**
	 * Metadata about the symbol that can be used to identify or locate its definition.
	 */
	symbol: SymbolDescriptor;
}

/**
 * Represents information about a reference to programming constructs like variables, classes,
 * interfaces, etc.
 */
export interface ReferenceInformation {
	 /**
	  * The location in the workspace where the `symbol` is referenced.
	  */
	reference: vscode.Location;

	/**
	 * Metadata about the symbol that can be used to identify or locate its definition.
	 */
	symbol: SymbolDescriptor;
}

export interface PackageInformation {
	package: PackageDescriptor;
	dependencies: DependencyReference[];
}

export interface PackageDescriptor {
	name: string;
	version?: string;
	repoURL?: string;
}

export interface DependencyHints {
	dependeePackageName?: string;
}

export interface DependencyReference {
	attributes: PackageDescriptor;
	hints: DependencyHints;
}
