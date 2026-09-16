import * as cp from 'child_process';
import type { CancellationToken } from 'vscode';

export interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    /** True when the process was killed due to timeout or user cancellation. */
    killed?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000; // 60 seconds per file

/**
 * Executes a shell command and returns stdout/stderr.
 * cwd should be the extension folder so ctrace can find its bundled tools.
 * Never rejects — errors are captured in the RunResult.
 */
export function runCommand(
    command: string,
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
                try {
                    child.kill();
                } catch {
                    // Ignore kill errors if already terminated
                }
            }
            finish({ stdout: '', stderr: reason, exitCode: null, killed: true });
        };

        // Timeout guard to prevent infinite hanging
        const timer = setTimeout(() => {
            kill('Ctrace timed out after ' + (timeoutMs / 1000) + 's.');
        }, timeoutMs);

        // VS Code cancellation token listener
        const cancelListener = token?.onCancellationRequested(() => {
            kill('Analysis cancelled by user.');
        });

        if (token?.isCancellationRequested) {
            finish({ stdout: '', stderr: 'Analysis cancelled by user.', exitCode: null, killed: true });
            return;
        }

        try {
            child = cp.exec(
                command,
                { cwd, maxBuffer: 10 * 1024 * 1024 },
                (err, stdout, stderr) => {
                    finish({
                        stdout: stdout ?? '',
                        stderr: stderr ?? '',
                        exitCode: err?.code ?? null,
                    });
                }
            );
        } catch (e) {
            clearTimeout(timer);
            cancelListener?.dispose();
            resolve({ stdout: '', stderr: 'Failed to execute command: ' + String(e), exitCode: 1 });
        }
    });
}
