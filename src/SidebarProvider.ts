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
    this._ready = false;
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
      this.postMessage({ type: 'active-file', name });
    };

    const syncBinaryStatus = () => {
      // Reflect only an active download; startup leaves the button ready.
      if (isUpdatingBinary()) {
        this._view?.webview.postMessage({ type: 'analysis-downloading', progress: 'In progress…' });
      } else {
        this._view?.webview.postMessage({ type: 'analysis-download-complete' });
      }
    };

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
            const allowedCommands = ['ctrace.runAnalysis', 'ctrace.runWorkspaceAnalysis', 'ctrace.clearAnalysisCache', 'ctrace.showHelp', 'ctrace.installDependencies', 'ctrace.focusStackFunction', 'ctrace.manageIgnoredFindings'];
            if (!allowedCommands.includes(data.command)) {
                console.warn(`[CoreTrace] Blocked unauthorized command from webview: ${data.command}`);
                return;
            }
            vscode.commands.executeCommand(data.command, data.params);
            break;
        }
        case "ignore-finding": {
          const fingerprint = typeof data.fingerprint === "string" && /^[0-9a-f]{8,64}$/.test(data.fingerprint) ? data.fingerprint : undefined;
          if (!fingerprint) { break; }
          const fileUri = await resolveReportedFileUri(data.path);
          vscode.commands.executeCommand("ctrace.ignoreFinding", {
            fingerprint,
            ruleId: typeof data.ruleId === "string" ? data.ruleId : undefined,
            file: fileUri?.fsPath ?? (typeof data.path === "string" ? data.path : ""),
            line: Number.isFinite(data.line) ? Math.max(1, Math.floor(data.line)) : 1,
            message: typeof data.message === "string" ? data.message : undefined,
          });
          break;
        }
        case "open-cwe": {
          const match = typeof data.cwe === "string" ? data.cwe.match(/^CWE-(\d{1,5})$/) : null;
          if (match) {
            vscode.env.openExternal(vscode.Uri.parse(`https://cwe.mitre.org/data/definitions/${match[1]}.html`));
          }
          break;
        }
        case "open-vscode-settings": {
          vscode.commands.executeCommand("workbench.action.openSettings", "@ext:CoreTrace.coretrace");
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
    const stackTreeUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, "media", "stackTree.js")
    );
    const logoUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, "media", "icon.png")
    );

    // Use a nonce to only allow specific scripts to be run
    const nonce = getNonce();

    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleMainUri}" rel="stylesheet">
				<title>CoreTrace</title>
			</head>
			<body>

				<div class="sidebar">

          <div id="dashboard-view" class="view-panel active" aria-label="CoreTrace dashboard">

					<!-- Header -->
					<div class="header">
            <div class="header-topline">
              <span class="header-title">CoreTrace</span>
              <button class="btn-settings" id="settings-btn" type="button" title="Open settings" aria-label="Open settings">
                <i data-lucide="settings"></i>
                <span class="settings-badge" id="settings-badge" hidden></span>
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
                  <img src="${logoUri}" alt="CoreTrace" class="mode-logo"><span>Static</span><i data-lucide="chevron-down" class="mode-chevron"></i>
                </button>
                <div class="tool-dropdown" id="static-tools-menu" hidden>
                  <span class="tool-dropdown-title">Static tools</span>
                  <label><input type="checkbox" class="static-tool" value="cppcheck" checked><span>cppcheck</span></label>
                  <label><input type="checkbox" class="static-tool" value="flawfinder" checked><span>flawfinder</span></label>
                  <label><input type="checkbox" class="static-tool" value="ikos" checked><span>ikos</span></label>
                  <label><input type="checkbox" class="static-tool" value="tscancode" checked><span>tscancode</span></label>
                  <label><input type="checkbox" class="static-tool" value="ctrace_stack_analyzer" checked><span>ctrace_stack_analyzer</span></label>
                </div>
              </div>
              <div class="analysis-mode-menu">
                <button class="analysis-mode-toggle active" id="dynamic-tools-btn" type="button" aria-haspopup="true" aria-expanded="false">
                  <i data-lucide="activity"></i><span>Dynamic</span><i data-lucide="chevron-down" class="mode-chevron"></i>
                </button>
                <div class="tool-dropdown" id="dynamic-tools-menu" hidden>
                  <span class="tool-dropdown-title">Dynamic tools</span>
                  <label><input type="checkbox" class="dynamic-tool" value="coretrace-runtime-analyzer" checked><span>coretrace-runtime-analyzer</span></label>
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
            <div class="settings-top">
            <div class="settings-header">
              <button class="btn-back" id="back-btn" type="button" title="Back to dashboard" aria-label="Back to dashboard">
                <i data-lucide="arrow-left"></i>
              </button>
              <span class="settings-title">Settings</span>
            </div>
            <label class="search-field" for="settings-search">
              <i data-lucide="search"></i>
              <input id="settings-search" type="search" placeholder="Search settings" autocomplete="off">
            </label>
          </div>

          <div class="settings-sections">
          <details class="config-section" data-section="scope" open>
            <summary><i data-lucide="filter"></i><span class="config-title">Scope</span><span class="config-count" hidden></span><i data-lucide="chevron-down" class="section-chevron"></i></summary>
            <div class="config-content">
              <div class="setting">
                <label class="setting-label" for="only-function">Function filter</label>
                <input type="text" id="only-function" placeholder="main,parse_config">
                <small class="setting-hint">Only report functions with these names.</small>
              </div>
              <div class="setting" id="only-dir-group">
                <label class="setting-label" for="only-dir">Only directories</label>
                <input type="text" id="only-dir" placeholder="src,lib">
                <small class="setting-hint">Only report functions under these directories.</small>
                <small class="setting-scope">Scan Workspace only</small>
              </div>
              <div class="setting" id="exclude-dir-group">
                <label class="setting-label" for="exclude-dir">Exclude directories</label>
                <input type="text" id="exclude-dir" placeholder="build,.cache">
                <small class="setting-hint">Skip input files under these directories.</small>
                <small class="setting-scope">Scan Workspace only</small>
              </div>
              <label class="setting setting-toggle">
                <span class="setting-text">
                  <span class="setting-label">Include system libraries</span>
                  <small class="setting-hint">Also analyse STL, system and third-party functions.</small>
                </span>
                <input type="checkbox" class="switch" id="include-stl">
              </label>
              <label class="setting setting-toggle" id="cross-tu-group">
                <span class="setting-text">
                  <span class="setting-label">Cross-file resource analysis</span>
                  <small class="setting-hint">Follow resource lifetimes across translation units.</small>
                  <small class="setting-scope">Scan Workspace only</small>
                </span>
                <input type="checkbox" class="switch" id="resource-cross-tu">
              </label>
              <label class="setting setting-toggle" id="auto-entry-points-group">
                <span class="setting-text">
                  <span class="setting-label">All functions as entry points</span>
                  <small class="setting-hint">Start from every function of the file instead of main.</small>
                  <small class="setting-scope">Scan File only</small>
                </span>
                <input type="checkbox" class="switch" id="auto-entry-points">
              </label>
            </div>
          </details>

          <details class="config-section" data-section="build">
            <summary><i data-lucide="hammer"></i><span class="config-title">Compilation</span><span class="config-count" hidden></span><i data-lucide="chevron-down" class="section-chevron"></i></summary>
            <div class="config-content">
              <div class="setting">
                <label class="setting-label" for="compile-commands-path">compile_commands.json</label>
                <div class="file-input-row">
                  <input type="text" id="compile-commands-path" placeholder="Auto-detected when empty">
                  <button class="input-action-btn" id="browse-compile-commands" type="button" title="Choose compile_commands.json" aria-label="Choose compile_commands.json">
                    <i data-lucide="folder-open"></i>
                  </button>
                </div>
              </div>
              <div class="setting">
                <label class="setting-label" for="extra-includes">Include directories (-I)</label>
                <input type="text" id="extra-includes" placeholder="include,third_party/include">
                <small class="setting-hint">Comma-separated.</small>
              </div>
              <div class="setting">
                <label class="setting-label" for="macros">Macros (-D)</label>
                <input type="text" id="macros" placeholder="DEBUG,VERSION=2">
                <small class="setting-hint">Comma-separated.</small>
              </div>
              <div class="setting">
                <label class="setting-label" for="compiler-extra-args">Extra compiler arguments</label>
                <input type="text" id="compiler-extra-args" placeholder="-include stdbool.h">
              </div>
              <label class="setting setting-toggle">
                <span class="setting-text">
                  <span class="setting-label">Fast compilation database</span>
                  <small class="setting-hint">Faster, but drops heavy build flags such as optimizations.</small>
                </span>
                <input type="checkbox" class="switch" id="compdb-fast">
              </label>
              <label class="setting setting-toggle">
                <span class="setting-text">
                  <span class="setting-label">Include dependencies</span>
                  <small class="setting-hint">Also load dependency entries (e.g. _deps) from the database.</small>
                </span>
                <input type="checkbox" class="switch" id="include-compdb-deps">
              </label>
            </div>
          </details>

          <details class="config-section" data-section="output">
            <summary><i data-lucide="message-square-warning"></i><span class="config-title">Output</span><span class="config-count" hidden></span><i data-lucide="chevron-down" class="section-chevron"></i></summary>
            <div class="config-content">
              <label class="setting setting-toggle">
                <span class="setting-text">
                  <span class="setting-label">Warnings and errors only</span>
                  <small class="setting-hint">Hide info-level diagnostics.</small>
                </span>
                <input type="checkbox" class="switch" id="warnings-only">
              </label>
              <label class="setting setting-toggle">
                <span class="setting-text">
                  <span class="setting-label">Quiet</span>
                  <small class="setting-hint">Suppress per-function diagnostics.</small>
                </span>
                <input type="checkbox" class="switch" id="quiet">
              </label>
              <label class="setting setting-toggle">
                <span class="setting-text">
                  <span class="setting-label">Demangle C++ names</span>
                  <small class="setting-hint">Show readable function names.</small>
                </span>
                <input type="checkbox" class="switch" id="demangle">
              </label>
              <label class="setting setting-toggle">
                <span class="setting-text">
                  <span class="setting-label">Timings</span>
                  <small class="setting-hint">Print stack analyzer timings in the Ctrace output.</small>
                </span>
                <input type="checkbox" class="switch" id="timing">
              </label>
              <label class="setting setting-toggle">
                <span class="setting-text">
                  <span class="setting-label">Filter decisions</span>
                  <small class="setting-hint">Print which functions the filters keep, for debugging them.</small>
                </span>
                <input type="checkbox" class="switch" id="dump-filter">
              </label>
            </div>
          </details>

          <details class="config-section" data-section="smt" id="smt-section">
            <summary><i data-lucide="cpu"></i><span class="config-title">SMT solver</span><span class="config-count" hidden></span><i data-lucide="chevron-down" class="section-chevron"></i></summary>
            <div class="config-content">
              <label class="setting setting-toggle" data-master>
                <span class="setting-text">
                  <span class="setting-label">Use an SMT solver</span>
                  <small class="setting-hint">Refine stack analyzer results. Slower, available in the Full profile.</small>
                </span>
                <input type="checkbox" class="switch" id="smt-enabled">
              </label>
              <div class="setting-group is-hidden" id="smt-fields">
              <div class="setting">
                <label class="setting-label" for="smt-backend">Backend</label>
                <select id="smt-backend">
                  <option value="interval">interval</option>
                  <option value="z3">z3</option>
                  <option value="cvc5">cvc5</option>
                </select>
              </div>
              <div class="setting">
                <label class="setting-label" for="smt-mode">Mode</label>
                <select id="smt-mode">
                  <option value="single">single</option>
                  <option value="portfolio">portfolio</option>
                  <option value="cross-check">cross-check</option>
                  <option value="dual-consensus">dual-consensus</option>
                </select>
              </div>
              <div class="setting" id="smt-secondary-group">
                <label class="setting-label" for="smt-secondary-backend">Secondary backend</label>
                <select id="smt-secondary-backend">
                  <option value="interval">interval</option>
                  <option value="z3">z3</option>
                  <option value="cvc5">cvc5</option>
                </select>
                <small class="setting-hint">Used by the multi-solver modes.</small>
              </div>
              <div class="setting">
                <label class="setting-label" for="smt-timeout-ms">Timeout (ms)</label>
                <input type="number" id="smt-timeout-ms" placeholder="Default" min="1" step="1">
              </div>
              <div class="setting">
                <label class="setting-label" for="smt-rules">Rules</label>
                <input type="text" id="smt-rules" placeholder="recursion,integer-overflow">
                <small class="setting-hint">Restrict SMT to these rules.</small>
              </div>
              </div>
            </div>
          </details>

          </div>
          <div class="settings-no-match" id="settings-no-match" hidden>No settings match your search.</div>

          <div class="settings-actions">
            <button class="settings-action" id="install-deps-btn" type="button">
              <i data-lucide="download"></i><span>Install or repair analyzers</span>
            </button>
            <button class="settings-action" id="open-vscode-settings" type="button" title="Timeout, incremental scans, analysis models…">
              <i data-lucide="sliders-horizontal"></i><span>More in VS Code settings</span>
            </button>
            <button class="settings-action" id="help-btn" type="button">
              <i data-lucide="circle-help"></i><span>ctrace command help</span>
            </button>
            <button class="settings-action settings-reset" id="reset-settings" type="button" disabled>
              <i data-lucide="rotate-ccw"></i><span id="reset-settings-label">Reset to defaults</span>
            </button>
          </div>

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

              <!-- Call tree -->
              <label class="search-field" for="stack-search">
                <i data-lucide="search"></i>
                <input id="stack-search" type="search" placeholder="Filter by function or file…" autocomplete="off">
              </label>
              <div class="stack-tree-toolbar">
                <div class="stack-view-modes" role="group" aria-label="Stack view">
                  <button id="stack-view-tree" class="stack-mode-btn active" type="button" aria-pressed="true" title="Who calls what">Call tree</button>
                  <button id="stack-view-ranking" class="stack-mode-btn" type="button" aria-pressed="false" title="All functions, heaviest first">Ranking</button>
                </div>
                <div class="stack-tree-actions" id="stack-tree-actions">
                  <button id="stack-hot-path" type="button" aria-label="Show the heaviest call path" title="Show the heaviest call path"><i data-lucide="flame"></i></button>
                  <button id="stack-expand-all" type="button" aria-label="Expand all" title="Expand all"><i data-lucide="chevrons-up-down"></i></button>
                  <button id="stack-collapse-all" type="button" aria-label="Collapse all" title="Collapse all"><i data-lucide="chevrons-down-up"></i></button>
                </div>
              </div>
              <div class="stack-tree-header">
                <span id="stack-tree-count">0 functions</span>
                <span>Peak stack</span>
              </div>
              <div id="stack-tree" class="stack-tree" role="tree" aria-label="Function call tree">
                <div class="stack-empty-hint">Run the stack analyzer to view functions and calls.</div>
              </div>
              <div id="stack-details" class="stack-details" hidden></div>
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
				<script nonce="${nonce}" src="${stackTreeUri}"></script>
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
  // Fallback: If reported path is a temporary or compiler intermediate artifact (e.g. /tmp/ikos-*/my.bc),
  // open the current active document in the editor.
  if (active && (normalized.includes('/tmp/ikos') || normalized.endsWith('.bc') || normalized.endsWith('.ll') || normalized.endsWith('.o'))) {
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
