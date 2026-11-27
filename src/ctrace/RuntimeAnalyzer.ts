import { enterToolsDirectory, shellEscapeArg } from './CommandBuilder';
import { execShellCommand } from './DependencyInstaller';

export const RUNTIME_ANALYZER = 'coretrace-runtime-analyzer';

/** Where a release (`<prefix>/bin/ctrace`) puts the runtime analyzer, relative to ctrace's directory. */
export const BUNDLED_RUNTIME_ANALYZER = `../libexec/coretrace/${RUNTIME_ANALYZER}/bin/runtime-analyzer`;

/**
 * A POSIX shell script that exits 0 when ctrace at `ctracePath` would find an
 * executable runtime analyzer, by ctrace's own rules: the configured path
 * alone when set; else the copy of its release or build tree, then PATH.
 */
export function runtimeAnalyzerProbe(ctracePath: string, configured?: string): string {
    const executable = (file: string) => `[ -f ${file} ] && [ -x ${file} ]`;
    // ctrace searches nonempty PATH entries for files, including names that are shell builtins.
    const onPath = (name: string) => 'rest=${PATH-}:; while [ -n "$rest" ]; do '
        + 'dir=${rest%%:*}; rest=${rest#*:}; [ -n "$dir" ] || continue; '
        + `p="$dir"/${shellEscapeArg(name)}; ${executable('"$p"')} && exit 0; done; exit 1`;
    if (configured) {
        return configured.includes('/') ? executable(shellEscapeArg(configured)) : onPath(configured);
    }
    const bin = shellEscapeArg(ctracePath);
    const bundled = [BUNDLED_RUNTIME_ANALYZER, BUNDLED_RUNTIME_ANALYZER.replace('../', '')]
        .map(relative => `"$d"/${shellEscapeArg(relative)}`).join(' ');
    return `b=$(command -p readlink -f ${bin} 2>/dev/null) || b=${bin}; d=\${b%/*}; `
        + `for c in ${bundled}; do ${executable('"$c"')} && exit 0; done; ${onPath(RUNTIME_ANALYZER)}`;
}

type Shell = (command: string, distro: string | null) => Promise<{ code: number }>;

/**
 * Whether ctrace can run dynamic analysis where it runs (`distro` inside WSL
 * on Windows, null for the default one). macOS releases do not include it.
 */
export async function isRuntimeAnalyzerAvailable(
    target: { binary: string; distro: string | null },
    configured: string | undefined,
    cwd: string,
    shell: Shell = (command, distro) => execShellCommand(command, { distro, cwd })
): Promise<boolean> {
    try {
        return (await shell(enterToolsDirectory() + runtimeAnalyzerProbe(target.binary, configured), target.distro)).code === 0;
    } catch {
        return false;
    }
}
