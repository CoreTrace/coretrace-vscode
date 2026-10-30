import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { SidebarProvider } from './SidebarProvider';
import { locateBinary } from './ctrace/BinaryLocator';
import { buildCommand, isWslAvailable } from './ctrace/CommandBuilder';
import { runCommand, DEFAULT_TIMEOUT_MS } from './ctrace/AnalysisRunner';
import { parseSarifOutput } from './ctrace/SarifParser';
import { updateDiagnostics, clearDiagnostics, getFindingForDiagnostic, FindingRef } from './ctrace/DiagnosticsManager';
import { buildCtraceArgs, buildStackAnalyzerArgs, createReportPath, createConfigPath, generateConfigFileIfNeeded, shellQuoteArgs, CtraceUIState } from './ctraceRunner';
import { getFunctionSymbols, cleanFunctionName } from './utils/symbolExtractor';
import { CtraceCodeLensProvider } from './codelens/CtraceCodeLensProvider';
import { ensureBinary, isUpdatingBinary, setBinaryUpdateListener } from './ctrace/BinaryUpdater';
import {
    clearCache,
    findCompileCommandsPath,
    initAnalysisCache,
    persistAnalysisCache,
    partitionFiles,
    analysisContextKey,
    cacheFileAnalysis,
    WorkspaceFile,
} from './ctrace/WorkspaceScanner';
import { FindingIgnoreList, relativeFindingPath, IGNORE_FILE_NAME } from './ctrace/FindingIgnoreList';
import { IgnoreFindingCodeActionProvider } from './codelens/IgnoreFindingCodeActionProvider';
import { checkDependencies, installDependencies } from './ctrace/DependencyInstaller';
import { StackManager } from './ctrace/StackManager';
import { parseStackReport, mergeStackReports } from './ctrace/StackParser';
import { FindingsStore } from './ctrace/FindingsStore';

