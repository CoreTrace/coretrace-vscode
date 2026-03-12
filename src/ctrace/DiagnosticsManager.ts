import * as vscode from 'vscode';
import * as path   from 'path';
import type { SarifLog } from '../types/sarif';

/**
 * Translates a SARIF result set into VS Code Diagnostics and updates the
 * provided DiagnosticCollection.
 *
 * Results are grouped by their `artifactLocation.uri` so that issues reported
 * in header files or other translation units land on the correct document.
 * When a URI cannot be resolved the `fallbackFilePath` is used instead.
 */
export function updateDiagnostics(
    sarifData: SarifLog,
    collection: vscode.DiagnosticCollection,
    fallbackFilePath: string
): void {
    collection.clear();

    if (!sarifData?.runs?.length) { return; }

    // Map from resolved fs-path → diagnostics for that file.
    const byFile = new Map<string, vscode.Diagnostic[]>();

    const push = (fsPath: string, d: vscode.Diagnostic) => {
        const list = byFile.get(fsPath);
        if (list) { list.push(d); } else { byFile.set(fsPath, [d]); }
    };

    for (const run of sarifData.runs) {
        for (const result of (run.results ?? [])) {
            const region = result.locations?.[0]?.physicalLocation?.region;
            if (!region) { continue; }

            const startLine = Math.max(0, (region.startLine ?? 1) - 1);
            const startCol  = Math.max(0, (region.startColumn ?? 1) - 1);
            const endLine   = Math.max(startLine,   ((region.endLine   || region.startLine   || 1) - 1));
            const endCol    = Math.max(startCol + 1, ((region.endColumn || region.startColumn || 1) - 1));

            const range      = new vscode.Range(startLine, startCol, endLine, endCol);
            const message    = result.message?.text ?? 'Unknown issue';
            const severity   = sarifLevelToVsCode(result.level);
            const diagnostic = new vscode.Diagnostic(range, message, severity);
            diagnostic.source = 'Ctrace';
            diagnostic.code   = result.ruleId;

            const artifactUri = result.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
            const fsPath = resolveArtifactPath(artifactUri, fallbackFilePath);
            push(fsPath, diagnostic);
        }
    }

    for (const [fsPath, diagnostics] of byFile) {
        collection.set(vscode.Uri.file(fsPath), diagnostics);
    }
}

/**
 * Converts a WSL mount path (produced by ctrace running inside WSL on Windows)
 * to a Windows-style absolute path so `vscode.Uri.file()` resolves it correctly.
 *
 * Handles both POSIX-separator form   /mnt/c/Users/...
 * and backslash-escaped form          \\mnt\\c\\Users\\...
 *
 * On non-Windows hosts the path is returned unchanged because `/mnt/...` is a
 * legitimate native mount point there.
 */
function normaliseMountPath(p: string): string {
    if (process.platform !== 'win32') { return p; }
    // Normalise backslash variants to forward slashes first.
    const forward = p.replace(/\\/g, '/');
    // /mnt/<drive>/rest  →  <DRIVE>:/rest
    return forward.replace(
        /^\/{1,2}mnt\/([a-zA-Z])\//,
        (_, drive: string) => `${drive.toUpperCase()}:/`
    );
}

/**
 * Resolves a SARIF `artifactLocation.uri` to an absolute filesystem path.
 *
 * Resolution order:
 * 1. `file://` URI              → strip scheme, decode percent-encoding, normalise WSL mount
 * 2. WSL `/mnt/<drive>/` path  → convert to `<DRIVE>:/` (Windows only)
 * 3. Other absolute POSIX path  → use as-is
 * 4. Relative path              → resolve against the directory of `fallbackFilePath`
 * 5. Missing / unparseable      → return `fallbackFilePath`
 */
function resolveArtifactPath(uri: string | undefined, fallbackFilePath: string): string {
    if (!uri) { return fallbackFilePath; }
    try {
        if (uri.startsWith('file://')) {
            // vscode.Uri.parse handles percent-encoding and platform differences.
            return normaliseMountPath(vscode.Uri.parse(uri).fsPath);
        }
        if (path.isAbsolute(uri)) {
            // Absolute paths from WSL may use /mnt/<drive>/... notation on
            // Windows; normalise them so vscode.Uri.file() maps to the correct
            // workspace document.
            return normaliseMountPath(uri);
        }
        // Relative path — resolve against the directory of the analysed file.
        return path.resolve(path.dirname(fallbackFilePath), uri);
    } catch {
        return fallbackFilePath;
    }
}

function sarifLevelToVsCode(level: 'error' | 'warning' | 'note' | 'none' | undefined): vscode.DiagnosticSeverity {
    switch (level) {
        case 'error':   return vscode.DiagnosticSeverity.Error;
        case 'warning': return vscode.DiagnosticSeverity.Warning;
        case 'note':    return vscode.DiagnosticSeverity.Information;
        default:        return vscode.DiagnosticSeverity.Warning;
    }
}

