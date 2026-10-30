# CoreTrace VS Code Extension

CoreTrace VS Code brings the power of the `ctrace` security and quality analysis framework directly into Visual Studio Code. It provides seamless static and dynamic analysis for C and C++ projects, surfacing vulnerabilities, code defects, and stack diagnostics directly in your editor.

---

## 🚀 Key Features

### 1. Unified Diagnostics & Interactive Dashboard
CoreTrace orchestrates multiple industry-standard analyzers and unifies their output into a single, intuitive VS Code interface:
- **Integrated Static Analyzers**: Aggregates SARIF reports from **Cppcheck**, **Flawfinder**, **Ikos**, and **TscanCode**.
- **Dynamic & Stack Analysis**: Identifies stack overflows, infinite recursion risks, uninitialized variables, and large stack frame allocations (`ctrace_stack_analyzer`).
- **Compiler Warnings**: Intercepts Clang/GCC compiler diagnostics and maps them into standard editor problems.
- **Rich Dashboard**: Filter findings by severity (Errors, Warnings, Info), search by keyword, and click any item to jump directly to the source file and line.
- **Problems Panel Integration**: Every finding is also a native VS Code diagnostic, tagged with the analyzer that produced it (e.g. `CoreTrace (cppcheck)`). Findings reported into a header by several source files are all kept.
- **Cancellable Analyses**: Cancelling a run, or hitting the per-file timeout, stops `ctrace` and every analyzer it started — no orphaned processes.

### 2. 🛡️ In-Editor CodeLens: "Audit Function"
Perform targeted security checks without scanning an entire file or project:
- A `🛡️ Audit Function` CodeLens action appears directly above function, method, and constructor definitions in your C/C++ files.
- Clicking the lens runs an isolated analysis with entry points scoped to that specific function.

### 3. 📦 Automated Analyzer Dependency Installer
`ctrace` relies on external static analysis engines to maximize vulnerability detection. CoreTrace includes a built-in automated installer:
- **One-Click Installation**: Automatically installs, compiles, and configures `cppcheck`, `flawfinder`, `ikos`, and `tscancode` into `~/.coretrace/tools/`.
- **Automatic Environment Configuration**: Automatically exports binary paths and configures the execution environment without requiring manual `PATH` modifications.
- **Quick Access**: Accessible via the **"Install / Repair Analyzers"** button in the sidebar settings or via the Command Palette (`CoreTrace: Install Analyzers & Dependencies`).
- **Missing Tools Detection**: The extension notifies you if analyzer backends are missing and offers to set them up with one click.

### 4. Seamless Windows & WSL Support
- On **Linux** and **macOS**, `ctrace` runs natively.
- On **Windows**, the extension automatically detects and executes through **WSL** (Windows Subsystem for Linux).
- **In-Place Analysis**: Windows files are analyzed directly through WSL mount paths (`/mnt/...`), ensuring that relative `#include` directives and project directory trees resolve without broken includes.
- WSL paths in diagnostics are automatically translated back to native Windows paths in VS Code.

### 5. Intelligent `compile_commands.json` Discovery
Precise C/C++ static analysis requires knowledge of compiler flags, include directories, and macro definitions. CoreTrace automatically discovers your compilation database:
1. Workspace root (`compile_commands.json`).
2. Build directory (`build/compile_commands.json`).
3. Microsoft CMake Tools build directory configuration (honoring `cmake.buildDirectory` settings and VS Code variable substitutions).

> **💡 Tip for CMake users:** 
> Generate your compilation database automatically by adding this to your `CMakeLists.txt`:
> ```cmake
> set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
> ```
> Or pass the flag during CMake configuration:
> ```bash
> cmake -B build -S . -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
> ```

### 6. Incremental Workspace Scans
Save time on repetitive scans. CoreTrace computes file content hashes and only re-analyzes C/C++ files that have changed since their last analysis; the results of the other files are reused, even after restarting VS Code.
- The cache is invalidated for every file when a header, `compile_commands.json`, the `ctrace` binary or the analysis options change, since any of these can change the result of an unmodified source file.
- Run **Clear Analysis Cache** to force a full scan, or set `ctrace.workspace.incremental` to `false` to disable the cache.

### 7. CWE Links
When an analyzer maps a finding to a CWE, the diagnostic code in the Problems panel (e.g. `doubleFree · CWE-415`) links to its page on cwe.mitre.org, and the sidebar shows a clickable CWE badge. Diagnostics also name the analyzer that produced them and list the other analyzers that reported the same issue.

### 8. Ignoring Findings
Triage false positives without losing them:
- Use the **CoreTrace: Ignore this finding** quick fix (lightbulb) on a diagnostic, or the **Ignore** button on a finding in the sidebar. You can give a reason.
- Ignored findings are stored in `.coretrace-ignore.json` at the workspace root, so a team can commit it. A finding stays ignored when lines are added above it.
- **CoreTrace: Manage Ignored Findings** lists them and restores the ones you select. Editing or deleting the file also updates the results immediately.

