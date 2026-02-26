import * as vscode from 'vscode';

/**
 * Translates a SARIF result set into VS Code Diagnostics and updates the
 * provided DiagnosticCollection.
 *
 * All results are mapped to `filePath` because ctrace currently analyses one
 * file at a time.
 */
export function updateDiagnostics(
    sarifData: any,
    collection: vscode.DiagnosticCollection,
    filePath: string
): void {
    collection.clear();

    if (!sarifData?.runs?.length) { return; }

    const allResults: any[] = sarifData.runs.flatMap((r: any) => r.results ?? []);
    const diagnostics: vscode.Diagnostic[] = [];

    for (const result of allResults) {
        const region = result.locations?.[0]?.physicalLocation?.region;
        if (!region) { continue; }

        const startLine = Math.max(0, (region.startLine ?? 1) - 1);
        const startCol  = Math.max(0, (region.startColumn ?? 1) - 1);
        // endLine/endColumn may be 0 when not set — fall back to start position
        const endLine   = Math.max(startLine, ((region.endLine || region.startLine || 1) - 1));
        const endCol    = Math.max(startCol + 1, ((region.endColumn || region.startColumn || 1) - 1));

        const range      = new vscode.Range(startLine, startCol, endLine, endCol);
        const message    = result.message?.text ?? 'Unknown issue';
        const severity   = sarifLevelToVsCode(result.level);
        const diagnostic = new vscode.Diagnostic(range, message, severity);
        diagnostic.source = 'Ctrace';
        diagnostic.code   = result.ruleId;

        diagnostics.push(diagnostic);
    }

    if (diagnostics.length > 0) {
        collection.set(vscode.Uri.file(filePath), diagnostics);
    }
}

function sarifLevelToVsCode(level: string | undefined): vscode.DiagnosticSeverity {
    switch ((level ?? '').toLowerCase()) {
        case 'error':   return vscode.DiagnosticSeverity.Error;
        case 'warning': return vscode.DiagnosticSeverity.Warning;
        case 'note':    return vscode.DiagnosticSeverity.Information;
        default:        return vscode.DiagnosticSeverity.Warning;
    }
}
