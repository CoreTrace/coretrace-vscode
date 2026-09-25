import * as vscode from "vscode";
import { isUpdatingBinary } from "./ctrace/BinaryUpdater";
import { StackManager } from "./ctrace/StackManager";
import { FindingsStore } from "./ctrace/FindingsStore";

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  _view?: vscode.WebviewView;
  private _disposables: vscode.Disposable[] = [];
  private _ready = false;
  private _pendingMessages: any[] = [];

  constructor(private readonly _extensionUri: vscode.Uri, private readonly _findingsStore: FindingsStore) {}

  public dispose(): void {
    while (this._disposables.length) {
      const d = this._disposables.pop();
      d?.dispose();
    }
    this._view = undefined;
  }

  public postMessage(msg: any): Thenable<boolean> | undefined {
    if (!this._view || !this._ready) {
      this._pendingMessages.push(msg);
      return undefined;
    }
    return this._view.webview.postMessage(msg);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    this._ready = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // ── Active file & binary status tracking ──────────────────────────────
    const postActiveFile = (editor: vscode.TextEditor | undefined) => {
      const name = editor?.document.uri.path.split('/').pop() ?? null;
      this._view?.webview.postMessage({ type: 'active-file', name });
    };

    const syncBinaryStatus = () => {
      // Reflect only an active download; startup leaves the button ready.
      if (isUpdatingBinary()) {
        this._view?.webview.postMessage({ type: 'analysis-downloading', progress: 'In progress…' });
      } else {
        this._view?.webview.postMessage({ type: 'analysis-download-complete' });
      }
    };

    // Push initial state immediately when the sidebar first resolves
    postActiveFile(vscode.window.activeTextEditor);
    syncBinaryStatus();

    // Keep it updated whenever the user switches tabs
    const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(postActiveFile);
    this._disposables.push(activeEditorListener);
    webviewView.onDidDispose(() => {
      activeEditorListener.dispose();
      if (this._view === webviewView) {
        this._view = undefined;
        this._ready = false;
      }
    });

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "webview-ready": {
          this._ready = true;
          syncBinaryStatus();
          postActiveFile(vscode.window.activeTextEditor);
          const savedFindings = this._findingsStore.get();
          if (savedFindings && !this._pendingMessages.some(message => message.type === "analysis-result" || message.type === "clear-results")) {
            webviewView.webview.postMessage({ type: "analysis-result", data: savedFindings.report, restored: true, savedAt: savedFindings.savedAt });
          }
          const latestStack = StackManager.instance.getLatestReport();
          if (latestStack && !this._pendingMessages.some(message => message.type === "stack-data")) {
            webviewView.webview.postMessage({ type: "stack-data", data: latestStack });
          }
          for (const message of this._pendingMessages.splice(0)) {
            webviewView.webview.postMessage(message);
          }
          break;
        }
        case "onInfo": {
          if (!data.value) {
            return;
          }
          vscode.window.showInformationMessage(data.value);
          break;
        }
        case "onError": {
          if (!data.value) {
            return;
          }
          vscode.window.showErrorMessage(data.value);
          break;
        }
        case "execute-command": {
            const allowedCommands = ['ctrace.runAnalysis', 'ctrace.runWorkspaceAnalysis', 'ctrace.clearAnalysisCache', 'ctrace.showHelp', 'ctrace.installDependencies', 'ctrace.focusStackFunction'];
            if (!allowedCommands.includes(data.command)) {
                console.warn(`[CoreTrace] Blocked unauthorized command from webview: ${data.command}`);
                return;
            }
            vscode.commands.executeCommand(data.command, data.params);
            break;
        }
        case "pick-compile-commands": {
          const selected = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            openLabel: "Use compile_commands.json",
            filters: { "Compilation database": ["json"] },
          });
          if (selected?.[0]) {
            webviewView.webview.postMessage({
              type: "compile-commands-selected",
              path: selected[0].fsPath,
            });
          }
          break;
        }
        case "open-file": {
          try {
            const openUri = await resolveReportedFileUri(data.path);
            if (!openUri) {
              vscode.window.showErrorMessage(`Could not find source file in this workspace: ${data.path}`);
              break;
            }
            const doc = await vscode.workspace.openTextDocument(openUri);
            const editor = await vscode.window.showTextDocument(doc);
            const safeLine = Number.isFinite(data.line) ? Math.max(0, Math.floor(data.line)) : 0;
            const line = Math.min(safeLine, Math.max(0, doc.lineCount - 1));
            const range = new vscode.Range(line, 0, line, 0);
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          } catch (e) {
            vscode.window.showErrorMessage(`Failed to open file: ${e}`);
          }
          break;
        }
      }
    });
  }

  public revive(panel: vscode.WebviewView) {
    this._view = panel;
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "main.js")
    );
    const styleMainUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, "media", "style.css")
    );
    const lucideUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, "media", "lucide.min.js")
    );

    // Use a nonce to only allow specific scripts to be run
    const nonce = getNonce();

    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleMainUri}" rel="stylesheet">
				<title>Ctrace Audit</title>
			</head>
			<body>

				<div class="sidebar">

          <div id="dashboard-view" class="view-panel active" aria-label="Ctrace dashboard">

					<!-- Header -->
					<div class="header">
            <div class="header-topline">
              <span class="header-title">Ctrace Audit</span>
              <button class="btn-settings" id="settings-btn" type="button" title="Open settings" aria-label="Open settings">
                <i data-lucide="settings"></i>
              </button>
            </div>
					</div>

					<!-- Current file -->
					<div class="file-pill" id="file-pill">
						<i data-lucide="file-code-2"></i>
						<span id="file-label">Open a C/C++ file to analyse</span>
					</div>

          <!-- Scan mode -->
          <div class="scan-mode-row" id="scan-mode-row">
            <button class="scan-mode-btn active" id="scan-file-btn" type="button">
              <i data-lucide="file-code-2"></i><span>Scan File</span>
            </button>
            <button class="scan-mode-btn" id="scan-workspace-btn" type="button">
              <i data-lucide="folder-search"></i><span>Scan Workspace</span>
            </button>
          </div>

					<!-- Run button and analysis mode -->
          <div class="run-controls">
						<button class="btn-run" id="run-btn">
							<i data-lucide="scan-search" class="icon-idle"></i>
							<i data-lucide="loader-circle" class="icon-running"></i>
							<span id="run-label">Run Analysis</span>
						</button>

            <div class="analysis-mode-row" aria-label="Analysis modes">
              <div class="analysis-mode-menu">
                <button class="analysis-mode-toggle active" id="static-tools-btn" type="button" aria-haspopup="true" aria-expanded="false">
                  <i data-lucide="shield-check"></i><span>Static</span><i data-lucide="chevron-down" class="mode-chevron"></i>
                </button>
                <div class="tool-dropdown" id="static-tools-menu" hidden>
                  <span class="tool-dropdown-title">Static tools</span>
                  <label><input type="checkbox" class="static-tool" value="cppcheck" checked><span>cppcheck</span></label>
                  <label><input type="checkbox" class="static-tool" value="flawfinder" checked><span>flawfinder</span></label>
                  <label><input type="checkbox" class="static-tool" value="ikos" checked><span>ikos</span></label>
                  <label><input type="checkbox" class="static-tool" value="tscancode" checked><span>tscancode</span></label>
                </div>
              </div>
              <div class="analysis-mode-menu">
                <button class="analysis-mode-toggle active" id="dynamic-tools-btn" type="button" aria-haspopup="true" aria-expanded="false">
                  <i data-lucide="activity"></i><span>Dynamic</span><i data-lucide="chevron-down" class="mode-chevron"></i>
                </button>
                <div class="tool-dropdown" id="dynamic-tools-menu" hidden>
                  <span class="tool-dropdown-title">Dynamic tools</span>
                  <label><input type="checkbox" class="dynamic-tool" value="ctrace_stack_analyzer" checked><span>ctrace_stack_analyzer</span></label>
                </div>
              </div>
            </div>
          </div>

          <div class="profile-select">
            <span>Analysis profile</span>
            <button class="profile-cycle-btn" id="analysis-profile-toggle" type="button" aria-label="Analysis profile: Full" title="Click to switch profile">
              <span id="analysis-profile-label">Full</span>
              <i data-lucide="repeat-2"></i>
            </button>
          </div>

          <section class="audit-status" aria-live="polite" aria-atomic="true">
            <div class="status-line">
              <span class="status-dot" id="status-dot"></span>
              <span id="status-text">Ready to audit</span>
              <span class="status-detail" id="status-detail"></span>
            </div>
            <div class="progress-track" id="progress-track" hidden>
              <div class="progress-bar" id="progress-bar"></div>
            </div>
          </section>

          </div>

          <div id="settings-view" class="view-panel settings-panel" aria-label="Ctrace settings" aria-hidden="true">
            <div class="settings-header">
              <button class="btn-back" id="back-btn" type="button">
                <i data-lucide="arrow-left"></i><span>Back to Dashboard</span>
              </button>
              <div class="settings-header-actions">
                <span class="settings-title">Settings</span>
                <button class="btn-help" id="help-btn" type="button" title="Show ctrace command help" aria-label="Show ctrace command help">
                  <i data-lucide="circle-help"></i>
                </button>
              </div>
            </div>

          <!-- Filters & Scope -->
          <details class="config-section">
            <summary><i data-lucide="filter"></i><span>Filters &amp; Scope</span><i data-lucide="chevron-down" class="section-chevron"></i></summary>
            <div class="config-content">
              <label for="only-function">Function filter</label>
              <input type="text" id="only-function" placeholder="e.g. isPositive">
              <div class="scan-workspace-only" id="only-dir-group">
                <label for="only-dir">Directory filter</label>
                <input type="text" id="only-dir" placeholder="src,lib">
              </div>
              <div class="scan-workspace-only" id="exclude-dir-group">
                <label for="exclude-dir">Exclude directories</label>
                <input type="text" id="exclude-dir" placeholder="build,.cache" />
              </div>
              <label class="config-toggle">
                <input type="checkbox" id="include-stl">
                <span>Include STL / system libraries</span>
              </label>
              <label class="config-toggle" id="cross-tu-group">
                <input type="checkbox" id="resource-cross-tu">
                <span>Cross-TU resource analysis</span>
              </label>
              <label class="config-toggle" id="auto-entry-points-group">
                <input type="checkbox" id="auto-entry-points">
                <span>Auto-detect functions as entry-points</span>
                <small class="settings-hint" id="auto-entry-points-hint">(Option available only in Scan File)</small>
              </label>
            </div>
          </details>

          <!-- Advanced Engine -->
          <details class="config-section" id="smt-section">
            <summary><i data-lucide="cpu"></i><span>Advanced Engine (SMT)</span><i data-lucide="chevron-down" class="section-chevron"></i></summary>
            <div class="config-content">
              <label class="config-toggle">
                <input type="checkbox" id="smt-enabled">
                <span>Enable SMT Assistant</span>
              </label>
              <label for="smt-backend">SMT Backend</label>
              <select id="smt-backend">
                <option value="interval">interval</option>
                <option value="z3">z3</option>
                <option value="cvc5">cvc5</option>
              </select>
              <label for="smt-secondary-backend">SMT Secondary Backend</label>
              <select id="smt-secondary-backend">
                <option value="interval">interval</option>
                <option value="z3">z3</option>
                <option value="cvc5">cvc5</option>
              </select>
              <label for="smt-mode">SMT Mode</label>
              <select id="smt-mode">
                <option value="single">single</option>
                <option value="portfolio">portfolio</option>
                <option value="cross-check">cross-check</option>
                <option value="dual-consensus">dual-consensus</option>
              </select>
              <label for="smt-timeout-ms">SMT Timeout (ms)</label>
              <input type="number" id="smt-timeout-ms" min="1" step="1" placeholder="Optional">
              <label for="smt-rules">SMT Rules</label>
              <input type="text" id="smt-rules" placeholder="recursion,integer-overflow">
            </div>
          </details>

          <!-- Compilation & Build -->
          <details class="config-section">
            <summary><i data-lucide="hammer"></i><span>Compilation &amp; Build</span><i data-lucide="chevron-down" class="section-chevron"></i></summary>
            <div class="config-content">
              <label for="compile-commands-path">compile_commands.json</label>
              <div class="file-input-row">
                <input type="text" id="compile-commands-path" placeholder="Path to compile_commands.json">
                <button class="input-action-btn" id="browse-compile-commands" type="button" title="Choose compile_commands.json" aria-label="Choose compile_commands.json">
                  <i data-lucide="folder-open"></i>
                </button>
              </div>
              <label class="config-toggle">
                <input type="checkbox" id="compdb-fast">
                <span>Fast Compdb</span>
              </label>
              <label class="config-toggle">
                <input type="checkbox" id="include-compdb-deps">
                <span>Include Compdb Deps</span>
              </label>
              <label for="compiler-extra-args">Compiler Extra Args</label>
              <input type="text" id="compiler-extra-args" placeholder="e.g. -include stdbool.h">
              <label for="extra-includes">Extra Includes (-I)</label>
              <input type="text" id="extra-includes" placeholder="include,third_party/include">
              <label for="macros">Macros (-D)</label>
              <input type="text" id="macros" placeholder="DEBUG,VERSION=2">
            </div>
          </details>

          <!-- Output & Diagnostics -->
          <details class="config-section">
            <summary><i data-lucide="message-square-warning"></i><span>Output &amp; Diagnostics</span><i data-lucide="chevron-down" class="section-chevron"></i></summary>
            <div class="config-content">
              <label class="config-toggle"><input type="checkbox" id="quiet"><span>Quiet Mode</span></label>
              <label class="config-toggle"><input type="checkbox" id="warnings-only"><span>Warnings Only</span></label>
              <label class="config-toggle"><input type="checkbox" id="timing"><span>Enable Timings</span></label>
              <label class="config-toggle"><input type="checkbox" id="demangle"><span>Demangle C++ Names</span></label>
              <label class="config-toggle"><input type="checkbox" id="dump-filter"><span>Dump Filter Decisions</span></label>
            </div>
          </details>

          <!-- External Analyzers & Tools -->
          <details class="config-section">
            <summary><i data-lucide="wrench"></i><span>Analyzers &amp; Dependencies</span><i data-lucide="chevron-down" class="section-chevron"></i></summary>
            <div class="config-content">
              <small class="settings-hint" style="display: block; margin-bottom: 8px;">Install or configure external tools: cppcheck, flawfinder, ikos, tscancode.</small>
              <button class="btn-settings-action" id="install-deps-btn" type="button" style="width: 100%; padding: 6px 12px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
                <i data-lucide="download"></i><span>Install / Repair Analyzers</span>
              </button>
            </div>
          </details>

          </div>

          <div id="dashboard-results" class="dashboard-results">

					<!-- Divider -->
					<div class="divider"></div>

					<!-- Results -->
					<div id="results-container" class="results-hidden">

            <!-- Result View Tabs -->
            <div class="results-tab-bar" role="tablist" aria-label="Analysis Results Tabs">
              <button class="results-tab active" id="tab-findings-btn" type="button" role="tab" aria-selected="true" aria-controls="panel-findings">
                <i data-lucide="shield-alert"></i>
                <span>Findings</span>
                <span class="tab-badge" id="tab-vuln-badge">0</span>
              </button>
              <button class="results-tab" id="tab-stack-btn" type="button" role="tab" aria-selected="false" aria-controls="panel-stack">
                <i data-lucide="layers"></i>
                <span>Stack Tree</span>
                <span class="tab-badge stack-tab-badge" id="tab-stack-badge">0</span>
              </button>
            </div>

            <!-- Panel 1: Findings (Vulnerabilities) -->
            <div id="panel-findings" class="tab-panel active" role="tabpanel">
              <div class="findings-summary" id="findings-summary" aria-label="Finding summary">
                <span class="summary-item"><strong id="summary-errors">0</strong><small>Errors</small></span>
                <span class="summary-item"><strong id="summary-warnings">0</strong><small>Warnings</small></span>
                <span class="summary-item"><strong id="summary-notes">0</strong><small>Info</small></span>
              </div>
              <div class="findings-toolbar">
                <label class="search-field" for="findings-search">
                  <i data-lucide="search"></i>
                  <input id="findings-search" type="search" placeholder="Search findings" autocomplete="off">
                </label>
                <select id="severity-filter" aria-label="Filter findings by severity">
                  <option value="all">All severities</option>
                  <option value="error">Errors</option>
                  <option value="warning">Warnings</option>
                  <option value="note">Info</option>
                </select>
              </div>
              <div class="findings-empty" id="findings-empty" hidden>No findings match the current filters.</div>
              <ul id="vuln-list"></ul>
            </div>

            <!-- Panel 2: Stack Visualizer (Call Tree & Memory) -->
            <div id="panel-stack" class="tab-panel" role="tabpanel" hidden>
              <!-- Metrics Cards -->
              <div class="stack-metrics-grid">
                <div class="stack-metric-card">
                  <span class="stack-metric-val" id="stack-peak-val">0 B</span>
                  <span class="stack-metric-label">Peak Stack</span>
                </div>
                <div class="stack-metric-card">
                  <span class="stack-metric-val" id="stack-recursion-val">0</span>
                  <span class="stack-metric-label">Recursion</span>
                </div>
                <div class="stack-metric-card">
                  <span class="stack-metric-val" id="stack-functions-val">0</span>
                  <span class="stack-metric-label">Functions</span>
                </div>
              </div>

              <!-- Connected call graph -->
              <div class="stack-graph-heading">
                <div class="stack-section-title"><i data-lucide="workflow"></i><span>Call graph</span></div>
                <span id="stack-graph-count" class="stack-graph-count">0 links</span>
              </div>
              <div class="stack-graph-toolbar" aria-label="Call graph controls">
                <span class="stack-graph-caption">Drag to explore</span>
                <div class="stack-graph-zoom">
                  <button id="stack-zoom-out" type="button" aria-label="Zoom out" title="Zoom out"><i data-lucide="minus"></i></button>
                  <span id="stack-zoom-label">100%</span>
                  <button id="stack-zoom-in" type="button" aria-label="Zoom in" title="Zoom in"><i data-lucide="plus"></i></button>
                </div>
              </div>
              <div id="stack-graph-container" class="stack-graph-container" aria-label="Function call graph">
                <div class="stack-empty-hint">Run the stack analyzer to view functions and calls.</div>
              </div>
              <div id="stack-graph-inspector" class="stack-graph-inspector" hidden></div>
              <div class="stack-graph-legend"><span><i class="legend-link"></i>Call</span><span><i class="legend-cycle"></i>Recursion</span><span>Click a node to inspect</span></div>

              <!-- Functions Hierarchy Section -->
              <div class="stack-section-title" style="margin-top: 14px;">
                <i data-lucide="list-tree"></i><span>Function Stack Footprints</span>
              </div>
              <div class="findings-toolbar" style="margin-bottom: 8px;">
                <label class="search-field" for="stack-search" style="width: 100%;">
                  <i data-lucide="search"></i>
                  <input id="stack-search" type="search" placeholder="Filter functions by name" autocomplete="off">
                </label>
              </div>
              <ul id="stack-fn-list" class="stack-fn-list"></ul>
            </div>

					</div>

					<!-- Empty state -->
					<div class="empty-state" id="empty-state">
						<i data-lucide="shield"></i>
            <strong>No analysis run yet</strong>
            <p>Run an audit to detect security and code-quality issues in the selected scope.</p>
            <button class="empty-action" id="empty-run-btn" type="button">
              <i data-lucide="play"></i><span>Run Audit</span>
            </button>
					</div>

          </div>

				</div>

				<script nonce="${nonce}" src="${lucideUri}"></script>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
  }
}