### 9. Stack Tree
The **Stack Tree** tab shows how much stack your functions use, in a layout made for the narrow sidebar:
- **Call tree**: an expandable tree of who calls what, heaviest callees first. A bar behind each value shows its share of the highest peak, and the heaviest call path is highlighted in red. The flame button jumps straight to it.
- **Ranking**: every function sorted by peak stack.
- **Filter** by function or file name: matches stay in place in the tree with the calls leading to them.
- **Details**: selecting a function shows its local and peak stack, its callers and callees (click one to jump to it), and a link to the source.
- **Keyboard**: arrow keys navigate and open rows, `Enter` opens the source (double-click works too).
- Recursive calls end on a row marked `↻` instead of expanding forever.

---

## ⚙️ Requirements & Prerequisites

- **VS Code**: Version `^1.82.0` or later.
- **Operating Systems**:
  - **Linux / macOS**: Supported natively.
  - **Windows**: Requires **WSL** (Windows Subsystem for Linux, e.g. Ubuntu). If you do not have WSL installed, run `wsl --install` in PowerShell.
- **CoreTrace CLI**: The extension automatically downloads and updates the latest `ctrace` binaries from GitHub Releases upon first launch.
- **Analyzers (Optional but Recommended)**: To enable all static analysis engines (`cppcheck`, `flawfinder`, `ikos`, `tscancode`), run the built-in installer via the sidebar or command palette.

---

## 🛠️ Getting Started

1. Open any C or C++ project in VS Code.
2. Open the **CoreTrace Sidebar** by clicking the shield icon ($(shield)) in the Activity Bar.
3. Configure your analysis:
   - **Scope**: Choose **Scan File** (active file) or **Scan Workspace** (entire repository).
   - **Engines**: Toggle **Static** (Cppcheck, Flawfinder, Ikos, TscanCode) and **Dynamic** (Stack Analyzer) engines.
   - **Settings (⚙️)**: Optionally configure custom include paths (`-I`), compiler macros (`-D`), or specify a custom `compile_commands.json`.
4. Click **Run Analysis**. Findings will appear in the dashboard and directly as editor problem annotations.

---

## ⌨️ Available Commands

Access these commands from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Title | Description |
|---|---|---|
| `ctrace.runAnalysis` | **Run Analysis** | Runs analysis on the currently active C/C++ file. |
| `ctrace.runWorkspaceAnalysis` | **Run Workspace Analysis** | Analyzes all modified C/C++ files in the workspace. |
| `ctrace.installDependencies` | **CoreTrace: Install Analyzers & Dependencies** | Installs or repairs external static analyzers (`cppcheck`, `flawfinder`, `ikos`, `tscancode`). |
| `ctrace.clearAnalysisCache` | **Clear Analysis Cache** | Clears cached analysis results to force a full re-scan. |
| `ctrace.focusStackFunction` | **CoreTrace: View Function in Stack Visualizer** | Opens the Stack Visualizer on a function. |
| `ctrace.ignoreFinding` | **CoreTrace: Ignore Finding at Cursor** | Adds the finding under the cursor to `.coretrace-ignore.json`. |
| `ctrace.manageIgnoredFindings` | **CoreTrace: Manage Ignored Findings** | Lists ignored findings and restores the selected ones. |

---

## 🔧 Configuration

All settings live under `ctrace.*` and can be edited in the Settings UI (search for **CoreTrace**) or in `.vscode/settings.json`.

| Setting | Default | Description |
|---|---|---|
| `ctrace.workspace.incremental` | `true` | Reuse the results of unchanged files in workspace scans. |
| `ctrace.analysis.timeoutSeconds` | `60` | Maximum time to analyse one file before `ctrace` is stopped. Raise it for large files or when IKOS is enabled. |
| `ctrace.compileCommandsPath` | `""` | Path to `compile_commands.json`. Auto-detected when empty. |
| `ctrace.analysis.autoEntryPoints` | `false` | In single-file mode, pass every function of the file as an entry point. |
| `ctrace.analysis.stackLimit` | `""` | Stack size limit passed as `--stack-limit` (e.g. `8192`). |
| `ctrace.analysis.resourceCrossTu` | `"default"` | Inter-procedural resource analysis across translation units (`default`, `on`, `off`). |
| `ctrace.models.escapeModel` / `bufferModel` / `resourceModel` | `""` | Custom analysis models passed to `ctrace`. |
| `ctrace.performance.compdbFast` | `false` | Fast compilation-database mode of the stack analyzer. |
| `ctrace.performance.compileIrCacheDir` | `""` | Directory where the stack analyzer caches compiled IR. |
| `ctrace.cache.resourceSummaryDir` | `""` | Directory used to cache resource summaries between runs. |
| `ctrace.cache.memoryOnly` | `false` | Keep resource summaries in memory only. |

Example `.coretrace-ignore.json` (created by the **Ignore** actions):

```json
{
  "version": 1,
  "ignored": [
    {
      "fingerprint": "2e1cde0b6dadad83fea0",
      "ruleId": "doubleFree",
      "file": "src/double_free.c",
      "line": 10,
      "message": "Memory pointed to by 'ptr' is freed twice.",
      "reason": "false positive: ptr is reset by the macro",
      "addedAt": "2026-10-29T11:16:21.971Z"
    }
  ]
}
```

---

## 🧑‍💻 Development

```bash
npm install
```

```bash
npm run compile
```

```bash
npm test
```

The test suite runs inside a downloaded VS Code instance (`@vscode/test-cli`). Press `F5` in VS Code to start an Extension Development Host with the extension loaded.

---

## 📄 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.
