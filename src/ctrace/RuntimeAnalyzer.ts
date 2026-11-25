import * as fs from 'fs';
import * as path from 'path';
import { execShellCommand } from './DependencyInstaller';

export const RUNTIME_ANALYZER = 'coretrace-runtime-analyzer';

/** Where a release puts the runtime analyzer, next to ctrace. */
export function bundledRuntimeAnalyzer(ctracePath: string): string {
    return path.join(path.dirname(ctracePath), '..', 'libexec', 'coretrace', RUNTIME_ANALYZER, 'bin', 'runtime-analyzer');
}

type Shell = (command: string) => Promise<{ code: number }>;

/**
 * Whether ctrace can run dynamic analysis: it uses the runtime analyzer of
 * its release, else `coretrace-runtime-analyzer` on PATH (inside WSL on
 * Windows). macOS releases do not include it.
 */
export async function isRuntimeAnalyzerAvailable(
    ctracePath: string,
    shell: Shell = command => execShellCommand(command)
): Promise<boolean> {
    if (fs.existsSync(bundledRuntimeAnalyzer(ctracePath))) { return true; }
    try {
        return (await shell(`command -v ${RUNTIME_ANALYZER} >/dev/null 2>&1`)).code === 0;
    } catch {
        return false;
    }
}

/** Whether these sidebar settings ask for dynamic analysis. */
export function requestsDynamicAnalysis(uiState: { dynamicEnabled?: boolean; dynamicTools?: string[] }): boolean {
    return uiState.dynamicEnabled !== false
        && (uiState.dynamicTools === undefined || uiState.dynamicTools.includes(RUNTIME_ANALYZER));
}
