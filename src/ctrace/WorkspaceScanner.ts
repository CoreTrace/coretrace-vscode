import * as crypto from 'crypto';
import * as fs     from 'fs';
import * as path   from 'path';
import * as vscode from 'vscode';
import type { SarifLog } from '../types/sarif';
import type { StackReport } from '../types/stack';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface WorkspaceFile {
    /** Absolute filesystem path */
    fsPath: string;
    /** Hash of file contents at the time it was last seen */
    hash: string;
}

/** Everything a workspace scan publishes for one translation unit. */
export interface CachedFileAnalysis {
    sarif: SarifLog;
    stack: StackReport | null;
}

export interface PartitionResult {
    /** Files that are new, modified, or were analysed with other settings. */
    changed: WorkspaceFile[];
    /** Reusable results for the other files, keyed by fsPath. */
    cached: Map<string, CachedFileAnalysis>;
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

/** In-memory cache: fsPath → { hash, size, mtime }. */
const _fileCache = new Map<string, CachedFileMetadata>();

// ─── Analysis result cache ────────────────────────────────────────────────────

interface AnalysisCacheEntry {
    hash: string;
    contextKey: string;
    analysis: CachedFileAnalysis;
}

/** fsPath → last successful analysis. Persisted to `CACHE_FILE_NAME` in the workspace storage. */
const _analysisCache = new Map<string, AnalysisCacheEntry>();
const CACHE_FILE_NAME = 'workspace-scan-cache.v1.json';
let _cacheFile: string | undefined;

/**
 * Loads the analysis cache persisted by a previous session. Call once on
 * activation; without a storage directory the cache stays in memory only.
 */
export async function initAnalysisCache(storageDir: string | undefined): Promise<void> {
    _cacheFile = storageDir ? path.join(storageDir, CACHE_FILE_NAME) : undefined;
    if (!_cacheFile) { return; }
    try {
        const entries = JSON.parse(await fs.promises.readFile(_cacheFile, 'utf8'));
        if (!Array.isArray(entries)) { return; }
        for (const [fsPath, entry] of entries) {
            if (typeof fsPath === 'string' && typeof entry?.hash === 'string' &&
                typeof entry?.contextKey === 'string' && Array.isArray(entry?.analysis?.sarif?.runs)) {
                _analysisCache.set(fsPath, entry);
            }
        }
    } catch {
        // No cache yet, or an unreadable one: start from scratch.
    }
}

/** Writes the analysis cache to disk, dropping entries for files that no longer exist. */
export async function persistAnalysisCache(): Promise<void> {
    if (!_cacheFile) { return; }
    for (const fsPath of [..._analysisCache.keys()]) {
        if (!await fileExists(fsPath)) { _analysisCache.delete(fsPath); }
    }
    try {
        await fs.promises.mkdir(path.dirname(_cacheFile), { recursive: true });
        await fs.promises.writeFile(_cacheFile, JSON.stringify([..._analysisCache]), 'utf8');
    } catch (e) {
        console.warn('[ctrace] Could not persist the workspace scan cache:', e);
    }
}

export function cacheFileAnalysis(file: WorkspaceFile, contextKey: string, analysis: CachedFileAnalysis): void {
    _analysisCache.set(file.fsPath, { hash: file.hash, contextKey, analysis });
}

export async function clearCache(): Promise<void> {
    _fileCache.clear();
    _analysisCache.clear();
    if (_cacheFile) {
        await fs.promises.unlink(_cacheFile).catch(() => { /* already gone */ });
    }
}

/**
 * Splits `files` into the ones that must be analysed again and the ones whose
 * cached result is still valid: same content hash and same `contextKey`.
 * Unreadable files are reported as changed so the analysis surfaces the error.
 */
export async function partitionFiles(files: string[], contextKey: string): Promise<PartitionResult> {
    const changed: WorkspaceFile[] = [];
    const cached = new Map<string, CachedFileAnalysis>();
    for (const fsPath of files) {
        const hash = await fileContentHash(fsPath);
        const entry = _analysisCache.get(fsPath);
        if (hash && entry && entry.hash === hash && entry.contextKey === contextKey) {
            cached.set(fsPath, entry.analysis);
        } else {
            changed.push({ fsPath, hash: hash ?? '' });
        }
    }
    return { changed, cached };
}

/**
 * Summarises everything besides a file's own content that can change its
 * analysis result: the given values (ctrace arguments, generated config…) and
 * the stat of the given files (binary, compile_commands.json) and of every
 * header in the workspace. Header edits therefore invalidate the whole cache,
 * since an unchanged .c file may include a changed header.
 */
export async function analysisContextKey(values: unknown[], dependencyFiles: (string | undefined)[]): Promise<string> {
    const hash = crypto.createHash('sha1');
    hash.update(JSON.stringify(values));
    const headers = await vscode.workspace.findFiles(HEADER_GLOB, EXCLUDE_GLOB);
    const statFiles = [...dependencyFiles.filter((f): f is string => Boolean(f)), ...headers.map(u => u.fsPath).sort()];
    for (const file of statFiles) {
        try {
            const stat = await fs.promises.stat(file);
            hash.update(`\0${file}\0${stat.size}\0${stat.mtimeMs}`);
        } catch {
            hash.update(`\0${file}\0missing`);
        }
    }
    return hash.digest('hex');
}

const HEADER_GLOB = '**/*.{h,hh,hpp,hxx,h++,inl,inc,ipp,tpp}';
/** Directories that should never be scanned (build artifacts, vendored code…) */
const EXCLUDE_GLOB = '{**/node_modules/**,**/build/**,**/out/**,**/dist/**,**/.git/**,**/CMakeFiles/**,**/cmake-build-*/**}';

/** sha1 of the file content, reusing the previous hash when size and mtime are unchanged. */
async function fileContentHash(fsPath: string): Promise<string | null> {
    try {
        const stat = await fs.promises.stat(fsPath);
        const cached = _fileCache.get(fsPath);
        if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) {
            return cached.hash;
        }
        const buf = await fs.promises.readFile(fsPath);
        const hash = crypto.createHash('sha1').update(buf).digest('hex');
        _fileCache.set(fsPath, { hash, size: stat.size, mtime: stat.mtimeMs });
        return hash;
    } catch {
        return null;
    }
}

// ─── compile_commands.json ────────────────────────────────────────────────────

/**
 * Looks for compile_commands.json at every workspace root, in the CMake Tools
 * build directory, or in `build/`. Cheap: does not touch the source files.
 */
export async function findCompileCommandsPath(): Promise<string | null> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
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
            return rootCandidate;
        } else if (cmakeBuildCandidate && await fileExists(cmakeBuildCandidate)) {
            return cmakeBuildCandidate;
        } else if (await fileExists(buildCandidate)) {
            return buildCandidate;
        }
    }
    return null;
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
