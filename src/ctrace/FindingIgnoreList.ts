import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Lives at the workspace root so a team can commit its triaged false positives. */
export const IGNORE_FILE_NAME = '.coretrace-ignore.json';

export interface IgnoredFinding {
    fingerprint: string;
    ruleId?: string;
    /** Workspace-relative POSIX path. */
    file?: string;
    line?: number;
    message?: string;
    reason?: string;
    addedAt: string;
}

interface IgnoreFile {
    version: 1;
    ignored: IgnoredFinding[];
    [key: string]: unknown;
}

/** The ignore file exists but cannot be used: it is left untouched. */
export class IgnoreFileError extends Error {}

/**
 * Identifies a finding independently of its line number, so an ignored finding
 * stays ignored when code above it is edited. The trimmed source line is part
 * of the key to tell apart identical messages reported on different lines.
 */
export function computeFingerprint(
    ruleId: string | undefined,
    relativeFile: string,
    message: string | undefined,
    lineText: string
): string {
    const normalizedLine = lineText.replace(/\s+/g, ' ').trim();
    return crypto.createHash('sha1')
        .update(`${ruleId ?? ''}\0${relativeFile}\0${(message ?? '').trim()}\0${normalizedLine}`)
        .digest('hex')
        .slice(0, 20);
}

/** Path used in fingerprints and in the ignore file: relative to the workspace when inside it. */
export function relativeFindingPath(filePath: string, workspaceRoot: string | undefined): string {
    if (workspaceRoot) {
        const rel = path.relative(workspaceRoot, filePath);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
            return rel.split(path.sep).join('/');
        }
    }
    return filePath.replace(/\\/g, '/');
}

export class FindingIgnoreList implements vscode.Disposable {
    private _entries = new Map<string, IgnoredFinding>();
    private _serialized = '';
    // Top-level keys of the file other than "ignored", kept on rewrite.
    private _extra: Record<string, unknown> = {};
    private _problem: string | undefined;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    private readonly _onDidFailToRead = new vscode.EventEmitter<string>();
    private readonly _watcher: vscode.FileSystemWatcher | undefined;

    /** Fires when the set of ignored fingerprints changes (from the UI or an edit of the file). */
    public readonly onDidChange = this._onDidChange.event;

    /** Fires with a message when the file exists but cannot be read or parsed. */
    public readonly onDidFailToRead = this._onDidFailToRead.event;

    constructor(private readonly _workspaceRoot: string | undefined) {
        this.reload();
        if (_workspaceRoot) {
            this._watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(_workspaceRoot, IGNORE_FILE_NAME)
            );
            const onDisk = () => { if (this.reload()) { this._onDidChange.fire(); } };
            this._watcher.onDidCreate(onDisk);
            this._watcher.onDidChange(onDisk);
            this._watcher.onDidDelete(onDisk);
        }
    }

    public get filePath(): string | undefined {
        return this._workspaceRoot ? path.join(this._workspaceRoot, IGNORE_FILE_NAME) : undefined;
    }

    public has(fingerprint: string | undefined): boolean {
        return fingerprint !== undefined && this._entries.has(fingerprint);
    }

    public list(): IgnoredFinding[] {
        return [...this._entries.values()];
    }

    /** Why the file on disk cannot be used, or undefined when it can. */
    public get problem(): string | undefined {
        return this._problem;
    }

    /** @throws IgnoreFileError when the file exists but is unreadable or invalid. */
    public async add(entry: Omit<IgnoredFinding, 'addedAt'>): Promise<void> {
        this._reloadForWrite();
        if (this._entries.has(entry.fingerprint)) { return; }
        this._entries.set(entry.fingerprint, { ...entry, addedAt: new Date().toISOString() });
        await this._write();
    }

    /** @throws IgnoreFileError when the file exists but is unreadable or invalid. */
    public async remove(fingerprints: string[]): Promise<void> {
        this._reloadForWrite();
        let changed = false;
        for (const fingerprint of fingerprints) {
            changed = this._entries.delete(fingerprint) || changed;
        }
        if (changed) { await this._write(); }
    }

    /**
     * Re-reads the file. Returns true when the ignored set changed.
     *
     * Edits of an entry's reason or other fields are always taken, even when
     * the set of fingerprints is unchanged. A missing file ignores nothing. An
     * unreadable or invalid one keeps the last entries read, so that a typo
     * does not bring back every ignored finding, and is reported.
     */
    public reload(): boolean {
        const file = this.filePath;
        let entries: IgnoredFinding[] = [];
        let extra: Record<string, unknown> = {};
        let problem: string | undefined;
        if (file) {
            try {
                const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray((parsed as IgnoreFile).ignored)) {
                    problem = `${IGNORE_FILE_NAME} must be an object with an "ignored" list.`;
                } else {
                    const { ignored, ...rest } = parsed as IgnoreFile;
                    entries = ignored.filter(e => typeof e?.fingerprint === 'string' && e.fingerprint.length > 0);
                    extra = rest;
                }
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                    problem = `${IGNORE_FILE_NAME} cannot be read: ${(e as Error).message}`;
                }
            }
        }

        const previousProblem = this._problem;
        this._problem = problem;
        if (problem) {
            if (problem !== previousProblem) { this._onDidFailToRead.fire(problem); }
            return false;
        }

        this._entries = new Map(entries.map(e => [e.fingerprint, e]));
        this._extra = extra;
        const serialized = JSON.stringify(entries.map(e => e.fingerprint).sort());
        if (serialized === this._serialized) { return false; }
        this._serialized = serialized;
        return true;
    }

    /** Reads the latest file before changing it, and refuses to overwrite one it cannot parse. */
    private _reloadForWrite(): void {
        this.reload();
        if (this._problem) {
            throw new IgnoreFileError(`${this._problem} Fix or delete the file: it was left unchanged.`);
        }
    }

    public dispose(): void {
        this._watcher?.dispose();
        this._onDidChange.dispose();
        this._onDidFailToRead.dispose();
    }

    private async _write(): Promise<void> {
        const file = this.filePath;
        if (!file) {
            throw new Error('Open a workspace folder to ignore findings.');
        }
        const content: IgnoreFile = { ...this._extra, version: 1, ignored: this.list() };
        // Written next to the file then renamed over it: an interrupted write
        // never leaves a truncated ignore file behind.
        const staged = `${file}.${process.pid}.tmp`;
        await fs.promises.writeFile(staged, JSON.stringify(content, null, 2) + '\n', 'utf8');
        try {
            await fs.promises.rename(staged, file);
        } catch (e) {
            await fs.promises.unlink(staged).catch(() => { /* already gone */ });
            throw e;
        }
        this._serialized = JSON.stringify(this.list().map(e => e.fingerprint).sort());
        this._onDidChange.fire();
    }
}
