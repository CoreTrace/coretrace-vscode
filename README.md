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

### 6. Smart Caching
Save time on repetitive scans. CoreTrace computes file content hashes and only re-analyzes C/C++ files that have changed since your last run, speeding up iterative development.

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
| `ctrace.clearAnalysisCache` | **Clear Analysis Cache** | Clears cached analysis hashes to force a clean re-scan. |

---

## 📄 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.
