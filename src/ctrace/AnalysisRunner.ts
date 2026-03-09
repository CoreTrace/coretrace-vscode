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

        const kill = (reason: string) => {
            if (child && !child.killed) {
                child.kill();
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
            resolve({ stdout: '', stderr: 'Analysis cancelled by user.', exitCode: null, killed: true });
            return;
        }

        const done = (err: cp.ExecException | cp.ExecFileException | null, stdout: string, stderr: string) => {
            finish({
                stdout: stdout ?? '',
                stderr: stderr ?? '',
                exitCode: (err as cp.ExecFileException)?.code != null
                    ? Number((err as cp.ExecFileException).code)
                    : null,
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
                child = cp.execFile(built.file!, built.args!, { cwd }, done);
            });
        } else if (built.command) {
            child = cp.exec(built.command, { cwd }, done);
        } else {
            finish({ stdout: '', stderr: 'No command to run.', exitCode: 1 });
        }
    });
}
