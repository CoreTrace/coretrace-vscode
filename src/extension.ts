import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { SidebarProvider, type HostMessage } from './SidebarProvider';
import { ensureBinary }       from './ctrace/BinaryUpdater';
import { buildCommand, parseAndValidateParams } from './ctrace/CommandBuilder';
import { runCommand }         from './ctrace/AnalysisRunner';
import { parseSarifOutput, countResults } from './ctrace/SarifParser';
import { updateDiagnostics }  from './ctrace/DiagnosticsManager';
import { scanWorkspace, clearCache, cacheSarifForFile } from './ctrace/WorkspaceScanner';
import type { SarifLog } from './types/sarif';

// Parameters passed by the webview when triggering an analysis run.
export interface AnalysisParams {
    customParams?: string;
}

export function activate(context: vscode.ExtensionContext) {

    // ── Output channel ───────────────────────────────────────────────────────
    const output = vscode.window.createOutputChannel('Ctrace');
    context.subscriptions.push(output);

    // Initialise and pre-fetch the binary in the background on startup
    ensureBinary(context, output).catch((err) => {
        output.appendLine('Failed to pre-fetch binary on activation: ' + err);
    });

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

    // ── Shared helpers ───────────────────────────────────────────────────────
    async function locateOrError(): Promise<string | null> {
        const p = await ensureBinary(context, output);
        if (!p) {
            vscode.window.showErrorMessage(
                `Ctrace binary could not be found or downloaded.`
            );
        }
        return p;
    }

    // ── Command: ctrace.runWorkspaceAnalysis ─────────────────────────────────
    // Scans the workspace for C/C++ files, hands compile_commands.json to
    // ctrace when available, and runs a file-by-file analysis otherwise.
    // Only files whose content changed since the last run are re-analysed;
    // the rest are served from the in-process hash cache.
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.runWorkspaceAnalysis', async (arg?: AnalysisParams | string) => {
            if (isRunning) {
                vscode.window.showWarningMessage('An analysis is already in progress.');
                return;
            }

            if (!vscode.workspace.workspaceFolders?.length) {
                vscode.window.showErrorMessage('Please open a workspace folder.');
                sidebarProvider.postMessage({ type: 'analysis-error' });
                return;
            }

            const ctracePath = await locateOrError();
            if (!ctracePath) {
                sidebarProvider.postMessage({ type: 'analysis-error' });
                return;
            }

            const params = resolveParams(arg);

            // Validate params once upfront — same flow as ctrace.runAnalysis — so
            // an unsafe/invalid flag surfaces as a clear error before the scan starts
            // rather than failing mid-run (compile_commands mode) or per-file (file-by-file).
            try {
                parseAndValidateParams(params);
            } catch (e) {
                vscode.window.showErrorMessage(`Invalid analysis parameters: ${e}`);
                sidebarProvider.postMessage({ type: 'analysis-error' });
                return;
            }

            isRunning = true;
            const extensionPath = context.extensionUri.fsPath;
            const reportPath    = path.join(extensionPath, 'ctrace-report.txt');

            output.show(true);
            output.clear();
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Ctrace — scanning workspace…', cancellable: true },
                async (progress, token) => {
                    try {
                        // Discover files; detect which ones changed since last run.
                        const scan = await scanWorkspace();

                        if (scan.files.length === 0) {
                            vscode.window.showWarningMessage('No C/C++ source files found in the workspace.');
                            sidebarProvider.postMessage({ type: 'analysis-error' });
                            return;
                        }

                        // Decide which files actually need analysis.
                        // In compile_commands mode ctrace receives the full compilation
                        // database and runs once — it cannot skip individual files based
                        // on our hash cache, so reporting cached counts would be misleading.
                        // In file-by-file mode the hash cache is meaningful and we only
                        // invoke ctrace for files whose content actually changed (or failed previously).
                        const usingCompileCommands = !!scan.compileCommandsPath;
                        const toAnalyse   = usingCompileCommands ? scan.files : scan.changedFiles;
                        const cachedCount = usingCompileCommands ? 0
                                          : scan.files.length - toAnalyse.length;

                        sidebarProvider.postMessage({
                            type: 'workspace-progress',
                            total:   scan.files.length,
                            changed: toAnalyse.length,
                            cached:  cachedCount,
                            done:    0,
                        } satisfies HostMessage);

                        const merged: SarifLog = { version: '2.1.0', runs: [] };
                        let totalIssues = 0;
                        let analysedCount = 0;
                        let failureCount = 0;

                        // ── compile_commands.json path ────────────────────────
                        if (scan.compileCommandsPath) {
                            // Pass the compilation database directly — ctrace can
                            // resolve translation units and dependencies on its own.
                            progress.report({ message: `Using compile_commands.json (${scan.files.length} files)` });
                            const built = await buildCommand(ctracePath, scan.compileCommandsPath, params, true);
                            await tryDelete(reportPath);
                            const result = await runCommand(built, extensionPath, token);
                            if (token.isCancellationRequested || result.killed) {
                                sidebarProvider.postMessage({ type: 'analysis-error' });
                                return;
                            }
                            output.clear();
                            output.appendLine('[workspace] compile_commands mode');
                            if (result.stdout) { output.appendLine(result.stdout); }
                            if (result.stderr) { output.appendLine('[stderr] ' + result.stderr); }
                            const combinedOutput = result.stdout + '\n' + (result.stderr || '');
                            const sarif = await parseSarifOutput(combinedOutput, reportPath);
                            if (sarif) {
                                merged.runs.push(...sarif.runs);
                                totalIssues += countResults(sarif);
                            }
                            await tryDelete(reportPath);
                            if (built.tempFiles?.length) {
                                await Promise.all(built.tempFiles.map(tryDelete));
                            }
                            // Mark compile_commands run as 100% complete
                            sidebarProvider.postMessage({
                                type: 'workspace-progress',
                                total:   scan.files.length,
                                changed: toAnalyse.length,
                                cached:  cachedCount,
                                done:    toAnalyse.length,
                            } satisfies HostMessage);
                        } else {
                            // ── File-by-file fallback ─────────────────────────
                            for (const file of toAnalyse) {
                                if (token.isCancellationRequested) { break; }

                                progress.report({
                                    message: `${path.basename(file.fsPath)} (${analysedCount + 1}/${toAnalyse.length})`,
                                    increment: 100 / toAnalyse.length,
                                });

                                try {
                                    const built = await buildCommand(ctracePath, file.fsPath, params);
                                    await tryDelete(reportPath);
                                    const result = await runCommand(built, extensionPath, token);

                                    if (result.stdout || result.stderr) {
                                        output.appendLine(`\n--- ${path.basename(file.fsPath)} ---`);
                                        if (result.stdout) { output.appendLine(result.stdout); }
                                        if (result.stderr) { output.appendLine('[stderr] ' + result.stderr); }
                                    }

                                    if (!result.killed) {
                                        const combinedOutput = result.stdout + '\n' + (result.stderr || '');
                                        const sarif = await parseSarifOutput(combinedOutput, reportPath);
                                        if (sarif) {
                                            merged.runs.push(...sarif.runs);
                                            totalIssues += countResults(sarif);
                                            // Cache the SARIF runs for this file so unchanged files
                                            // in future runs can use their cached results
                                            if (sarif.runs.length > 0) {
                                                cacheSarifForFile(file.fsPath, file.hash, sarif.runs);
                                            }
                                        }
                                    }

                                    await tryDelete(reportPath);
                                    if (built.tempFiles?.length) {
                                        await Promise.all(built.tempFiles.map(tryDelete));
                                    }
                                } catch (e) {
                                    failureCount++;
                                    output.appendLine(`[error] ${file.fsPath}: ${e}`);
                                }

                                analysedCount++;
                                sidebarProvider.postMessage({
                                    type: 'workspace-progress',
                                    total:   scan.files.length,
                                    changed: toAnalyse.length,
                                    cached:  cachedCount,
                                    done:    analysedCount,
                                } satisfies HostMessage);
                            }
                        }

                        if (token.isCancellationRequested) {
                            sidebarProvider.postMessage({ type: 'analysis-error' });
                            return;
                        }

                        // If every file failed (e.g. params rejected, binary missing) there
                        // is nothing meaningful to show — treat it as a hard error.
                        if (!usingCompileCommands && failureCount > 0 && analysedCount === failureCount) {
                            sidebarProvider.postMessage({ type: 'analysis-error' });
                            vscode.window.showErrorMessage(
                                `Workspace analysis failed: all ${failureCount} file${failureCount > 1 ? 's' : ''} could not be analysed. Check the Ctrace output for details.`
                            );
                            return;
                        }

                        // Use the compile_commands directory (= workspace root) when available;
                        // fall back to the first workspace folder. Either gives resolveArtifactPath
                        // a real base so relative SARIF URIs don't silently resolve against cwd.
                        const diagFallback = scan.compileCommandsPath
                            ? path.dirname(scan.compileCommandsPath)
                            : vscode.workspace.workspaceFolders![0].uri.fsPath;

                        // In file-by-file mode, merge cached SARIF results for unchanged files
                        // so they aren't lost when updateDiagnostics() clears the collection.
                        if (!usingCompileCommands && scan.cachedSarifByFile.size > 0) {
                            for (const [, cachedRuns] of scan.cachedSarifByFile) {
                                merged.runs.push(...cachedRuns);
                                totalIssues += cachedRuns.reduce((sum, run) => sum + (run.results?.length ?? 0), 0);
                            }
                        }

                        updateDiagnostics(merged, diagnosticCollection, diagFallback);

                        sidebarProvider.postMessage({
                            type: 'analysis-result',
                            data: merged,
                        } satisfies HostMessage);

                        const skippedMsg = cachedCount > 0 ? ` (${cachedCount} unchanged, skipped)` : '';
                        const failureMsg = failureCount > 0 ? ` · ${failureCount} failed` : '';
                        vscode.window.showInformationMessage(
                            totalIssues > 0
                                ? `Workspace analysis — ${totalIssues} issue${totalIssues > 1 ? 's' : ''} found.${skippedMsg}${failureMsg}`
                                : `Workspace analysis complete — no issues found.${skippedMsg}${failureMsg}`
                        );
                    } catch (e) {
                        sidebarProvider.postMessage({ type: 'analysis-error' });
                        vscode.window.showErrorMessage(`Ctrace workspace analysis failed: ${e}`);
                        output.appendLine(`[error] ${e}`);
                    } finally {
                        // Always clean up the report file, matching the single-file command's
                        // finally block — so a crashed ctrace run never leaves a stale report.
                        await tryDelete(reportPath);
                        isRunning = false;
                    }
                }
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.clearAnalysisCache', () => {
            clearCache();
            vscode.window.showInformationMessage('Ctrace analysis cache cleared — next workspace run will re-analyse all files.');
        })
    );

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
            const ctracePath = await ensureBinary(context, output);
            if (!ctracePath) {
                vscode.window.showErrorMessage(
                    `Ctrace binary could not be found or downloaded.`
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

            // ctrace writes its SARIF report to a fixed path relative to its
            // working directory (cwd = extensionPath).  We use that exact path
            // so parseSarifOutput() can read the file.
            // Cross-run races are prevented by the isRunning guard above:
            // isRunning is only cleared after awaited cleanup finishes, so
            // run N+1 cannot start until run N has deleted the report file.
            const reportPath = path.join(extensionPath, 'ctrace-report.txt');

            // Execute with progress notification
            output.show(true); // show without stealing focus
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Running Ctrace Analysis…', cancellable: true },
                async (_progress, token) => {
                    // Ensure no stale report exists from a previous crashed session
                    await tryDelete(reportPath);

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
                        const combinedOutput = stdout + '\n' + (stderr || '');
                        const sarif = await parseSarifOutput(combinedOutput, reportPath);

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
                        // Await all deletions so cleanup is complete before the
                        // command handler returns, and so any future changes to
                        // tryDelete cannot silently introduce unhandled rejections.
                        await Promise.all([...tempFiles, reportPath].map(tryDelete));
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
