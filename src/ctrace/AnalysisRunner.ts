import * as cp from 'child_process';
import type { CancellationToken } from 'vscode';

export interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    /** True when the process was killed due to timeout or user cancellation. */
    killed?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 60_000; // 60 seconds per file
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Executes a shell command and returns stdout/stderr.
 * cwd should be the extension folder so ctrace can find its bundled tools.
 * Never rejects — errors are captured in the RunResult.
 *
 * The shell runs in its own process group so that a timeout or cancellation
 * kills ctrace and the analyzers it spawned, not just the wrapping shell.
 */
export function runCommand(
    command: string,
    cwd: string,
    token?: CancellationToken,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<RunResult> {
    return new Promise(resolve => {
        if (token?.isCancellationRequested) {
            resolve({ stdout: '', stderr: 'Analysis cancelled by user.', exitCode: null, killed: true });
            return;
        }

        let child: cp.ChildProcess;
        let settled = false;
        let stdout = '';
        let stderr = '';

        const finish = (result: RunResult) => {
            if (settled) { return; }
            settled = true;
            cancelListener?.dispose();
            clearTimeout(timer);
            resolve(result);
        };

        const kill = (reason: string) => {
            killProcessTree(child);
            finish({ stdout, stderr: stderr ? `${stderr}\n${reason}` : reason, exitCode: null, killed: true });
        };

        try {
            child = process.platform === 'win32'
                ? cp.spawn(command, { cwd, shell: true, windowsHide: true })
                : cp.spawn('/bin/sh', ['-c', command], { cwd, detached: true });
        } catch (e) {
            resolve({ stdout: '', stderr: 'Failed to execute command: ' + String(e), exitCode: 1 });
            return;
        }

        // Timeout guard to prevent infinite hanging
        const timer = setTimeout(() => {
            kill('Ctrace timed out after ' + (timeoutMs / 1000) + 's.');
        }, timeoutMs);

        // VS Code cancellation token listener
        const cancelListener = token?.onCancellationRequested(() => {
            kill('Analysis cancelled by user.');
        });

        child.stdout?.on('data', (chunk: Buffer) => {
            if (stdout.length < MAX_BUFFER) { stdout += chunk.toString(); }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            if (stderr.length < MAX_BUFFER) { stderr += chunk.toString(); }
        });
        child.on('error', (err) => {
            finish({ stdout, stderr: stderr + 'Failed to execute command: ' + err.message, exitCode: 1 });
        });
        child.on('close', (code) => {
            finish({ stdout, stderr, exitCode: code });
        });
    });
}

function killProcessTree(child: cp.ChildProcess): void {
    if (child.pid === undefined || child.exitCode !== null) { return; }
    try {
        if (process.platform === 'win32') {
            cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
            // Negative pid targets the whole process group created by `detached`.
            process.kill(-child.pid, 'SIGKILL');
        }
    } catch {
        // Ignore kill errors if already terminated
    }
}
