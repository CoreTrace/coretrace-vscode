import * as crypto from 'crypto';
import * as fs     from 'fs';
import * as path   from 'path';
import * as vscode from 'vscode';
import type { SarifRun } from '../types/sarif';

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
    /** Cached SARIF runs for unchanged files, keyed by fsPath */
    cachedSarifByFile: Map<string, SarifRun[]>;
}

// ─── File-hash cache ──────────────────────────────────────────────────────────

/**
 * Cached file metadata: hash + stat info.
 * The stat info (size, mtime) enables cheap change detection without reading/hashing.
 */
interface CachedFileMetadata {
    hash: string;
    size: number;
    mtime: number;
}

/**
 * In-memory cache: fsPath → { hash, size, mtime }.
 * Lives for the extension session; cleared on `clearCache()`.
 * Stat-based cache greatly reduces I/O and CPU cost on large workspaces by
 * skipping expensive hash computation for files whose size and mtime haven't changed.
 */
const _fileCache = new Map<string, CachedFileMetadata>();

// ─── SARIF result cache ────────────────────────────────────────────────────────

/**
 * Cached SARIF runs for individual files, keyed by `fsPath@hash`.
 * Allows us to preserve analysis results for unchanged files when using file-by-file mode.
 * When a file is skipped (unchanged), its cached SARIF is merged into the combined result.
 */
const _sarifCache = new Map<string, SarifRun[]>();

/**
 * Store SARIF runs for a file (keyed by its current hash).
 * Called after successfully analyzing a file to cache its results for future runs.
 */
export function cacheSarifForFile(fsPath: string, fileHash: string, runs: SarifRun[]): void {
    const key = `${fsPath}@${fileHash}`;
    _sarifCache.set(key, runs);
}

/**
 * Retrieve cached SARIF runs for a file by its fsPath and hash.
 * Returns undefined if no cached results exist for this exact file version.
 */
export function getCachedSarif(fsPath: string, fileHash: string): SarifRun[] | undefined {
    const key = `${fsPath}@${fileHash}`;
    return _sarifCache.get(key);
}

export function clearCache(): void {
    _fileCache.clear();
    _sarifCache.clear();
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
        return { compileCommandsPath: null, files: [], changedFiles: [], cachedSarifByFile: new Map() };
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
    const cachedSarifByFile = new Map<string, SarifRun[]>();

    for (const uri of uris) {
        const fsPath = uri.fsPath;
        let hash: string;
        let metadata: CachedFileMetadata;
        
        try {
            // Cheap change detection: check file size and mtime first.
            // Skip expensive hash computation if stats haven't changed.
            const stat = await fs.promises.stat(fsPath);
            const currentSize = stat.size;
            const currentMtime = stat.mtimeMs;
            const cached = _fileCache.get(fsPath);

            if (cached && cached.size === currentSize && cached.mtime === currentMtime) {
                // File stat hasn't changed — reuse cached hash without re-reading.
                hash = cached.hash;
            } else {
                // File is new or modified — read and hash.
                const buf = await fs.promises.readFile(fsPath);
                hash = crypto.createHash('sha1').update(buf).digest('hex');
            }

            metadata = { hash, size: currentSize, mtime: currentMtime };
        } catch {
            // Unreadable file (permission error, race with deletion, …) — skip.
            continue;
        }

        const entry: WorkspaceFile = { fsPath, hash };
        files.push(entry);

        const cached = _fileCache.get(fsPath);
        if (!cached || cached.hash !== hash) {
            changedFiles.push(entry);
        } else {
            // File is unchanged — try to retrieve its cached SARIF results
            const cachedSarif = getCachedSarif(fsPath, hash);
            if (cachedSarif) {
                cachedSarifByFile.set(fsPath, cachedSarif);
            }
        }
        _fileCache.set(fsPath, metadata);
    }

    // Remove stale cache entries for files that no longer exist
    const currentPaths = new Set(files.map(f => f.fsPath));
    const fileKeysToDelete: string[] = [];
    for (const fsPath of _fileCache.keys()) {
        if (!currentPaths.has(fsPath)) {
            fileKeysToDelete.push(fsPath);
        }
    }
    for (const fsPath of fileKeysToDelete) {
        _fileCache.delete(fsPath);
    }

    // Also clean up SARIF cache entries for files that no longer exist
    // SARIF cache keys are in format "fsPath@hash"
    const sarifKeysToDelete: string[] = [];
    for (const cacheKey of _sarifCache.keys()) {
        const fsPath = cacheKey.split('@')[0];
        if (!currentPaths.has(fsPath)) {
            sarifKeysToDelete.push(cacheKey);
        }
    }
    for (const cacheKey of sarifKeysToDelete) {
        _sarifCache.delete(cacheKey);
    }

    return { compileCommandsPath, files, changedFiles, cachedSarifByFile };
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
