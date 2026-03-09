import * as vscode from 'vscode';
import * as path   from 'path';
import type { AnalysisParams } from './extension';

// ─── Webview → Extension message protocol ────────────────────────────────────
//
// Only these message shapes are accepted from the webview.
// Any message with an unknown `type` is silently discarded.
//
// Security note: the webview runs in a sandboxed iframe with a strict CSP,
// but we still validate every incoming message so that a compromised script
// cannot trigger unexpected host behaviour.

type WebviewMessage =
    | { type: 'execute-command'; command: string; params: AnalysisParams }
    | { type: 'open-file';       path: string;    line: number           };

// Commands the webview is explicitly allowed to trigger.
// Any other value is blocked and logged.
const ALLOWED_COMMANDS = new Set(['ctrace.runAnalysis']);

// ─── Extension → Webview message protocol ────────────────────────────────────

export type HostMessage =
    | { type: 'analysis-result'; data: unknown  }
    | { type: 'analysis-error'                  }
    | { type: 'active-file';     name: string | null };

// ─────────────────────────────────────────────────────────────────────────────

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {

    private _view: vscode.WebviewView | undefined;
    /** Disposables that must be released when the view is torn down. */
    private readonly _viewDisposables: vscode.Disposable[] = [];

    constructor(private readonly _extensionUri: vscode.Uri) {}

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Posts a typed message to the webview.
     * No-ops silently when the view is not yet resolved or has been disposed.
     */
    public postMessage(msg: HostMessage): void {
        this._view?.webview.postMessage(msg);
    }

    // ── WebviewViewProvider ───────────────────────────────────────────────────

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        // Dispose any stale subscriptions from a previous resolve call
        // (can happen when the view is moved between panel locations).
        this._disposeViewSubscriptions();
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._buildHtml(webviewView.webview);

        // Track all view-scoped disposables so they are cleaned up together.
        this._viewDisposables.push(
            // Incoming webview messages
            webviewView.webview.onDidReceiveMessage(
                (data: WebviewMessage) => this._handleMessage(data)
            ),
            // Active editor tracking
            this._setupActiveFileTracking(webviewView),
            // Clear references when VS Code tears down the view
            webviewView.onDidDispose(() => {
                this._disposeViewSubscriptions();
                this._view = undefined;
            })
        );
    }

    // ── Private: message dispatch ─────────────────────────────────────────────

    private _handleMessage(data: WebviewMessage): void {
        // Runtime guard: the TypeScript type only covers known shapes, but the
        // actual postMessage() data is untyped at the JS boundary.
        const msg = data as { type?: unknown };
        switch (msg.type) {
            case 'execute-command':
                return this._handleExecuteCommand(data as Extract<WebviewMessage, { type: 'execute-command' }>);
            case 'open-file':
                return this._handleOpenFile(data as Extract<WebviewMessage, { type: 'open-file' }>);
            default:
                console.warn('[CoreTrace] Received unknown message type from webview:', msg.type);
        }
    }

    private _handleExecuteCommand(data: Extract<WebviewMessage, { type: 'execute-command' }>): void {
        // Strict command allowlist — prevents the webview from executing
        // arbitrary VS Code commands even if the CSP is somehow bypassed.
        if (typeof data.command !== 'string' || !ALLOWED_COMMANDS.has(data.command)) {
            console.warn('[CoreTrace] Blocked unauthorized command from webview:', data.command);
            return;
        }
        // Validate params shape before forwarding (customParams must be a
        // non-empty string and is capped at 512 chars to prevent DoS via the
        // tokeniser in parseAndValidateParams).
        const params: AnalysisParams = {};
        const raw = data.params as Record<string, unknown> | undefined;
        if (raw && typeof raw.customParams === 'string' && raw.customParams.length > 0) {
            params.customParams = raw.customParams.slice(0, 512);
        }
        vscode.commands.executeCommand(data.command, params);
    }

    private _handleOpenFile(data: Extract<WebviewMessage, { type: 'open-file' }>): void {
        // Validate inputs — both arrive from untrusted webview data.
        if (typeof data.path !== 'string' || !data.path) {
            console.warn('[CoreTrace] open-file message has invalid path:', data.path);
            return;
        }
        const line = (typeof data.line === 'number' && isFinite(data.line))
            ? Math.max(0, data.line)
            : 0;

        this._openFileAtLine(data.path, line).catch(e => {
            console.error('[CoreTrace] Failed to open file:', e);
            vscode.window.showErrorMessage(`CoreTrace: Failed to open file — ${e}`);
        });
    }

    // ── Private: file navigation ──────────────────────────────────────────────

    private async _openFileAtLine(rawPath: string, line: number): Promise<void> {
        const resolvedPath = this._resolveFilePath(rawPath);
        const uri    = vscode.Uri.file(resolvedPath);
        const doc    = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const range  = new vscode.Range(line, 0, line, 0);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }

    /**
     * Normalises a file path that may arrive from ctrace as a WSL-style
     * `/mnt/<drive>/…` path when the extension is running on Windows.
     * If the basename matches the currently open document, falls back to
     * that path to avoid "file not found" when cross-FS mount points differ.
     */
    private _resolveFilePath(filePath: string): string {
        // /mnt/c/... or \\mnt\c\... → C:/...
        let resolved = filePath.replace(
            /^[/\\]{1,2}mnt[/\\]([a-zA-Z])[/\\]/,
            (_, drive: string) => `${drive.toUpperCase()}:/`
        );

        // Prefer the on-disk path VS Code already knows about when the
        // basenames match (avoids flicker and mount-point mismatch errors).
        const active = vscode.window.activeTextEditor;
        if (active) {
            const activeBase = path.basename(active.document.fileName);
            const targetBase = path.basename(resolved);
            if (activeBase === targetBase) {
                resolved = active.document.uri.fsPath;
            }
        }

        return resolved;
    }

    // ── Private: active-file tracking ─────────────────────────────────────────

    private _setupActiveFileTracking(_webviewView: vscode.WebviewView): vscode.Disposable {
        const post = (editor: vscode.TextEditor | undefined): void => {
            const name = editor ? path.basename(editor.document.uri.path) : null;
            // Route through this.postMessage() so stale webview references from
            // a previous resolve cycle (view moved between panels) are never used.
            this.postMessage({ type: 'active-file', name });
        };

        // Push current state immediately when the view first resolves.
        post(vscode.window.activeTextEditor);

        return vscode.window.onDidChangeActiveTextEditor(post);
    }

    // ── Private: lifecycle ────────────────────────────────────────────────────

    /** Called by VS Code when the extension is deactivated. */
    public dispose(): void {
        this._disposeViewSubscriptions();
        this._view = undefined;
    }

    private _disposeViewSubscriptions(): void {
        while (this._viewDisposables.length) {
            this._viewDisposables.pop()?.dispose();
        }
    }

    // ── Private: HTML ─────────────────────────────────────────────────────────

    private _buildHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
        const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css'));
        const lucideUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'lucide.min.js'));
        const nonce     = generateNonce();

        // CSP: scripts locked to nonce; styles to webview origin only.
        // No inline styles, no eval, no external connections.
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>Ctrace Audit</title>
</head>
<body>
    <div class="sidebar">

        <!-- Header -->
        <div class="header">
            <div class="header-icon"><i data-lucide="shield-check"></i></div>
            <span class="header-title">Ctrace Audit</span>
        </div>

        <!-- Current file -->
        <div class="file-pill" id="file-pill">
            <i data-lucide="file-code-2"></i>
            <span id="file-label">Open a C/C++ file to analyse</span>
        </div>

        <!-- Run button -->
        <button class="btn-run" id="run-btn">
            <i data-lucide="scan-search" class="icon-idle"></i>
            <i data-lucide="loader-circle" class="icon-running"></i>
            <span id="run-label">Run Analysis</span>
        </button>

        <!-- Advanced flags -->
        <div class="advanced-section">
            <button class="btn-advanced" id="advanced-btn">
                <i data-lucide="settings-2"></i>
                <span>Advanced flags</span>
                <i data-lucide="chevron-down" id="chevron"></i>
            </button>
            <div id="advanced-panel" class="advanced-panel advanced-hidden">
                <label for="params-input">CLI flags</label>
                <input
                    type="text"
                    id="params-input"
                    placeholder="--entry-points=main --static --dyn"
                    value="--entry-points=main --verbose --static --dyn"
                />
            </div>
        </div>

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
            <ul id="vuln-list"></ul>
        </div>

        <!-- Empty state -->
        <div class="empty-state" id="empty-state">
            <i data-lucide="shield"></i>
            <span>No analysis run yet</span>
        </div>

    </div>

    <script nonce="${nonce}" src="${lucideUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a cryptographically random nonce string for the CSP `script-src`
 * directive using Node's built-in `crypto` module (always available in the
 * VS Code extension host).
 */
function generateNonce(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto: typeof import('crypto') = require('crypto');
    return nodeCrypto.randomBytes(18).toString('base64');
}
