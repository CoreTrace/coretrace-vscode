import * as fs from 'fs';
import { shellEscapeArg } from './CommandBuilder';
import { execShellCommand } from './DependencyInstaller';

export const RUNTIME_ANALYZER = 'coretrace-runtime-analyzer';

/** Where a release (`<prefix>/bin/ctrace`) puts the runtime analyzer, relative to ctrace's directory. */
export const BUNDLED_RUNTIME_ANALYZER = `../libexec/coretrace/${RUNTIME_ANALYZER}/bin/runtime-analyzer`;

/** `tools.coretrace-runtime-analyzer.path` in a ctrace configuration file, if set. */
export function configuredRuntimeAnalyzer(configFile: string | undefined): string | undefined {
    if (!configFile) { return undefined; }
    try {
        const configured = JSON.parse(fs.readFileSync(configFile, 'utf8'))?.tools?.[RUNTIME_ANALYZER]?.path;
        return typeof configured === 'string' && configured.trim() ? configured.trim() : undefined;
    } catch {
        return undefined;
    }
}

/**
 * A POSIX shell script that exits 0 when ctrace at `ctracePath` would find an
 * executable runtime analyzer, by ctrace's own rules: the configured path
 * alone when set; else the copy of its release or build tree, then PATH.
 */
export function runtimeAnalyzerProbe(ctracePath: string, configured?: string): string {
    const executable = (file: string) => `[ -f ${file} ] && [ -x ${file} ]`;
    const onPath = (name: string) => `p=$(command -v ${shellEscapeArg(name)}) && ${executable('"$p"')}`;
    if (configured) {
        return configured.includes('/') ? executable(shellEscapeArg(configured)) : onPath(configured);
    }
    const bin = shellEscapeArg(ctracePath);
    const bundled = [BUNDLED_RUNTIME_ANALYZER, BUNDLED_RUNTIME_ANALYZER.replace('../', '')]
        .map(relative => `"$d"/${shellEscapeArg(relative)}`).join(' ');
    return `b=$(readlink -f ${bin} 2>/dev/null) || b=${bin}; d=\${b%/*}; `
        + `for c in ${bundled}; do ${executable('"$c"')} && exit 0; done; ${onPath(RUNTIME_ANALYZER)}`;
}

type Shell = (command: string, distro: string | null) => Promise<{ code: number }>;

/**
 * Whether ctrace can run dynamic analysis where it runs (`distro` inside WSL
 * on Windows, null for the default one). macOS releases do not include it.
 */
export async function isRuntimeAnalyzerAvailable(
    target: { binary: string; distro: string | null },
    configured?: string,
    shell: Shell = (command, distro) => execShellCommand(command, { distro })
): Promise<boolean> {
    try {
        return (await shell(runtimeAnalyzerProbe(target.binary, configured), target.distro)).code === 0;
    } catch {
        return false;
    }
}

/** Whether these sidebar settings ask for dynamic analysis. */
export function requestsDynamicAnalysis(uiState: { dynamicEnabled?: boolean; dynamicTools?: unknown }): boolean {
    // Like buildCtraceArgs: anything but an array means the default selection.
    return uiState.dynamicEnabled !== false
        && (!Array.isArray(uiState.dynamicTools) || uiState.dynamicTools.includes(RUNTIME_ANALYZER));
}
