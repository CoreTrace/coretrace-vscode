import * as vscode from "vscode";

export class SidebarProvider implements vscode.WebviewViewProvider {
  _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

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
            // Execute the VS Code command associated with the button, passing the params
            vscode.commands.executeCommand(data.command, data.params);
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
    const styleResetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "reset.css")
    );
    const styleVSCodeUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "vscode.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "main.js")
    );
    const styleMainUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, "media", "style.css")
    );

    // Use a nonce to only allow specific scripts to be run
    const nonce = getNonce();

    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${styleResetUri}" rel="stylesheet">
				<link href="${styleVSCodeUri}" rel="stylesheet">
                <link href="${styleMainUri}" rel="stylesheet">
				
                <title>Ctrace Dashboard</title>
			</head>
			<body>
                <div class="container">
                    <div class="header">
                        <h2>Ctrace Audit</h2>
                        <span class="subtitle">Secure code dashboard</span>
                    </div>
                    
                    <div class="card">
                        <h3>Configuration</h3>
                        <p>Enter parameters for the Ctrace binary analysis.</p>
                        
                        <div class="input-group">
                            <label for="params-input">Analysis Parameters:</label>
                            <input 
                                type="text" 
                                id="params-input" 
                                placeholder="e.g. --entry-points=main --verbose --static"
                                value="--entry-points=main --verbose --static --dyn"
                            />
                        </div>

                        <button id="run-btn">Run Analysis</button>
                    </div>

                    <div id="results-container" class="results-hidden">
                        <h3>Vulnerabilities Found <span id="vuln-count" class="badge">0</span></h3>
                        <ul id="vuln-list">
                            <!-- Vulnerability items will be injected here -->
                        </ul>
                    </div>

                    <div class="info-box">
                        <p>Tip: Analysis runs on the currently open file.</p>
                    </div>
                </div>
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
