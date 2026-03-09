import * as cp from 'child_process';
import * as fs from 'fs';
import type { CancellationToken } from 'vscode';
import type { BuiltCommand } from './CommandBuilder';

export interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    /** True when the process was killed due to timeout or user cancellation. */
    killed?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
/** Maximum combined stdout+stderr size accepted from ctrace (10 MB). */
const MAX_OUTPUT_BYTES   = 10 * 1024 * 1024;

/**
 * Executes a built command and returns stdout/stderr.
 * - When `built.file` + `built.args` are set, uses `cp.execFile` (no shell,
 *   safest option — preferred for Linux / macOS).
 * - Falls back to `cp.exec` with a shell command string for WSL paths on
 *   Windows (args are already validated and shell-escaped by CommandBuilder).
 *
 * The process is killed automatically after `timeoutMs` milliseconds, or
 * immediately when the optional `token` is cancelled by the user.
 *
 * Never rejects — errors are captured in the RunResult.
 */
export function runCommand(
    built: BuiltCommand,
    cwd: string,
    token?: CancellationToken,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<RunResult> {
    return new Promise(resolve => {
        let child: cp.ChildProcess | undefined;
        let settled = false;

        const finish = (result: RunResult) => {
            if (settled) { return; }
            settled = true;
            cancelListener?.dispose();
            clearTimeout(timer);
            resolve(result);
        };

        // Set when a kill is requested (timeout or cancellation). If the child
        // process is spawned AFTER this flag goes true (e.g. during an async
        // chmod call) it must be killed immediately upon creation.
        let killRequested = false;

        const kill = (reason: string) => {
            killRequested = true;
            if (child && !child.killed) {
                // Use SIGKILL so the entire WSL sh -c "..." process tree is
                // terminated immediately. SIGTERM can leave child processes
                // (tscancode, ikos …) orphaned when the shell ignores it.
                child.kill('SIGKILL');
            }
            finish({ stdout: '', stderr: reason, exitCode: null, killed: true });
        };

        // Hard timeout guard
        const timer = setTimeout(() => kill(`Ctrace timed out after ${timeoutMs / 1000}s.`), timeoutMs);

        // VS Code CancellationToken support
        const cancelListener = token?.onCancellationRequested(() => kill('Analysis cancelled by user.'));

        // If already cancelled before we even spawned, bail immediately.
        if (token?.isCancellationRequested) {
            clearTimeout(timer);
            cancelListener?.dispose();
            resolve({ stdout: '', stderr: 'Analysis cancelled by user.', exitCode: null, killed: true });
            return;
        }

        const done = (err: cp.ExecException | cp.ExecFileException | null, stdout: string, stderr: string) => {
            // `code` is a number on normal exits but a signal name string on
            // signal-kills (e.g. "SIGKILL").  Only forward it as an exit code
            // when it is actually numeric to avoid NaN propagating downstream.
            const rawCode = (err as cp.ExecFileException)?.code;
            const exitCode = (typeof rawCode === 'number') ? rawCode : null;
            finish({
                stdout: stdout ?? '',
                stderr: stderr ?? '',
                exitCode,
            });
        };

        if (built.file && built.args) {
            // Make the binary executable first (Linux / macOS), then run it.
            // We use execFile so no shell is ever spawned — the args cannot
            // be interpreted as shell commands regardless of their content.
            fs.chmod(built.file, 0o755, (chmodErr) => {
                if (chmodErr) {
                    finish({ stdout: '', stderr: String(chmodErr), exitCode: 1 });
                    return;
                }
                if (settled) { return; } // cancelled during chmod
                child = cp.execFile(built.file!, built.args!, { cwd, maxBuffer: MAX_OUTPUT_BYTES }, done);
                // Guard: kill was requested while chmod was running (async gap).
                // `kill()` already set `killRequested` but couldn't reach `child`
                // since it was undefined at that point. Kill it now.
                if (killRequested && !child.killed) {
                    child.kill('SIGKILL');
                }
            });
        } else if (built.command) {
            child = cp.exec(built.command, { cwd, maxBuffer: MAX_OUTPUT_BYTES }, done);
        } else {
            finish({ stdout: '', stderr: 'No command to run.', exitCode: 1 });
        }
    });
}
