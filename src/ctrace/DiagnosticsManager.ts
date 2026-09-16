import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SarifLog } from '../types/sarif';

/**
 * Translates a SARIF result set into VS Code Diagnostics and updates the
 * provided DiagnosticCollection.
 *
 * Each result is mapped to its actual file path as declared in the SARIF
 * artifactLocation.uri field (resolved relative to workspace root or analysedFilePath).
 * Falls back to analysedFilePath when no URI is present.
 *
 * @param clearFirst  Set to false when calling inside a workspace scan loop
 *                    to avoid wiping earlier results. Caller must clear once
 *                    before the loop instead.
 */
export function updateDiagnostics(
    sarifData: SarifLog | any,
    collection: vscode.DiagnosticCollection,
    analysedFilePath: string,
    clearFirst = true
): void {
    if (clearFirst) { collection.clear(); }

    if (!sarifData?.runs?.length) { return; }

    const allResults: any[] = sarifData.runs.flatMap((r: any) => r.results ?? []);

    // Group diagnostics by resolved absolute file path
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const fileDir = path.dirname(analysedFilePath);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    for (const result of allResults) {
        const physLoc = result.locations?.[0]?.physicalLocation;
        const region  = physLoc?.region;
        if (!region) { continue; }

        // ── Resolve the target file ───────────────────────────────────────────
        let targetFile = analysedFilePath;
        const uriStr: string | undefined = physLoc?.artifactLocation?.uri;
        if (uriStr) {
            if (uriStr.startsWith('file://')) {
                targetFile = vscode.Uri.parse(uriStr).fsPath;
            } else if (workspaceRoot && fs.existsSync(path.resolve(workspaceRoot, uriStr))) {
                targetFile = path.resolve(workspaceRoot, uriStr);
            } else if (fs.existsSync(uriStr)) {
                targetFile = uriStr;
            } else if (fs.existsSync(path.resolve(fileDir, uriStr))) {
                targetFile = path.resolve(fileDir, uriStr);
            } else {
                targetFile = analysedFilePath;
            }
        }

        // ── Build range (SARIF lines are 1-based) ────────────────────────────
        const startLine = Math.max(0, (region.startLine ?? 1) - 1);
        const startCol  = Math.max(0, (region.startColumn ?? 1) - 1);
        const endLine   = Math.max(startLine, ((region.endLine   || region.startLine   || 1) - 1));
        const endCol    = Math.max(startCol + 1, ((region.endColumn || region.startColumn || 1) - 1));

        const range      = new vscode.Range(startLine, startCol, endLine, endCol);
        const message    = result.message?.text ?? 'Unknown issue';
        const severity   = sarifLevelToVsCode(result.level);
        const diagnostic = new vscode.Diagnostic(range, message, severity);
        diagnostic.source = 'Ctrace';
        diagnostic.code   = result.ruleId;

        if (!byFile.has(targetFile)) { byFile.set(targetFile, []); }
        byFile.get(targetFile)!.push(diagnostic);
    }

    byFile.forEach((diagnostics, fp) => {
        collection.set(vscode.Uri.file(fp), diagnostics);
    });
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

function sarifLevelToVsCode(level: 'error' | 'warning' | 'note' | 'none' | string | undefined): vscode.DiagnosticSeverity {
    switch ((level ?? '').toLowerCase()) {
        case 'error':   return vscode.DiagnosticSeverity.Error;
        case 'warning': return vscode.DiagnosticSeverity.Warning;
        case 'note':    return vscode.DiagnosticSeverity.Information;
        default:        return vscode.DiagnosticSeverity.Warning;
    }
}

