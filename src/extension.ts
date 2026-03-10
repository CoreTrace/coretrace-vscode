import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SidebarProvider, type HostMessage } from './SidebarProvider';
import { locateBinary }       from './ctrace/BinaryLocator';
import { buildCommand }       from './ctrace/CommandBuilder';
import { runCommand }         from './ctrace/AnalysisRunner';
import { parseSarifOutput, countResults } from './ctrace/SarifParser';
import { updateDiagnostics }  from './ctrace/DiagnosticsManager';

// Parameters passed by the webview when triggering an analysis run.
export interface AnalysisParams {
    customParams?: string;
}

export function activate(context: vscode.ExtensionContext) {

    // ── Output channel ───────────────────────────────────────────────────────
    const output = vscode.window.createOutputChannel('Ctrace');
    context.subscriptions.push(output);

    // ── Sidebar ──────────────────────────────────────────────────────────────
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    // Register the provider itself as a Disposable so its view-scoped
    // subscriptions are guaranteed to be released on extension deactivation,
    // even if `onDidDispose` is never fired by VS Code.
    context.subscriptions.push(sidebarProvider);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('ctrace-audit-view', sidebarProvider)
    );

    // ── Diagnostics collection ───────────────────────────────────────────────
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('ctrace');
    context.subscriptions.push(diagnosticCollection);

    // ── Command: ctrace.runAnalysis ──────────────────────────────────────────
    // Guard against concurrent invocations (e.g. a second postMessage arriving
    // while the first analysis is still running, or a keyboard shortcut being
    // triggered while the sidebar button is already spinning).
    let isRunning = false;
    // Monotonic counter that makes every run's report file name unique.
    // Using pid alone caused a race: the fire-and-forget unlink from run N
    // could resolve after run N+1 had already written the same path.
    let runSeq = 0;
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.runAnalysis', async (arg?: AnalysisParams | string) => {
            if (isRunning) {
                vscode.window.showWarningMessage('An analysis is already in progress.');
                return;
            }
            isRunning = true;
            const params = resolveParams(arg);

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active file to analyse.');
                sidebarProvider.postMessage({ type: 'analysis-error' });
                isRunning = false;
                return;
            }

            const filePath = editor.document.uri.fsPath;

            if (!vscode.workspace.workspaceFolders?.length) {
                vscode.window.showErrorMessage('Please open a workspace folder.');
                sidebarProvider.postMessage({ type: 'analysis-error' });
                isRunning = false;
                return;
            }

            // Locate binary
            const ctracePath = await locateBinary(context.extensionUri.fsPath);
            if (!ctracePath) {
                vscode.window.showErrorMessage(
                    `Ctrace binary not found in extension folder: ${context.extensionUri.fsPath}`
                );
                sidebarProvider.postMessage({ type: 'analysis-error' });
                isRunning = false;
                return;
            }

            // Build command (also validates params — throws on unsafe input).
            // Async on Windows: the fallback path copies the binary to %TEMP%
            // using non-blocking I/O to avoid stalling the extension host.
            let built: Awaited<ReturnType<typeof buildCommand>>;
            try {
                built = await buildCommand(ctracePath, filePath, params);
            } catch (e) {
                vscode.window.showErrorMessage(`Invalid analysis parameters: ${e}`);
                sidebarProvider.postMessage({ type: 'analysis-error' });
                isRunning = false;
                return;
            }
            const { tempFiles } = built;
            const commandLabel = built.command ?? `${built.file} ${built.args?.join(' ')}`;
            console.log('[ctrace] Running:', commandLabel);

            // ctrace resolves ./tscancode, ./ikos etc. relative to its own directory
            const extensionPath = context.extensionUri.fsPath;

            // Unique per-run path: pid + monotonic counter.
            // A pid-only path was subject to a race condition where the
            // fire-and-forget unlink from the previous run could resolve after
            // the current run had already written its report to the same path.
            // With a unique path every run owns its file; no pre-run cleanup
            // is needed and the finally block handles removal alongside other
            // temp files.
            const reportPath = path.join(os.tmpdir(), `ctrace-report-${process.pid}-${++runSeq}.txt`);

            // Execute with progress notification
            output.show(true); // show without stealing focus
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Running Ctrace Analysis…', cancellable: true },
                async (_progress, token) => {
                    let stdout = '', stderr = '';
                    let exitCode: number | null = null;
                    try {
                        const result = await runCommand(built, extensionPath, token);
                        ({ stdout, stderr, exitCode } = result);

                        if (result.killed) {
                            sidebarProvider.postMessage({ type: 'analysis-error' });
                            if (!token.isCancellationRequested) {
                                vscode.window.showErrorMessage('Ctrace analysis timed out (2 min). Consider simplifying the entry points or checking for infinite loops.');
                                output.appendLine('[timed out]');
                            }
                            return;
                        }

                        // Display raw output in the Output channel
                        output.clear();
                        output.appendLine(`$ ${commandLabel}`);
                        output.appendLine('');
                        if (stdout) { output.appendLine(stdout); }
                        if (stderr) { output.appendLine('[stderr] ' + stderr); }
                        output.appendLine(`[exit code: ${exitCode ?? 0}]`);

                        // Parse results
                        const sarif = await parseSarifOutput(stdout, reportPath);

                        if (!sarif) {
                            handleNoResults(stdout, stderr, exitCode);
                            sidebarProvider.postMessage({ type: 'analysis-error' });
                            return;
                        }

                        const total = countResults(sarif);

                        updateDiagnostics(sarif, diagnosticCollection, filePath);

                        sidebarProvider.postMessage({
                            type: 'analysis-result',
                            data: sarif,
                        } satisfies HostMessage);

                        vscode.window.showInformationMessage(
                            total > 0
                                ? `Analysis complete — ${total} issue${total > 1 ? 's' : ''} found.`
                                : 'Analysis complete — no issues found.'
                        );
                    } catch (e) {
                        // Unexpected error (e.g. execFile failure, FS error) — unblock the button.
                        sidebarProvider.postMessage({ type: 'analysis-error' });
                        vscode.window.showErrorMessage(`Ctrace analysis failed unexpectedly: ${e}`);
                        output.appendLine(`[error] ${e}`);
                    } finally {
                        // Always clean up temp files and the per-run report, even on crash/throw.
                        [...tempFiles, reportPath].forEach(tryDelete);
                        isRunning = false;
                    }
                }
            );
        })
    );
}

export function deactivate() {}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveParams(arg: AnalysisParams | string | undefined): string {
    const defaultParams = '--entry-points=main';
    if (typeof arg === 'string')                             { return arg; }
    if (arg && typeof arg === 'object' && arg.customParams) { return arg.customParams; }
    return defaultParams;
}

function tryDelete(filePath: string): Promise<void> {
    return fs.promises.unlink(filePath).catch((e: NodeJS.ErrnoException) => {
        // ENOENT is expected when the file was never created — suppress it.
        if (e.code !== 'ENOENT') {
            console.warn('[ctrace] Could not delete file:', filePath, e.message);
        }
    });
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
