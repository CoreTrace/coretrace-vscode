import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { SidebarProvider }    from './SidebarProvider';
import { locateBinary }       from './ctrace/BinaryLocator';
import { buildCommand }       from './ctrace/CommandBuilder';
import { runCommand }         from './ctrace/AnalysisRunner';
import { parseSarifOutput, countResults } from './ctrace/SarifParser';
import { updateDiagnostics }  from './ctrace/DiagnosticsManager';
import { buildCtraceArgs, createReportPath, shellQuoteArgs, CtraceUIState } from './ctraceRunner';
import { getFunctionSymbols } from './utils/symbolExtractor';
import { CtraceCodeLensProvider } from './codelens/CtraceCodeLensProvider';

export function activate(context: vscode.ExtensionContext) {

    // ── Output channel ───────────────────────────────────────────────────────
    const output = vscode.window.createOutputChannel('Ctrace');
    context.subscriptions.push(output);

    // ── Sidebar ──────────────────────────────────────────────────────────────
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('ctrace-audit-view', sidebarProvider)
    );

    const codeLensProvider = new CtraceCodeLensProvider();
    for (const language of ['c', 'cpp', 'objective-c', 'objective-cpp']) {
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider({ language }, codeLensProvider)
        );
    }

    // ── Diagnostics collection ───────────────────────────────────────────────
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('ctrace');
    context.subscriptions.push(diagnosticCollection);

    // ── Command: ctrace.runAnalysis ──────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.runAnalysis', async (arg?: any) => {
            const uiState: CtraceUIState = arg?.uiState ?? {};
            const scanMode: 'file' | 'workspace' = arg?.scanMode === 'workspace' || arg?.scanWorkspace === true
                ? 'workspace'
                : 'file';
            const scanWorkspace = scanMode === 'workspace';

            // ── Determine files to analyse ───────────────────────────────────
            let filesToAnalyze: string[];

            if (scanWorkspace) {
                const uris = await vscode.workspace.findFiles(
                    '**/*.{c,cpp,cc,cxx}',
                    '{**/node_modules/**,**/.git/**}'
                );
                if (uris.length === 0) {
                    vscode.window.showWarningMessage('No C/C++ files found in the current workspace.');
                    sidebarProvider._view?.webview.postMessage({ type: 'analysis-done' });
                    return;
                }
                filesToAnalyze = uris.map(u => u.fsPath);
            } else {
                const targetUri = arg?.filePath
                    ? vscode.Uri.file(arg.filePath)
                    : vscode.window.activeTextEditor?.document.uri;
                if (!targetUri) {
                    vscode.window.showErrorMessage('No active file to analyse.');
                    sidebarProvider._view?.webview.postMessage({ type: 'analysis-done' });
                    return;
                }
                filesToAnalyze = [targetUri.fsPath];
            }

            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                vscode.window.showErrorMessage('Please open a workspace folder.');
                return;
            }

            // ── Locate binary ────────────────────────────────────────────────
            const ctracePath = locateBinary(context.extensionUri.fsPath);
            if (!ctracePath) {
                vscode.window.showErrorMessage(
                    `Ctrace binary not found in extension folder: ${context.extensionUri.fsPath}`
                );
                return;
            }

            const extensionPath = context.extensionUri.fsPath;
            const ctraceConfig  = vscode.workspace.getConfiguration('ctrace');
            let effectiveUiState = uiState;

            if (scanWorkspace) {
                effectiveUiState = { ...uiState, scanMode, entryPoints: ['main'], autoEntryPoints: false };
            }

            const autoEntryPoints = uiState.autoEntryPoints === true
                || ctraceConfig.get<boolean>('analysis.autoEntryPoints', false);

            if (scanMode === 'file' && autoEntryPoints && !uiState.entryPoints?.length) {
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filesToAnalyze[0]));
                const symbols = await getFunctionSymbols(document);
                effectiveUiState = { ...uiState, scanMode, entryPoints: symbols };
            }

            output.show(true);
            output.clear();

            // ── Run with progress ────────────────────────────────────────────
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: scanWorkspace
                        ? `Ctrace — scanning ${filesToAnalyze.length} file${filesToAnalyze.length > 1 ? 's' : ''}…`
                        : 'Running Ctrace Analysis…',
                    cancellable: false,
                },
                async (progress) => {
                    const step      = filesToAnalyze.length > 0 ? 100 / filesToAnalyze.length : 100;
                    const allSarif: any[] = [];

                    // Clear once before the loop so workspace-mode doesn't wipe
                    // earlier results on each iteration
                    if (scanWorkspace) { diagnosticCollection.clear(); }

                    for (let i = 0; i < filesToAnalyze.length; i++) {
                        const fp       = filesToAnalyze[i];
                        const fileName = path.basename(fp);

                        if (filesToAnalyze.length > 1) {
                            progress.report({
                                message: `(${i + 1}/${filesToAnalyze.length}) ${fileName}`,
                                increment: step,
                            });
                        }
                        sidebarProvider._view?.webview.postMessage({
                            type: 'analysis-progress',
                            message: `Analysing ${fileName}`,
                            detail: `File ${i + 1} of ${filesToAnalyze.length}`,
                            percent: Math.round((i / filesToAnalyze.length) * 100),
                        });

                        // Build & run command for this file. The report path is
                        // unique so workspace scans never reuse stale output.
                        const reportPath = createReportPath(extensionPath);
                        const args = buildCtraceArgs({ ...effectiveUiState, reportFile: reportPath }, ctraceConfig);
                        const { command, tempFiles } = buildCommand(ctracePath, fp, shellQuoteArgs(args));
                        tryDelete(reportPath);

                        output.appendLine(`\n${'─'.repeat(60)}`);
                        output.appendLine(`[${i + 1}/${filesToAnalyze.length}] ${fileName}`);
                        output.appendLine(`$ ${command}`);

                        const { stdout, stderr, exitCode } = await runCommand(command, extensionPath);

                        if (stdout) { output.appendLine(stdout); }
                        if (stderr) { output.appendLine('[stderr] ' + stderr); }
                        output.appendLine(`[exit ${exitCode ?? 0}]`);

                        tempFiles.forEach(tryDelete);

                        const sarif = parseSarifOutput(stdout, reportPath);
                        tryDelete(reportPath);
                        if (sarif) {
                            allSarif.push(sarif);
                            // In workspace mode the collection was already cleared
                            // once before the loop — don't clear on each iteration.
                            updateDiagnostics(sarif, diagnosticCollection, fp, !scanWorkspace);
                        } else if (!scanWorkspace) {
                            // Single-file mode: report parse failure immediately
                            handleNoResults(stdout, stderr, exitCode);
                            sidebarProvider._view?.webview.postMessage({
                                type: 'analysis-status',
                                status: 'error',
                                message: 'Analysis failed',
                                detail: 'No parseable SARIF result was returned.',
                            });
                        }
                    }

                    // ── Merge & publish results ──────────────────────────────
                    if (allSarif.length === 0) {
                        if (scanWorkspace) {
                            vscode.window.showWarningMessage(
                                'Workspace scan complete — no results could be parsed. Check the Ctrace output channel.'
                            );
                        }
                        sidebarProvider._view?.webview.postMessage({
                            type: 'analysis-status',
                            status: 'error',
                            message: 'Analysis finished with no results',
                            detail: 'Check the Ctrace output channel for details.',
                        });
                        sidebarProvider._view?.webview.postMessage({ type: 'analysis-done' });
                        return;
                    }

                    // Merge all SARIF runs into the first document for display
                    const merged = allSarif[0];
                    for (let i = 1; i < allSarif.length; i++) {
                        const s = allSarif[i];
                        (s.runs || []).forEach((run: any, idx: number) => {
                            if (merged.runs[idx]) {
                                merged.runs[idx].results = [
                                    ...(merged.runs[idx].results || []),
                                    ...(run.results || []),
                                ];
                            } else {
                                merged.runs.push(run);
                            }
                        });
                    }

                    const total = countResults(merged);

                    sidebarProvider._view?.webview.postMessage({
                        type: 'analysis-result',
                        data: merged,
                    });

                    const filesSuffix = scanWorkspace && filesToAnalyze.length > 1
                        ? ` across ${filesToAnalyze.length} files`
                        : '';

                    vscode.window.showInformationMessage(
                        total > 0
                            ? `Analysis complete — ${total} issue${total > 1 ? 's' : ''} found${filesSuffix}.`
                            : `Analysis complete — no issues found${filesSuffix}.`
                    );
                }
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.auditFunction', async (uri: vscode.Uri, functionName: string) => {
            await vscode.commands.executeCommand('ctrace.runAnalysis', {
                filePath: uri.fsPath,
                uiState: {
                    staticEnabled: true,
                    dynamicEnabled: true,
                    entryPoints: [functionName],
                },
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.showHelp', async () => {
            const ctracePath = locateBinary(context.extensionUri.fsPath);
            if (!ctracePath) {
                vscode.window.showErrorMessage('Ctrace binary not found in the extension folder.');
                return;
            }

            const command = `chmod +x "${ctracePath}" && "${ctracePath}" --help`;
            const { stdout, stderr, exitCode } = await runCommand(command, context.extensionUri.fsPath);
            output.clear();
            output.appendLine('$ ' + command);
            output.appendLine(stdout || stderr || 'Ctrace returned no help text.');
            output.appendLine(`[exit code: ${exitCode ?? 0}]`);
            output.show(true);
        })
    );
}

export function deactivate() {}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