async function resolveReportedFileUri(reportedPath: unknown): Promise<vscode.Uri | null> {
  if (typeof reportedPath !== 'string' || !reportedPath.trim()) { return null; }

  const normalized = reportedPath.replace(/\\/g, '/');
  const hostPath = process.platform === 'win32'
    ? normalized.replace(/^\/mnt\/([a-z])\//i, (_match, drive: string) => `${drive.toUpperCase()}:/`)
    : normalized;
  const segments = normalized.split('/').filter(Boolean);
  // Reports can point to a different checkout. Prefer the matching file in
  // the workspace whose analysis produced the report.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const rootName = folder.uri.path.split('/').filter(Boolean).pop();
    if (!rootName) { continue; }
    const rootIndex = segments.map(part => part.toLowerCase()).lastIndexOf(rootName.toLowerCase());
    if (rootIndex < 0 || rootIndex === segments.length - 1) { continue; }
    const candidate = vscode.Uri.joinPath(folder.uri, ...segments.slice(rootIndex + 1));
    try {
      await vscode.workspace.fs.stat(candidate);
      return candidate;
    } catch { /* Try the next workspace folder. */ }
  }

  const direct = vscode.Uri.file(hostPath);
  try {
    await vscode.workspace.fs.stat(direct);
    return direct;
  } catch { /* Try the active document as a final fallback. */ }

  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.path.split('/').pop()?.toLowerCase() === segments[segments.length - 1]?.toLowerCase()) {
    return active;
  }
  return null;
}

function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