export function activate(context: vscode.ExtensionContext) {

    // ── Output channel ───────────────────────────────────────────────────────
    const output = vscode.window.createOutputChannel('Ctrace');
    context.subscriptions.push(output);

    // ── Sidebar ──────────────────────────────────────────────────────────────
    const findingsStore = new FindingsStore(context.workspaceState);
    const sidebarProvider = new SidebarProvider(context.extensionUri, findingsStore);
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

    const codeLensProvider = new CtraceCodeLensProvider();
    for (const language of ['c', 'cpp', 'objective-c', 'objective-cpp']) {
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider({ language }, codeLensProvider)
        );
    }

    // ── Diagnostics collection ───────────────────────────────────────────────
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('ctrace');
    context.subscriptions.push(diagnosticCollection);

    // ── Ignored findings ─────────────────────────────────────────────────────
    const ignoreList = new FindingIgnoreList(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    context.subscriptions.push(ignoreList);
    const isIgnored = (fingerprint: string) => ignoreList.has(fingerprint);
    for (const language of ['c', 'cpp', 'objective-c', 'objective-cpp']) {
        context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
            { language },
            new IgnoreFindingCodeActionProvider(),
            { providedCodeActionKinds: IgnoreFindingCodeActionProvider.providedCodeActionKinds }
        ));
    }

    // SARIF of the latest analysis, per analysed file, so that ignoring a
    // finding can refresh the Problems panel and the sidebar without a rerun.
    let lastSarifByFile = new Map<string, any>();
    let republishPending = false;

    async function republishFindings(): Promise<void> {
        if (isRunning) {
            republishPending = true;
            return;
        }
        if (lastSarifByFile.size > 0) {
            clearDiagnostics(diagnosticCollection);
            for (const [fp, sarif] of lastSarifByFile) {
                updateDiagnostics(sarif, diagnosticCollection, fp, false, { isIgnored });
            }
            const merged = mergeSarifDocs([...lastSarifByFile.values()]);
            await findingsStore.save(merged).catch(() => { /* best effort */ });
            sidebarProvider.postMessage({ type: 'analysis-result', data: merged, refresh: true });
            return;
        }
        // Results restored from a previous session: only the sidebar shows them.
        const snapshot = findingsStore.get();
        if (!snapshot) { return; }
        for (const result of snapshot.report.runs.flatMap(run => run.results ?? [])) {
            const fingerprint = result.properties?.ctraceFingerprint;
            if (fingerprint) { result.properties = { ...result.properties, ctraceIgnored: ignoreList.has(fingerprint) }; }
        }
        await findingsStore.save(snapshot.report, snapshot.savedAt).catch(() => { /* best effort */ });
        sidebarProvider.postMessage({ type: 'analysis-result', data: snapshot.report, restored: true, savedAt: snapshot.savedAt, refresh: true });
    }
    context.subscriptions.push(ignoreList.onDidChange(() => { void republishFindings(); }));

    // Results of unchanged files from previous workspace scans.
    const analysisCacheReady = initAnalysisCache(context.storageUri?.fsPath);

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
            const hint = process.platform === 'darwin'
                ? '\nCoreTrace publishes no prebuilt macOS binary: build it from https://github.com/CoreTrace/coretrace and put `ctrace` on your PATH.'
                : '';
            vscode.window.showErrorMessage(
                `Ctrace binary could not be found or downloaded. Checked: \n- ${globalStorage}/bin\n- ${extPath}\n- PATH${hint}\nSee the "Ctrace" Output channel for details.`
            );
        }
        return p;
    }

    // Check dependencies and locate the binary when an analysis is requested.


    // ── Command: ctrace.installDependencies ──────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.installDependencies', async () => {
            if (process.platform === 'win32' && !isWslAvailable()) {
                output.appendLine('[ctrace] Windows Subsystem for Linux (WSL) is required to install dependencies on Windows.');
                promptWslInstallation();
                return;
            }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'CoreTrace: Installing Analyzers & Dependencies',
                    cancellable: false,
                },
                async (progress) => {
                    await installDependencies(output, progress);
                }
            );
        })
    );

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

            const requestedStaticTools: string[] = uiState.staticTools ?? ['cppcheck', 'flawfinder', 'ikos', 'tscancode', 'ctrace_stack_analyzer'];
            if (uiState.staticEnabled !== false && requestedStaticTools.length > 0) {
                const depStatus = await checkDependencies();
                const missingRequested = requestedStaticTools.filter((t) => depStatus.missing.includes(t));
                if (missingRequested.length > 0) {
                    const action = await vscode.window.showWarningMessage(
                        `CoreTrace: The following analyzer(s) are not configured: ${missingRequested.join(', ')}. Would you like to install them now?`,
                        'Install Analyzers',
                        'Run Anyway'
                    );
                    if (action === 'Install Analyzers') {
                        sidebarProvider.postMessage({ type: 'analysis-done' });
                        vscode.commands.executeCommand('ctrace.installDependencies');
                        return;
                    }
                }
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
                const ext = path.extname(targetUri.fsPath).toLowerCase();
                const C_EXTENSIONS = new Set(['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh']);
                if (targetUri.scheme !== 'file' || !C_EXTENSIONS.has(ext)) {
                    vscode.window.showWarningMessage('Please open or focus a C/C++ source file (.c, .cpp, .cc, .cxx) to analyse.');
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
            } else {
                effectiveUiState = {
                    ...uiState,
                    scanMode,
                    onlyDir: undefined,
                    excludeDir: undefined,
                    resourceCrossTu: false,
                };
            }

            if (!effectiveUiState.compileCommandsPath) {
                try {
                    const compileCommandsPath = await findCompileCommandsPath();
                    if (compileCommandsPath) {
                        effectiveUiState = {
                            ...effectiveUiState,
                            compileCommandsPath,
                        };
                        output.appendLine(`[ctrace] Auto-detected compilation database: ${compileCommandsPath}`);
                    }
                } catch (e) {
                    console.warn('[ctrace] Could not auto-detect compilation database:', e);
                }
            }

            const timeoutSeconds = ctraceConfig.get<number>('analysis.timeoutSeconds', DEFAULT_TIMEOUT_MS / 1000);
            const timeoutMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
                ? timeoutSeconds * 1000
                : DEFAULT_TIMEOUT_MS;

            const autoEntryPoints = uiState.autoEntryPoints === true
                || ctraceConfig.get<boolean>('analysis.autoEntryPoints', false);

            if (scanMode === 'file' && autoEntryPoints && !uiState.entryPoints?.length) {
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filesToAnalyze[0]));
                const symbols = await getFunctionSymbols(document);
                effectiveUiState = { ...effectiveUiState, scanMode, entryPoints: symbols };
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
                    const allSarif: any[] = [];
                    const allStackReports: any[] = [];
                    lastSarifByFile = new Map();

                    // Clear once before the loop so workspace-mode doesn't wipe
                    // previously collected diagnostics on every file.
                    if (scanWorkspace) {
                        clearDiagnostics(diagnosticCollection);
                        StackManager.instance.clear();
                    }

                    const configPath = createConfigPath(extensionPath);
                    const hasConfig = generateConfigFileIfNeeded(configPath, effectiveUiState, workspaceRoot, ctraceConfig);

                    const publishStack = (stackReport: any) => {
                        allStackReports.push(stackReport);
                        const unifiedStack = mergeStackReports(allStackReports);
                        if (unifiedStack) {
                            StackManager.instance.updateStackData(unifiedStack);
                            sidebarProvider.postMessage({
                                type: 'stack-data',
                                data: unifiedStack,
                            });
                        }
                    };

                    // ── Incremental workspace scan ───────────────────────────
                    // Reuse the results of files whose content, headers and
                    // ctrace invocation are unchanged since they were analysed.
                    const incremental = scanWorkspace && ctraceConfig.get<boolean>('workspace.incremental', true);
                    let contextKey = '';
                    let queue: WorkspaceFile[] = filesToAnalyze.map(fsPath => ({ fsPath, hash: '' }));
                    let cachedCount = 0;
                    if (incremental) {
                        await analysisCacheReady;
                        const placeholderState = {
                            ...effectiveUiState,
                            reportFile: '<report>',
                            configFile: hasConfig ? '<config>' : effectiveUiState.configFile,
                        };
                        let configContent = '';
                        try { configContent = hasConfig ? fs.readFileSync(configPath, 'utf8') : ''; } catch { /* ignore */ }
                        contextKey = await analysisContextKey(
                            [buildCtraceArgs(placeholderState, ctraceConfig), buildStackAnalyzerArgs(placeholderState, ctraceConfig), configContent, timeoutMs],
                            [ctracePath, effectiveUiState.compileCommandsPath, effectiveUiState.configFile]
                        );
                        const partition = await partitionFiles(filesToAnalyze, contextKey);
                        queue = partition.changed;
                        cachedCount = partition.cached.size;
                        for (const [fp, cached] of partition.cached) {
                            allSarif.push(cached.sarif);
                            lastSarifByFile.set(fp, cached.sarif);
                            updateDiagnostics(cached.sarif, diagnosticCollection, fp, false, { isIgnored });
                            if (cached.stack && cached.stack.functions.length > 0) { publishStack(cached.stack); }
                        }
                        output.appendLine(`[ctrace] Incremental scan: ${queue.length} file(s) to analyse, ${cachedCount} unchanged file(s) reused from cache.`);
                    }
                    const step = queue.length > 0 ? 100 / queue.length : 100;

                    let hadToolExecutionWarning = false;
                    try {
                        for (let i = 0; i < queue.length; i++) {
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

                            const fp = queue[i].fsPath;
                            const fileName = path.basename(fp);
                            const cachedSuffix = cachedCount > 0 ? ` (${cachedCount} unchanged)` : '';

                            if (queue.length > 1 || cachedCount > 0) {
                                progress.report({
                                    message: `(${i + 1}/${queue.length}) ${fileName}${cachedSuffix}`,
                                    increment: step,
                                });
                            }
                            sidebarProvider._view?.webview.postMessage({
                                type: 'analysis-progress',
                                message: `Analysing ${fileName}`,
                                detail: `File ${i + 1} of ${queue.length}${cachedSuffix}`,
                                percent: Math.round((i / queue.length) * 100),
                            });

                            // Build & run command for this file.
                            const reportPath = createReportPath(extensionPath);
                            const args = buildCtraceArgs({
                                ...effectiveUiState,
                                reportFile: reportPath,
                                configFile: hasConfig ? configPath : effectiveUiState.configFile,
                            }, ctraceConfig);
                            const { command, tempFiles } = await buildCommand(ctracePath, fp, shellQuoteArgs(args));
                            tryDelete(reportPath);

                            output.appendLine(`\n${'─'.repeat(60)}`);
                            output.appendLine(`[${i + 1}/${queue.length}] ${fileName}`);
                            output.appendLine(`$ ${command}`);
                            if (hasConfig) {
                                try {
                                    output.appendLine(`[ctrace config] ${fs.readFileSync(configPath, 'utf8').trim()}`);
                                } catch {}
                            }

                            const result = await runCommand(command, extensionPath, token, timeoutMs);
                            const { stdout, stderr, exitCode, killed } = result;

                            if (stdout) { output.appendLine(stdout); }
                            if (stderr) { output.appendLine('[stderr] ' + stderr); }
                            output.appendLine(`[exit ${exitCode ?? 0}]`);

                            const combined = (stdout || '') + (stderr || '');
                            if (/(?:command not found|unrecognized command line option|cannot execute binary file|execvp: No such file or directory|can't open file '.*(?:flawfinder|ikos|tscancode|cppcheck).*':\s*\[Errno 2\] No such file or directory|\/opt\/homebrew\/bin\/cppcheck:\s*(?:No such file or directory|not found))/i.test(combined)) {
                                hadToolExecutionWarning = true;
                                output.appendLine('[ctrace warning] Note: one or more static analysis tools (e.g. cppcheck/flawfinder/ikos/tscancode) could not be executed by ctrace.');
                            }

                            tempFiles.forEach(tryDelete);

                            if (killed) {
                                if (token.isCancellationRequested) {
                                    break;
                                }
                                output.appendLine(`[timed out] ${fileName}`);
                                vscode.window.showWarningMessage(`Analysis of ${fileName} timed out (${timeoutMs / 1000}s). You can raise "ctrace.analysis.timeoutSeconds" in the settings.`);
                            }

                            let reportContent = '';
                            try {
                                if (reportPath && fs.existsSync(reportPath)) {
                                    reportContent = await fs.promises.readFile(reportPath, 'utf8');
                                }
                            } catch { /* ignore */ }

                            const sarif = await parseSarifOutput(stdout, reportPath);
                            tryDelete(reportPath);

                            // Extract and publish stack analyzer data
                            let fileStack: any = null;
                            try {
                                let sourceCode: string | undefined;
                                try {
                                    sourceCode = await fs.promises.readFile(fp, 'utf8');
                                } catch { /* ignore */ }

                                let stackReport = parseStackReport(reportContent, sourceCode) ?? parseStackReport(stdout, sourceCode);

                                // If ctrace was run with --sarif-format, ctrace >= 0.80 suppresses the stack analyzer
                                // rendering from stdout/report-file into SARIF-only results (no function/stack metrics).
                                // In that case, run a fast dedicated stack pass (~20ms) to retrieve the call-graph & stack metrics.
                                if (!stackReport || stackReport.functions.length === 0) {
                                    const isStackRequested = (
                                        (effectiveUiState.staticEnabled !== false &&
                                            (effectiveUiState.staticTools === undefined || effectiveUiState.staticTools.includes('ctrace_stack_analyzer'))) ||
                                        (effectiveUiState.dynamicEnabled !== false &&
                                            effectiveUiState.dynamicTools?.includes('ctrace_stack_analyzer'))
                                    );
                                    if (isStackRequested) {
                                        try {
                                            const stackArgs = buildStackAnalyzerArgs({
                                                ...effectiveUiState,
                                                configFile: hasConfig ? configPath : effectiveUiState.configFile,
                                            }, ctraceConfig);
                                            const { command: stackCmd, tempFiles: stackTemp } = await buildCommand(ctracePath, fp, shellQuoteArgs(stackArgs));
                                            try {
                                                const stackRes = await runCommand(stackCmd, extensionPath, token, timeoutMs);
                                                const stackOut = (stackRes.stdout || '') + (stackRes.stderr || '');
                                                stackReport = parseStackReport(stackOut, sourceCode);
                                            } finally {
                                                stackTemp.forEach(tryDelete);
                                            }
                                        } catch (err) {
                                            console.warn('[StackAnalyzer] Fallback extraction failed:', err);
                                        }
                                    }
                                }

                                if (stackReport && stackReport.functions.length > 0) {
                                    fileStack = stackReport;
                                    publishStack(stackReport);
                                }
                            } catch (e) {
                                console.warn('[StackAnalyzer] Error parsing stack data:', e);
                            }
                            if (sarif) {
                                normalizeSarifArtifactUris(sarif, fp);
                                allSarif.push(sarif);
                                lastSarifByFile.set(fp, sarif);
                                updateDiagnostics(sarif, diagnosticCollection, fp, !scanWorkspace, { isIgnored });
                                if (incremental && !killed && queue[i].hash) {
                                    cacheFileAnalysis(queue[i], contextKey, { sarif, stack: fileStack });
                                }
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
                        const total = countVisibleResults(merged);

                        try {
                            await findingsStore.save(merged);
                        } catch (error) {
                            output.appendLine(`[ctrace] Could not save the latest findings: ${error}`);
                        }
                        sidebarProvider.postMessage({
                            type: 'analysis-result',
                            data: merged,
                        });

                        const filesSuffix = (scanWorkspace && filesToAnalyze.length > 1
                            ? ` across ${filesToAnalyze.length} files`
                            : '') + (cachedCount > 0 ? ` (${cachedCount} unchanged, reused from cache)` : '');

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
                        if (incremental) {
                            void persistAnalysisCache();
                        }
                        isRunning = false;
                        sidebarProvider.postMessage({ type: 'analysis-done' });
                        if (republishPending) {
                            republishPending = false;
                            void republishFindings();
                        }
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
        vscode.commands.registerCommand('ctrace.clearAnalysisCache', async () => {
            await clearCache();
            StackManager.instance.clear();
            await findingsStore.clear();
            sidebarProvider.postMessage({ type: 'clear-results' });
            vscode.window.showInformationMessage('Ctrace analysis cache and saved results cleared.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.ignoreFinding', async (arg?: Partial<FindingRef>) => {
            const finding = isFindingRef(arg) ? arg : await pickFindingAtCursor();
            if (!finding) { return; }
            const reason = await vscode.window.showInputBox({
                title: `Ignore ${finding.ruleId ?? 'finding'}`,
                prompt: `Why is this finding ignored? (optional) — stored in ${IGNORE_FILE_NAME}`,
                placeHolder: 'e.g. false positive: the buffer size is checked by the caller',
            });
            if (reason === undefined) { return; }
            try {
                await ignoreList.add({
                    fingerprint: finding.fingerprint,
                    ruleId: finding.ruleId,
                    file: relativeFindingPath(finding.file, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
                    line: finding.line,
                    message: finding.message,
                    ...(reason.trim() ? { reason: reason.trim() } : {}),
                });
            } catch (e: any) {
                vscode.window.showErrorMessage(`Could not ignore the finding: ${e?.message ?? e}`);
                return;
            }
            const action = await vscode.window.showInformationMessage(
                `Finding ignored. It is listed in ${IGNORE_FILE_NAME}.`,
                'Undo'
            );
            if (action === 'Undo') {
                await ignoreList.remove([finding.fingerprint]);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.manageIgnoredFindings', async () => {
            const entries = ignoreList.list();
            if (entries.length === 0) {
                vscode.window.showInformationMessage('No CoreTrace finding is ignored in this workspace.');
                return;
            }
            const openFileButton: vscode.QuickInputButton = {
                iconPath: new vscode.ThemeIcon('go-to-file'),
                tooltip: `Open ${IGNORE_FILE_NAME}`,
            };
            const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { fingerprint: string }>();
            quickPick.title = 'Ignored CoreTrace findings — select the ones to restore';
            quickPick.canSelectMany = true;
            quickPick.matchOnDetail = true;
            quickPick.buttons = [openFileButton];
            quickPick.items = entries.map(entry => ({
                fingerprint: entry.fingerprint,
                label: entry.ruleId ?? 'Finding',
                description: entry.file ? `${entry.file}${entry.line ? `:${entry.line}` : ''}` : undefined,
                detail: [entry.message, entry.reason ? `Reason: ${entry.reason}` : ''].filter(Boolean).join(' — '),
            }));
            quickPick.onDidTriggerButton(async () => {
                quickPick.hide();
                if (ignoreList.filePath) {
                    await vscode.window.showTextDocument(vscode.Uri.file(ignoreList.filePath));
                }
            });
            quickPick.onDidAccept(async () => {
                const selected = quickPick.selectedItems.map(item => item.fingerprint);
                quickPick.hide();
                if (selected.length > 0) {
                    await ignoreList.remove(selected);
                    vscode.window.showInformationMessage(`${selected.length} finding${selected.length > 1 ? 's' : ''} restored.`);
                }
            });
            quickPick.onDidHide(() => quickPick.dispose());
            quickPick.show();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ctrace.focusStackFunction', async (functionName?: string) => {
            await vscode.commands.executeCommand('workbench.view.extension.ctrace-sidebar-view');
            sidebarProvider.postMessage({
                type: 'focus-stack-tab',
                functionName,
            });
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

function isFindingRef(value: unknown): value is FindingRef {
    const v = value as Partial<FindingRef> | undefined;
    return typeof v?.fingerprint === 'string' && v.fingerprint.length > 0 &&
        typeof v.file === 'string' && Number.isFinite(v.line);
}

/** Used when "Ignore finding" is run from the Command Palette. */
async function pickFindingAtCursor(): Promise<FindingRef | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('Place the cursor on a CoreTrace finding to ignore it.');
        return undefined;
    }
    const uri = editor.document.uri;
    const findings = vscode.languages.getDiagnostics(uri)
        .filter(d => d.source?.startsWith('CoreTrace') && d.range.contains(editor.selection.active))
        .map(d => getFindingForDiagnostic(uri, d))
        .filter((f): f is FindingRef => f !== undefined);
    if (findings.length === 0) {
        vscode.window.showInformationMessage('There is no CoreTrace finding at the cursor.');
        return undefined;
    }
    if (findings.length === 1) { return findings[0]; }
    const picked = await vscode.window.showQuickPick(
        findings.map(f => ({ label: f.ruleId ?? 'Finding', detail: f.message, finding: f })),
        { title: 'Which finding do you want to ignore?' }
    );
    return picked?.finding;
}

function countVisibleResults(sarif: any): number {
    if (!Array.isArray(sarif?.runs)) { return 0; }
    return sarif.runs.reduce((sum: number, run: any) =>
        sum + (run.results ?? []).filter((r: any) => r.properties?.ctraceIgnored !== true).length, 0);
}

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
                    const seen = new Set(existingRun.results.map((r: any) => {
                        const loc = r.locations?.[0]?.physicalLocation;
                        return `${r.ruleId || ''}|${loc?.artifactLocation?.uri || ''}|${loc?.region?.startLine ?? ''}|${r.message?.text || ''}`;
                    }));
                    for (const r of run.results) {
                        const loc = r.locations?.[0]?.physicalLocation;
                        const key = `${r.ruleId || ''}|${loc?.artifactLocation?.uri || ''}|${loc?.region?.startLine ?? ''}|${r.message?.text || ''}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            existingRun.results.push(r);
                        }
                    }
                }
            }
        }
    }

    return merged;
}

function normalizeSarifArtifactUris(sarif: any, analysedFilePath: string): void {
    if (!sarif || !Array.isArray(sarif.runs)) { return; }
    for (const run of sarif.runs) {
        if (!run || !Array.isArray(run.results)) { continue; }
        for (const result of run.results) {
            for (const loc of result.locations || []) {
                const art = loc?.physicalLocation?.artifactLocation;
                if (art && typeof art.uri === 'string') {
                    const uri = art.uri.replace(/\\/g, '/');
                    if (
                        uri.includes('/tmp/ikos') ||
                        uri.endsWith('.bc') ||
                        uri.endsWith('.ll') ||
                        uri.endsWith('.o') ||
                        (!fs.existsSync(art.uri) && uri.startsWith('/tmp/'))
                    ) {
                        art.uri = analysedFilePath;
                    }
                }
            }
        }
    }
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
