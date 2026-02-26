import * as cp from 'child_process';

export interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

/**
 * Executes a shell command and returns stdout/stderr.
 * cwd should be the extension folder so ctrace can find its bundled tools.
 * Never rejects — errors are captured in the RunResult.
 */
export function runCommand(command: string, cwd: string): Promise<RunResult> {
    return new Promise(resolve => {
        cp.exec(command, { cwd }, (err, stdout, stderr) => {
            resolve({
                stdout: stdout ?? '',
                stderr: stderr ?? '',
                exitCode: err?.code ?? null,
            });
        });
    });
}
