import * as vscode from "vscode";

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  _view?: vscode.WebviewView;
  private _disposables: vscode.Disposable[] = [];

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public dispose(): void {
    while (this._disposables.length) {
      const d = this._disposables.pop();
      d?.dispose();
    }
    this._view = undefined;
  }

  public postMessage(msg: any): Thenable<boolean> | undefined {
    return this._view?.webview.postMessage(msg);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // ── Active file tracking ───────────────────────────────────────────────
    const postActiveFile = (editor: vscode.TextEditor | undefined) => {
      const name = editor?.document.uri.path.split('/').pop() ?? null;
      this._view?.webview.postMessage({ type: 'active-file', name });
    };
    // Push current file immediately when the sidebar first resolves
    postActiveFile(vscode.window.activeTextEditor);
    // Keep it updated whenever the user switches tabs
    const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(postActiveFile);
    this._disposables.push(activeEditorListener);
    webviewView.onDidDispose(() => activeEditorListener.dispose());

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
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
            // Only allow explicitly whitelisted commands to prevent arbitrary command execution
            const allowedCommands = ['ctrace.runAnalysis', 'ctrace.runWorkspaceAnalysis', 'ctrace.clearAnalysisCache', 'ctrace.showHelp'];
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
             // Open file at specific line
             // Handle hybrid paths: If path starts with /mnt/c/, convert to C:/...
             // OR: Just fallback to the currently active editor if the filename matches!
             let filePathToOpen = data.path;

             try {
                // Heuristic: If we are in Windows context but path is WSL /mnt style
                if (filePathToOpen.startsWith('/mnt/')) {
                    // Quick map: /mnt/c/ -> c:/
                     filePathToOpen = filePathToOpen.replace(/^\/mnt\/([a-z])\//, (match:string, drive:string) => {
                         return `${drive.toUpperCase()}:/`;
                     });
                } else if (filePathToOpen.startsWith('\\mnt\\')) {
                      filePathToOpen = filePathToOpen.replace(/^\\mnt\\([a-z])\\/, (match:string, drive:string) => {
                         return `${drive.toUpperCase()}:/`;
                     });
                }
                
                // If it's still weird or nonexistent, and the user has a file open, use that if basename matches
                const active = vscode.window.activeTextEditor;
                if (active) {
                     const activeBasename = active.document.fileName.split(/[\\/]/).pop();
                     const targetBasename = filePathToOpen.split(/[\\/]/).pop();
                     if (activeBasename === targetBasename) {
                         filePathToOpen = active.document.uri.fsPath;
                     }
                }

                const openUri = vscode.Uri.file(filePathToOpen);
                
                // Use showTextDocument directly with the active doc if it matches, to avoid reload flicker
                const doc = await vscode.workspace.openTextDocument(openUri);
                const editor = await vscode.window.showTextDocument(doc);
                
                // Add minor delay or ensure range valid
                const safeLine = Math.max(0, data.line); 
                const range = new vscode.Range(safeLine, 0, safeLine, 0);
                
                editor.selection = new vscode.Selection(range.start, range.end);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

             } catch(e) {
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

          </div>

          <div id="dashboard-results" class="dashboard-results">

					<!-- Divider -->
					<div class="divider"></div>

					<!-- Results -->
					<div id="results-container" class="results-hidden">
						<div class="results-header">
							<div class="results-title">
								<i data-lucide="bug"></i>
								<span>Vulnerabilities</span>
							</div>
							<span class="badge" id="vuln-count">0</span>
						</div>
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

function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
