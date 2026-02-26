import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { SidebarProvider }    from './SidebarProvider';
import { locateBinary }       from './ctrace/BinaryLocator';
import { buildCommand }       from './ctrace/CommandBuilder';
import { runCommand }         from './ctrace/AnalysisRunner';
import { parseSarifOutput, countResults } from './ctrace/SarifParser';
import { updateDiagnostics }  from './ctrace/DiagnosticsManager';

export function activate(context: vscode.ExtensionContext) {

    // ── Output channel ───────────────────────────────────────────────────────
    const output = vscode.window.createOutputChannel('Ctrace');
    context.subscriptions.push(output);

    // ── Sidebar ──────────────────────────────────────────────────────────────
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('ctrace-audit-view', sidebarProvider)
    );

    // ── Diagnostics collection ───────────────────────────────────────────────
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('ctrace');
    context.subscriptions.push(diagnosticCollection);

    // ── Command: ctrace.runAnalysis ──────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.runAnalysis', async (arg?: any) => {
            const params = resolveParams(arg);

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active file to analyse.');
                return;
            }

            const filePath      = editor.document.uri.fsPath;
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;

            if (!workspaceRoot) {
                vscode.window.showErrorMessage('Please open a workspace folder.');
                return;
            }

            // Locate binary
            const ctracePath = locateBinary(context.extensionUri.fsPath);
            if (!ctracePath) {
                vscode.window.showErrorMessage(
                    `Ctrace binary not found in extension folder: ${context.extensionUri.fsPath}`
                );
                return;
            }

            // Build command
            const { command, tempFiles } = buildCommand(ctracePath, filePath, params);
            console.log('[ctrace] Running:', command);

            // ctrace resolves ./tscancode, ./ikos etc. relative to its own directory
            const extensionPath = context.extensionUri.fsPath;

            // Remove stale report file
            const reportPath = path.join(extensionPath, 'ctrace-report.txt');
            tryDelete(reportPath);

            // Execute with progress notification
            output.show(true); // show without stealing focus
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Running Ctrace Analysis…', cancellable: false },
                async () => {
                    const { stdout, stderr, exitCode } = await runCommand(command, extensionPath);

                    // Display raw output in the Output channel
                    output.clear();
                    output.appendLine(`$ ${command}`);
                    output.appendLine('');
                    if (stdout) { output.appendLine(stdout); }
                    if (stderr) { output.appendLine('[stderr] ' + stderr); }
                    output.appendLine(`[exit code: ${exitCode ?? 0}]`);

                    // Always clean up temp files
                    tempFiles.forEach(tryDelete);

                    // Parse results
                    const sarif = parseSarifOutput(stdout, reportPath);

                    if (!sarif) {
                        handleNoResults(stdout, stderr, exitCode);
                        return;
                    }

                    const total = countResults(sarif);

                    updateDiagnostics(sarif, diagnosticCollection, filePath);

                    sidebarProvider._view?.webview.postMessage({
                        type: 'analysis-result',
                        data: sarif,
                    });

                    vscode.window.showInformationMessage(
                        total > 0
                            ? `Analysis complete — ${total} issue${total > 1 ? 's' : ''} found.`
                            : 'Analysis complete — no issues found.'
                    );
                }
            );
        })
    );
}

export function deactivate() {}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveParams(arg: any): string {
    const defaultParams = '--entry-points=main';
    if (typeof arg === 'string')                             { return arg; }
    if (arg && typeof arg === 'object' && arg.customParams) { return arg.customParams; }
    return defaultParams;
}

function tryDelete(filePath: string): void {
    try {
        if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
    } catch (e) {
        console.warn('[ctrace] Could not delete file:', filePath, e);
    }
}

const CRASH_SIGNATURES = [
    'AddressSanitizer', 'Segmentation fault', 'core dumped',
    'Assertion failed', 'stack-overflow',
];

function handleNoResults(stdout: string, stderr: string, exitCode: number | null): void {
    const combined = stdout + stderr;
    const crash    = CRASH_SIGNATURES.find(sig => combined.includes(sig));

    if (crash) {
        vscode.window.showErrorMessage(
            `Ctrace crashed (${crash}). This is likely a bug in the analysis tool. See the Debug Console.`
        );
    } else if (exitCode !== null && exitCode !== 0) {
        vscode.window.showErrorMessage(
            `Ctrace exited with code ${exitCode}. ${stderr.substring(0, 200)}`
        );
    } else {
        vscode.window.showWarningMessage(
            'Analysis finished but no results could be parsed. Check the Debug Console for raw output.'
        );
    }
}
