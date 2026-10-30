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
}

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
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    private readonly _watcher: vscode.FileSystemWatcher | undefined;

    /** Fires when the set of ignored fingerprints changes (from the UI or an edit of the file). */
    public readonly onDidChange = this._onDidChange.event;

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

    public async add(entry: Omit<IgnoredFinding, 'addedAt'>): Promise<void> {
        this.reload();
        if (this._entries.has(entry.fingerprint)) { return; }
        this._entries.set(entry.fingerprint, { ...entry, addedAt: new Date().toISOString() });
        await this._write();
    }

    public async remove(fingerprints: string[]): Promise<void> {
        this.reload();
        let changed = false;
        for (const fingerprint of fingerprints) {
            changed = this._entries.delete(fingerprint) || changed;
        }
        if (changed) { await this._write(); }
    }

    /** Re-reads the file. Returns true when the ignored set changed. */
    public reload(): boolean {
        const file = this.filePath;
        let entries: IgnoredFinding[] = [];
        if (file) {
            try {
                const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<IgnoreFile>;
                entries = Array.isArray(parsed.ignored)
                    ? parsed.ignored.filter(e => typeof e?.fingerprint === 'string' && e.fingerprint.length > 0)
                    : [];
            } catch {
                // Missing or invalid file: nothing is ignored.
            }
        }
        const serialized = JSON.stringify(entries.map(e => e.fingerprint).sort());
        if (serialized === this._serialized) { return false; }
        this._serialized = serialized;
        this._entries = new Map(entries.map(e => [e.fingerprint, e]));
        return true;
    }

    public dispose(): void {
        this._watcher?.dispose();
        this._onDidChange.dispose();
    }

    private async _write(): Promise<void> {
        const file = this.filePath;
        if (!file) {
            throw new Error('Open a workspace folder to ignore findings.');
        }
        const content: IgnoreFile = { version: 1, ignored: this.list() };
        await fs.promises.writeFile(file, JSON.stringify(content, null, 2) + '\n', 'utf8');
        this._serialized = JSON.stringify(this.list().map(e => e.fingerprint).sort());
        this._onDidChange.fire();
    }
}
