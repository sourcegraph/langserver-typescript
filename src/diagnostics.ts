import * as ts from 'typescript';
import { DiagnosticSeverity, PublishDiagnosticsParams } from 'vscode-languageserver';
import { LanguageClient } from './lang-handler';
import * as util from './util';

/**
 * Receives file diagnostics (typically implemented to send diagnostics to client)
 */
export interface DiagnosticsHandler {
	updateFileDiagnostics(diagnostics: ts.Diagnostic[]): void;
}

/**
 * Forwards diagnostics from typescript calls to LSP diagnostics
 */
export class DiagnosticsPublisher implements DiagnosticsHandler {
	/**
	 * The files that were last reported to have errors
	 * If they don't appear in the next update, we must publish empty diagnostics for them.
	 */
	private problemFiles: Set<string> = new Set();

	/**
	 * Requires a connection to the remote client to send diagnostics to
	 * @param remoteClient
	 */
	constructor(private remoteClient: LanguageClient) {}

	/**
	 * Receives file diagnostics from eg. ts.getPreEmitDiagnostics
	 * Diagnostics are grouped and published by file, empty diagnostics are sent for files
	 * not present in subsequent updates.
	 * @param diagnostics
	 */
	updateFileDiagnostics(diagnostics: ts.Diagnostic[]): void {

		// categorize diagnostics by file
		const diagnosticsByFile = this.groupByFile(diagnostics);

		// add empty diagnostics for fixed files, so client marks them as resolved
		this.problemFiles.forEach(file => {
			if (!diagnosticsByFile.has(file)) {
				diagnosticsByFile.set(file, []);
			}
		});
		this.problemFiles.clear();

		// for each file: publish and set as problem file
		diagnosticsByFile.forEach((diagnostics, file) => {
			this.publishFileDiagnostics(file, diagnostics);
			if (diagnostics.length > 0) {
				this.problemFiles.add(file);
			}
		});
	}

	/**
	 * Converts a diagnostic category to an LSP DiagnosticSeverity
	 * @param category The Typescript DiagnosticCategory
	 */
	private parseDiagnosticCategory(category: ts.DiagnosticCategory): DiagnosticSeverity {
		switch (category) {
			case ts.DiagnosticCategory.Error:
				return DiagnosticSeverity.Error;
			case ts.DiagnosticCategory.Warning:
				return DiagnosticSeverity.Warning;
			case ts.DiagnosticCategory.Message:
				return DiagnosticSeverity.Information;
				// unmapped: DiagnosticSeverity.Hint
		}
	}

	/**
	 * Sends given diagnostics for a file to the remote client
	 * @param file Absolute path as specified from the TS API
	 * @param diagnostics Matching file diagnostics from the TS API, empty to clear errors for file
	 */
	private publishFileDiagnostics(file: string, diagnostics: ts.Diagnostic[]): void {
		const params: PublishDiagnosticsParams = {
			uri: util.path2uri('', file),
			diagnostics: diagnostics.map(d => {
				const text = ts.flattenDiagnosticMessageText(d.messageText, '\n');
				return {
					range: {
						start: d.file.getLineAndCharacterOfPosition(d.start),
						end: d.file.getLineAndCharacterOfPosition(d.start + d.length)
					},
					message: text,
					severity: this.parseDiagnosticCategory(d.category),
					code: d.code,
					source: 'ts'
				};
			})
		};
		this.remoteClient.textDocumentPublishDiagnostics(params);
	}

	/**
	 * Groups all diagnostics per file they were reported on so they can be stored and sent in batches
	 * @param diagnostics All diagnostics received in an update
	 */
	private groupByFile(diagnostics: ts.Diagnostic[]): Map<string, ts.Diagnostic[]> {
		const diagnosticsByFile: Map<string, ts.Diagnostic[]> = new Map();
		diagnostics.forEach(d => {
			const diagnosticsForFile = diagnosticsByFile.get(d.file.fileName);
			if (!diagnosticsForFile) {
				diagnosticsByFile.set(d.file.fileName, [d]);
			} else {
				diagnosticsForFile.push(d);
			}
		});
		return diagnosticsByFile;
	}
}
