import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { SidebarProvider } from './SidebarProvider';
import { locateBinary } from './ctrace/BinaryLocator';
import { buildCommand, isWslAvailable } from './ctrace/CommandBuilder';
import { runCommand } from './ctrace/AnalysisRunner';
import { parseSarifOutput, countResults } from './ctrace/SarifParser';
import { updateDiagnostics } from './ctrace/DiagnosticsManager';
import { buildCtraceArgs, createReportPath, createConfigPath, generateConfigFileIfNeeded, shellQuoteArgs, CtraceUIState } from './ctraceRunner';
import { getFunctionSymbols, cleanFunctionName } from './utils/symbolExtractor';
import { CtraceCodeLensProvider } from './codelens/CtraceCodeLensProvider';
import { ensureBinary, isUpdatingBinary, setBinaryUpdateListener } from './ctrace/BinaryUpdater';
import { clearCache, scanWorkspace as runWorkspaceScan } from './ctrace/WorkspaceScanner';

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

    setBinaryUpdateListener((msg) => {
        if (msg === '__done__') {
            sidebarProvider.postMessage({ type: 'analysis-download-complete' });
            return;
        }
        sidebarProvider.postMessage({ type: 'analysis-downloading', progress: msg });
    });

    // Initialise and pre-fetch the binary in the background on startup
    ensureBinary(context, output).catch((err) => {
        output.appendLine('Failed to pre-fetch binary on activation: ' + err);
    });

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
    // Guard against concurrent invocations (e.g. a second postMessage arriving
    // while the first analysis is still running, or a keyboard shortcut being
    // triggered while the sidebar button is already spinning).
    let isRunning = false;

    // ── Shared helpers ───────────────────────────────────────────────────────
    async function locateOrError(): Promise<string | null> {
        let p: string | null = null;
        try {
            p = await ensureBinary(context, output);
        } catch (e: any) {
            output.appendLine(`ensureBinary threw an error: ${e.message}`);
        }
        
        if (!p) {
            const extPath = context.extensionUri.fsPath;
            const globalStorage = context.globalStorageUri.fsPath;
            vscode.window.showErrorMessage(
                `Ctrace binary could not be found or downloaded. Checked: \n- ${globalStorage}/bin\n- ${extPath}\nSee the "Ctrace" Output channel for details.`
            );
        }
        return p;
    }

    // ── Command: ctrace.runAnalysis ──────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.runAnalysis', async (arg?: any) => {
            if (isRunning) {
                vscode.window.showWarningMessage('An analysis is already in progress.');
                sidebarProvider.postMessage({ type: 'analysis-done' });
                return;
            }

            if (process.platform === 'win32' && !isWslAvailable()) {
                output.appendLine('[ctrace] Windows Subsystem for Linux (WSL) is required to run Ctrace on Windows.');
                promptWslInstallation();
                sidebarProvider.postMessage({ type: 'analysis-done' });
                return;
            }

            if (isUpdatingBinary()) {
                vscode.window.showWarningMessage('Ctrace is currently updating. Please wait for the download to finish before running an analysis.');
                sidebarProvider.postMessage({ type: 'analysis-done' });
                return;
            }

            const uiState: CtraceUIState = arg?.uiState ?? {};
            const scanMode: 'file' | 'workspace' = arg?.scanMode === 'workspace' || arg?.scanWorkspace === true
                ? 'workspace'
                : 'file';
            const scanWorkspace = scanMode === 'workspace';

            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                vscode.window.showErrorMessage('Please open a workspace folder.');
                sidebarProvider.postMessage({ type: 'analysis-done' });
                return;
            }

            // ── Determine files to analyse ───────────────────────────────────
            let filesToAnalyze: string[];

            if (scanWorkspace) {
                const userExclude = uiState.excludeDir
                    ? uiState.excludeDir.split(',').map((s: string) => `**/${s.trim()}/**`).filter(Boolean).join(',')
                    : '';
                const excludeGlob = `{**/node_modules/**,**/.git/**,**/build/**,**/out/**,**/.cache/**,**/.vscode/**${userExclude ? ',' + userExclude : ''}}`;

                let includeGlob = '**/*.{c,cpp,cc,cxx}';
                if (uiState.onlyDir) {
                    const dirs = uiState.onlyDir.split(',').map((s: string) => s.trim()).filter(Boolean);
                    if (dirs.length === 1) {
                        includeGlob = `${dirs[0]}/**/*.{c,cpp,cc,cxx}`;
                    } else if (dirs.length > 1) {
                        includeGlob = `{${dirs.map((d: string) => `${d}/**/*.{c,cpp,cc,cxx}`).join(',')}}`;
                    }
                }

                const uris = await vscode.workspace.findFiles(includeGlob, excludeGlob);
                if (uris.length === 0) {
                    vscode.window.showWarningMessage('No C/C++ files found in the current workspace matching the filters.');
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

            // ── Locate binary ────────────────────────────────────────────────
            const ctracePath = await locateOrError();
            if (!ctracePath) {
                sidebarProvider.postMessage({ type: 'analysis-done' });
                return;
            }

            isRunning = true;
            sidebarProvider.postMessage({ type: 'analysis-start' });

            const extensionPath = context.extensionUri.fsPath;
            const ctraceConfig = vscode.workspace.getConfiguration('ctrace');
            let effectiveUiState = uiState;

            if (scanWorkspace) {
                effectiveUiState = { ...uiState, scanMode, autoEntryPoints: false };
            }

            if (!effectiveUiState.compileCommandsPath) {
                try {
                    const scanRes = await runWorkspaceScan();
                    if (scanRes.compileCommandsPath) {
                        effectiveUiState = {
                            ...effectiveUiState,
                            compileCommandsPath: scanRes.compileCommandsPath,
                        };
                        output.appendLine(`[ctrace] Auto-detected compilation database: ${scanRes.compileCommandsPath}`);
                    }
                } catch (e) {
                    console.warn('[ctrace] Could not auto-detect compilation database:', e);
                }
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
                    cancellable: true,
                },
                async (progress, token) => {
                    const step = filesToAnalyze.length > 0 ? 100 / filesToAnalyze.length : 100;
                    const allSarif: any[] = [];

                    // Clear once before the loop so workspace-mode doesn't wipe
                    // previously collected diagnostics on every file.
                    if (scanWorkspace) { diagnosticCollection.clear(); }

                    const configPath = createConfigPath(extensionPath);
                    const hasConfig = generateConfigFileIfNeeded(configPath, effectiveUiState, workspaceRoot);

                    let hadToolExecutionWarning = false;
                    try {
                        for (let i = 0; i < filesToAnalyze.length; i++) {
                            if (token.isCancellationRequested) {
                                output.appendLine('[ctrace] Analysis cancelled by user.');
                                vscode.window.showInformationMessage('Ctrace analysis cancelled.');
                                sidebarProvider._view?.webview.postMessage({
                                    type: 'analysis-status',
                                    status: 'ready',
                                    message: 'Analysis cancelled',
                                    detail: `Stopped after ${i} file(s).`,
                                });
                                break;
                            }

                            const fp = filesToAnalyze[i];
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

                            // Build & run command for this file.
                            const reportPath = createReportPath(extensionPath);
                            const args = buildCtraceArgs({
                                ...effectiveUiState,
                                reportFile: reportPath,
                                configFile: hasConfig ? configPath : undefined,
                            }, ctraceConfig);
                            const { command, tempFiles } = await buildCommand(ctracePath, fp, shellQuoteArgs(args));
                            tryDelete(reportPath);

                            output.appendLine(`\n${'─'.repeat(60)}`);
                            output.appendLine(`[${i + 1}/${filesToAnalyze.length}] ${fileName}`);
                            output.appendLine(`$ ${command}`);
                            if (hasConfig) {
                                try {
                                    output.appendLine(`[ctrace config] ${fs.readFileSync(configPath, 'utf8').trim()}`);
                                } catch {}
                            }

                            const result = await runCommand(command, extensionPath, token);
                            const { stdout, stderr, exitCode, killed } = result;

                            if (stdout) { output.appendLine(stdout); }
                            if (stderr) { output.appendLine('[stderr] ' + stderr); }
                            output.appendLine(`[exit ${exitCode ?? 0}]`);

                            const combined = (stdout || '') + (stderr || '');
                            if (/can't open file|No such file or directory|\/opt\/homebrew\/bin\/cppcheck/i.test(combined)) {
                                hadToolExecutionWarning = true;
                                output.appendLine('[ctrace warning] Note: one or more static analysis tools (e.g. cppcheck/flawfinder/ikos/tscancode) could not be executed by ctrace.');
                            }

                            tempFiles.forEach(tryDelete);

                            if (killed) {
                                if (token.isCancellationRequested) {
                                    break;
                                }
                                output.appendLine(`[timed out] ${fileName}`);
                                vscode.window.showWarningMessage(`Analysis of ${fileName} timed out (60s).`);
                            }

                            const sarif = await parseSarifOutput(stdout, reportPath);
                            tryDelete(reportPath);
                            if (sarif) {
                                allSarif.push(sarif);
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

                        // ── Merge & publish results ──────────────────────────
                        if (token.isCancellationRequested) {
                            return;
                        }

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
                            return;
                        }

                        const merged = mergeSarifDocs(allSarif);
                        const total = countResults(merged);

                        sidebarProvider.postMessage({
                            type: 'analysis-result',
                            data: merged,
                        });

                        const filesSuffix = scanWorkspace && filesToAnalyze.length > 1
                            ? ` across ${filesToAnalyze.length} files`
                            : '';

                        if (total > 0) {
                            vscode.window.showInformationMessage(
                                `Analysis complete — ${total} issue${total > 1 ? 's' : ''} found${filesSuffix}.`
                            );
                        } else if (hadToolExecutionWarning) {
                            vscode.window.showWarningMessage(
                                `Analysis complete — no issues found by active tools${filesSuffix}. (Note: some secondary analyzers were unavailable; see Ctrace Output channel).`
                            );
                        } else {
                            vscode.window.showInformationMessage(
                                `Analysis complete — no issues found${filesSuffix}.`
                            );
                        }
                    } catch (e) {
                        console.error('[ctrace] Analysis failed unexpectedly:', e);
                        output.appendLine(`[error] ${e}`);
                        const errStr = String(e);
                        if (process.platform === 'win32' && (errStr.includes('WSL') || errStr.includes('wsl'))) {
                            promptWslInstallation();
                        } else {
                            vscode.window.showErrorMessage(`Ctrace analysis failed: ${e}`);
                        }
                        sidebarProvider._view?.webview.postMessage({
                            type: 'analysis-error',
                            message: 'Analysis failed',
                            detail: String(e),
                        });
                    } finally {
                        if (hasConfig) {
                            tryDelete(configPath);
                        }
                        isRunning = false;
                        sidebarProvider.postMessage({ type: 'analysis-done' });
                    }
                }
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.runWorkspaceAnalysis', async (arg?: any) => {
            const payload = typeof arg === 'object' && arg !== null
                ? { ...arg, scanMode: 'workspace' }
                : { scanMode: 'workspace' };
            return vscode.commands.executeCommand('ctrace.runAnalysis', payload);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.clearAnalysisCache', () => {
            clearCache();
            vscode.window.showInformationMessage('Ctrace analysis cache cleared.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.auditFunction', async (uri: vscode.Uri, functionName: string) => {
            const cleanName = cleanFunctionName(functionName);
            if (!cleanName) {
                vscode.window.showWarningMessage(`Could not determine a valid function name to audit from "${functionName}".`);
                return;
            }
            await vscode.commands.executeCommand('ctrace.runAnalysis', {
                filePath: uri.fsPath,
                uiState: {
                    staticEnabled: true,
                    dynamicEnabled: true,
                    entryPoints: [cleanName],
                },
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.showHelp', async () => {
            if (process.platform === 'win32' && !isWslAvailable()) {
                output.appendLine('[ctrace] Windows Subsystem for Linux (WSL) is required to run Ctrace on Windows.');
                promptWslInstallation();
                return;
            }

            const ctracePath = await locateOrError();
            if (!ctracePath) {
                vscode.window.showErrorMessage('Ctrace binary not found in the extension folder.');
                return;
            }

            const command = process.platform === 'win32'
                ? `wsl "${ctracePath}" --help`
                : `chmod +x "${ctracePath}" && "${ctracePath}" --help`;
            const { stdout, stderr, exitCode } = await runCommand(command, context.extensionUri.fsPath);
            output.clear();
            output.appendLine('$ ' + command);
            output.appendLine(stdout || stderr || 'Ctrace returned no help text.');
            output.appendLine(`[exit code: ${exitCode ?? 0}]`);
            output.show(true);
        })
    );
}

export function deactivate() { }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mergeSarifDocs(sarifList: any[]): any {
    if (!sarifList.length) { return null; }

    const merged: any = {
        version: '2.1.0',
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        runs: [],
    };

    const runMap = new Map<string, any>();

    for (const doc of sarifList) {
        if (!doc || !Array.isArray(doc.runs)) { continue; }
        for (const run of doc.runs) {
            if (!run) { continue; }
            const driverName = run.tool?.driver?.name || 'coretrace';
            if (!runMap.has(driverName)) {
                const newRun = {
                    ...run,
                    results: Array.isArray(run.results) ? [...run.results] : [],
                };
                runMap.set(driverName, newRun);
                merged.runs.push(newRun);
            } else {
                const existingRun = runMap.get(driverName)!;
                if (Array.isArray(run.results)) {
                    existingRun.results = existingRun.results || [];
                    existingRun.results.push(...run.results);
                }
            }
        }
    }

    return merged;
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

export async function promptWslInstallation(): Promise<void> {
    const action = await vscode.window.showErrorMessage(
        'Windows Subsystem for Linux (WSL) is required to run Ctrace on Windows. Please install WSL and a Linux distribution (e.g. Ubuntu).',
        'Install WSL Guide',
        'Copy "wsl --install"'
    );
    if (action === 'Install WSL Guide') {
        vscode.env.openExternal(vscode.Uri.parse('https://learn.microsoft.com/windows/wsl/install'));
    } else if (action === 'Copy "wsl --install"') {
        await vscode.env.clipboard.writeText('wsl --install');
        vscode.window.showInformationMessage('Copied "wsl --install" to clipboard. Open PowerShell as Administrator and run it.');
    }
}

function handleNoResults(stdout: string, stderr: string, exitCode: number | null): void {
    const combined = stdout + stderr;
    const crash = CRASH_SIGNATURES.find(sig => combined.includes(sig));
    const isWslIssue = process.platform === 'win32' && (
        combined.includes('Windows Subsystem for Linux') ||
        combined.includes('wsl.exe') ||
        combined.includes('no installed distributions')
    );

    if (isWslIssue) {
        promptWslInstallation();
    } else if (crash) {
        vscode.window.showErrorMessage(
            `Ctrace crashed (${crash}). This is likely a bug in the analysis tool. See the Output Channel.`
        );
    } else if (exitCode !== null && exitCode !== 0) {
        vscode.window.showErrorMessage(
            `Ctrace exited with code ${exitCode}. ${stderr.substring(0, 200)}`
        );
    } else {
        vscode.window.showWarningMessage(
            'Analysis finished but no results could be parsed. Check the Output Channel for raw output.'
        );
    }
}
