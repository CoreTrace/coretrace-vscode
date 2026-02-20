# Ctrace Audit — VS Code Extension

VS Code extension integrating the **ctrace** static & dynamic C/C++ vulnerability analysis tool.

---

## Requirements

- [Node.js](https://nodejs.org/) ≥ 18
- [VS Code](https://code.visualstudio.com/) ≥ 1.80
- The `ctrace` binary placed at the **root of this repository** (next to `package.json`)

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Compile

```bash
npm run compile
```

Or in watch mode (recompiles on every file save):

```bash
npm run watch
```

### 3. Launch the Extension Development Host

Press **F5** inside VS Code (or go to **Run → Start Debugging**).

A second VS Code window titled **Extension Development Host** opens with the extension loaded.

---

## Running an Analysis

1. Open a C/C++ file in the Extension Development Host window.
2. Click the **Ctrace Audit** shield icon in the Activity Bar (left sidebar).
3. Enter your analysis parameters in the input field (e.g. `--entry-points=main --verbose --static --dyn`).
4. Click **Run Analysis**.

Results appear in three places:

| Location | Content |
|----------|---------|
| **Problems panel** (`Ctrl+Shift+M`) | Inline diagnostics (errors / warnings) with file & line |
| **Ctrace sidebar** | Clickable list of vulnerabilities — click to jump to the line |
| **Output panel → Ctrace** | Full raw output from the ctrace binary for debugging |

---

## Project Structure

```
coretrace-vscode/
├── ctrace                  # ctrace binary (not committed, place here manually)
├── src/
│   ├── extension.ts        # Extension entry point — registers commands & providers
│   ├── SidebarProvider.ts  # Webview sidebar (UI)
│   └── ctrace/
│       ├── BinaryLocator.ts    # Finds the ctrace binary in the extension folder
│       ├── CommandBuilder.ts   # Builds the CLI command (Linux native + WSL on Windows)
│       ├── AnalysisRunner.ts   # Executes the command, captures stdout/stderr
│       ├── SarifParser.ts      # Parses ctrace output into a SARIF object
│       └── DiagnosticsManager.ts # Converts SARIF results to VS Code diagnostics
├── media/
│   ├── main.js             # Webview frontend script
│   ├── style.css           # Webview styles
│   ├── reset.css
│   └── vscode.css
├── tests/                  # Sample C/C++ files for manual testing
├── package.json
└── tsconfig.json
```

---
