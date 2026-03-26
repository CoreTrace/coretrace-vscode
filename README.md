# CoreTrace VS Code Extension

CoreTrace VS Code is a powerful integration of the `ctrace` analyzer framework directly into your Visual Studio Code environment. It provides seamless static and dynamic analysis for C and C++ projects, surfacing complex diagnostics exactly where you need them.

## 🚀 Features

### 1. Unified Diagnostics Panel
We automatically ingest, parse, and unify results from multiple analysis tools run by `ctrace` into a single VS Code interface:
- **Standard SARIF formats** from static analyzers (CppCheck, Flawfinder, TSCancode, Ikos, etc.).
- **Stack Analyzer alerts** detailing infinite recursions, uninitialized variables, and large local scopes.
- **Clang/GCC Compiler warnings** intercepted locally and upgraded into standard VS Code diagnostics.

Clicking on any diagnostic in the custom Sidebar or native 'Problems' view will automatically jump you to the correct file and line, gracefully handling absolute `file://` URIs and relative workspace paths.

### 2. Workspace-wide Analysis
Toggle between analyzing a single active file or scanning your **entire workspace**. The extension automatically orchestrates the analysis without you needing to do it manually.

### 3. Intelligent `compile_commands.json` Resolution
To provide precise C/C++ analysis across complex codebases (with specific `#include` paths or macros), the extension automatically locates your `compile_commands.json` database.

It looks for the file in the following specific order:
1. The root of your workspace (`/compile_commands.json`).
2. Directly via your **CMake Tools** configuration (honoring custom `cmake.buildDirectory` settings and VS Code variable substitutions).
3. The default build directory (`/build/compile_commands.json`).

> **💡 Tip for CMake users:** 
> By default, the Microsoft CMake Tools extension automatically configures this database. If you build manually via terminal, ensure your CMake configuration generates the compilation database by adding this to your `CMakeLists.txt`:
> ```cmake
> set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
> ```
> Or pass the flag during generation: `cmake -B build -S . -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`

### 4. Smart Caching
No need to wait for a full re-scan. CoreTrace caches file hashes across the entire workspace. During subsequent runs, it only re-analyzes C/C++ files whose contents have changed since your last run, massively speeding up your workflow.

## 🛠️ Usage

1. Open a C/C++ project in VS Code.
2. Click on the **CoreTrace Sidebar** (via the icon in the Activity Bar).
3. Choose your target **Scope**:
   - **File**: Analyze the currently active editor file.
   - **Workspace**: Analyze every modified source file in the project.
4. Click **Run Analysis** to execute `ctrace`. All findings will appear instantly in the panel and directly in your code editor as error/warning highlights.

## ⚙️ Requirements
- The extension automatically uses the `ctrace` / `coretrace` CLI binaries bundled alongside the extension installation. You do not need to install them manually in your PATH.
- *Recommended:* For accurate analysis in complex codebases, it is advised to generate a `compile_commands.json` (e.g. via `cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`) in your workspace root or `build` directory.
