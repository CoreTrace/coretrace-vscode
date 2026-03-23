import * as crypto from 'crypto';
import * as fs     from 'fs';
import * as path   from 'path';
import * as vscode from 'vscode';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface WorkspaceFile {
    /** Absolute filesystem path */
    fsPath: string;
    /** Hash of file contents at the time it was last seen */
    hash: string;
}

export interface ScanResult {
    /** compile_commands.json path if found at workspace root, else null */
    compileCommandsPath: string | null;
    /** All C/C++ source files found in the workspace */
    files: WorkspaceFile[];
    /** Subset of files whose content changed since the last scan */
    changedFiles: WorkspaceFile[];
}

// ─── File-hash cache ──────────────────────────────────────────────────────────

/**
 * In-memory cache: fsPath → content-hash.
 * Lives for the extension session; cleared on `clearCache()`.
 */
const _hashCache = new Map<string, string>();

export function clearCache(): void {
    _hashCache.clear();
}

// ─── Scanner ──────────────────────────────────────────────────────────────────

const C_CPP_GLOB = '**/*.{c,cpp,cc,cxx,c++,C}';
/** Directories that should never be scanned (build artifacts, vendored code…) */
const EXCLUDE_GLOB = '{**/node_modules/**,**/build/**,**/out/**,**/dist/**,**/.git/**,**/CMakeFiles/**,**/cmake-build-*/**}';

/**
 * Scans all workspace folders for C/C++ source files and returns:
 *  - the path of `compile_commands.json` if present at any workspace root
 *  - the full list of discovered files with their current content hashes
 *  - only the files that are new or whose content changed since the last call
 *
 * Skips files it cannot read rather than throwing, so a single unreadable
 * file does not abort the entire scan.
 */
export async function scanWorkspace(): Promise<ScanResult> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        return { compileCommandsPath: null, files: [], changedFiles: [] };
    }

    // 1 — Look for compile_commands.json at every workspace root or build directory
    let compileCommandsPath: string | null = null;
    for (const folder of folders) {
        const rootCandidate = path.join(folder.uri.fsPath, 'compile_commands.json');
        const buildCandidate = path.join(folder.uri.fsPath, 'build', 'compile_commands.json');
        
        // Also check CMake Tools build directory configuration if present
        let cmakeBuildCandidate: string | null = null;
        const config = vscode.workspace.getConfiguration('cmake', folder.uri);
        let buildDir = config.get<string>('buildDirectory');
        if (buildDir) {
            // Resolve standard variable substitution for ${workspaceFolder}
            buildDir = buildDir.replace(/\${workspaceFolder}/g, folder.uri.fsPath);
            cmakeBuildCandidate = path.resolve(folder.uri.fsPath, buildDir, 'compile_commands.json');
        }

        if (await fileExists(rootCandidate)) {
            compileCommandsPath = rootCandidate;
            break;
        } else if (cmakeBuildCandidate && await fileExists(cmakeBuildCandidate)) {
            compileCommandsPath = cmakeBuildCandidate;
            break;
        } else if (await fileExists(buildCandidate)) {
            compileCommandsPath = buildCandidate;
            break;
        }
    }

    // 2 — Find all C/C++ source files
    const uris = await vscode.workspace.findFiles(C_CPP_GLOB, EXCLUDE_GLOB);
    const files: WorkspaceFile[]   = [];
    const changedFiles: WorkspaceFile[] = [];

    for (const uri of uris) {
        const fsPath = uri.fsPath;
        let hash: string;
        try {
            const buf = await fs.promises.readFile(fsPath);
            hash = crypto.createHash('sha1').update(buf).digest('hex');
        } catch {
            // Unreadable file (permission error, race with deletion, …) — skip.
            continue;
        }

        const entry: WorkspaceFile = { fsPath, hash };
        files.push(entry);

        const cached = _hashCache.get(fsPath);
        if (cached !== hash) {
            changedFiles.push(entry);
            _hashCache.set(fsPath, hash);
        }
    }

    // Remove stale cache entries for files that no longer exist
    const currentPaths = new Set(files.map(f => f.fsPath));
    for (const cached of _hashCache.keys()) {
        if (!currentPaths.has(cached)) {
            _hashCache.delete(cached);
        }
    }

    return { compileCommandsPath, files, changedFiles };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
    try {
        await fs.promises.access(p, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}
