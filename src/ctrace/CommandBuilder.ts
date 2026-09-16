import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface BuiltCommand {
    /** Shell command string to execute via cp.exec. */
    command: string;
    /** Temporary files to clean up after execution (Windows only) */
    tempFiles: string[];
}

// ─── Parameter parsing ────────────────────────────────────────────────────────

/**
 * Parses a raw params string into individual tokens and validates every token
 * against shell injection metacharacters.
 */
export function parseAndValidateParams(raw: string): string[] {
    const tokens: string[] = [];
    const re = /("[^"]*"|'[^']*'|\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
        tokens.push(m[1].replace(/^["']|["']$/g, ''));
    }

    const safe = /^--?[a-zA-Z0-9][a-zA-Z0-9._\-:/\\=,@]*$/;
    for (const token of tokens) {
        if (!safe.test(token)) {
            throw new Error(`Unsafe CLI parameter rejected: "${token}"`);
        }
    }
    return tokens;
}

/**
 * Escapes a single argument for embedding inside a POSIX sh -c "…" string.
 * Wraps the value in single quotes and escapes any literal single quotes.
 * Only used for WSL execution paths that cannot avoid spawning a shell.
 */
function shellEscapeArg(arg: string): string {
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Converts a Windows-style path to its WSL POSIX equivalent using `wslpath`.
 * Falls back to a simple `/mnt/<drive>/` prefix substitution if the command fails.
 */
function toWslPath(winPath: string, distroName: string | null = null): string {
    try {
        const args = [
            ...(distroName ? ['-d', distroName] : []),
            'wslpath', '-u', winPath,
        ];
        return cp.execFileSync('wsl', args, { timeout: 5000 }).toString().trim();
    } catch {
        return winPath.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
    }
}

/**
 * Builds the ctrace command for the current platform.
 * - Linux / macOS: uses cp.execFile (no shell, safest option)
 * - Windows: WSL-aware execution with automatic distro detection and temp-file fallback
 *
 * When `compileCommands` is true, `inputFilePath` is treated as a path to a
 * `compile_commands.json` database and is passed to the `--compile-commands` 
 * flag (for stack analyzer configuration) as well as `--input` (for file discovery).
 *
 * Async because the Windows fallback path copies files to the system temp
 * directory using non-blocking I/O rather than blocking the extension host.
 */
export async function buildCommand(
    ctracePath: string,
    inputFilePath: string,
    params: string,
    compileCommands = false
): Promise<BuiltCommand> {
    if (process.platform !== 'win32') {
        return buildNativeCommand(ctracePath, inputFilePath, params, compileCommands);
    }
    return await buildWindowsCommand(ctracePath, inputFilePath, params, compileCommands);
}

// ─── Linux / macOS ───────────────────────────────────────────────────────────

function buildNativeCommand(
    ctracePath: string,
    inputFilePath: string,
    params: string,
    compileCommands = false
): BuiltCommand {
    const extraArgs = compileCommands ? ` --compile-commands "${inputFilePath}"` : '';
    const command = `chmod +x "${ctracePath}" && "${ctracePath}" --input "${inputFilePath}"${extraArgs} ${params}`;
    return { command, tempFiles: [] };
}

// ─── Windows / WSL ───────────────────────────────────────────────────────────

function parseWslUNC(p: string): { distro: string; internalPath: string } | null {
    const normalized = p.replace(/\\/g, '/');
    const uncMatch = normalized.match(/^\/{2,}[^\/]+\/([^\/]+)\/(.+)$/i);
    if (uncMatch) {
        return { distro: uncMatch[1], internalPath: '/' + uncMatch[2] };
    }
    const distroMatch = normalized.match(/^\/([^\/]+)\/(home|mnt|etc|usr|var|opt|tmp)\/(.+)$/i);
    if (distroMatch) {
        return { distro: distroMatch[1], internalPath: '/' + distroMatch[2] + '/' + distroMatch[3] };
    }
    return null;
}

async function buildWindowsCommand(
    ctracePath: string,
    inputFilePath: string,
    params: string,
    compileCommands = false
): Promise<BuiltCommand> {
    const tempFiles: string[] = [];

    const binWsl = parseWslUNC(ctracePath);
    const inputWsl = parseWslUNC(inputFilePath);
    const detectedDistro = binWsl?.distro ?? inputWsl?.distro;

    if (detectedDistro) {
        const result = trySmartDistroExecution(ctracePath, inputFilePath, params, detectedDistro, binWsl, inputWsl, compileCommands);
        if (result) {
            return { command: result, tempFiles };
        }
    }

    // Fallback: copy files to Windows temp folder, run via default WSL distro
    return await buildFallbackCommand(ctracePath, inputFilePath, params, tempFiles, compileCommands);
}

function trySmartDistroExecution(
    ctracePath: string,
    inputFilePath: string,
    params: string,
    detectedDistro: string,
    binWsl: { distro: string; internalPath: string } | null,
    inputWsl: { distro: string; internalPath: string } | null,
    compileCommands: boolean
): string | null {
    try {
        const clean = (s: string) => s.replace(/[\u0000-\u001F\u007F-\u009F\uFEFF\uFFFD]/g, '').trim();
        // execFileSync avoids spawning a shell (cmd.exe); encoding:'utf16le' is
        // supported by Node's execFileSync just as it is by execSync.
        const stdout = cp.execFileSync('wsl', ['-l', '-v'], { encoding: 'utf16le', timeout: 5000 });
        const lines = stdout.split(/[\r\n]+/).filter(l => l.trim());

        let defaultDistro = '';
        let matchedDistro = '';

        for (const line of lines) {
            if (line.includes('NAME') && line.includes('STATE')) { continue; }
            const isDefault = line.trim().startsWith('*');
            const parts = line.replace('*', '').trim().split(/\s+/);
            if (!parts.length) { continue; }
            const name = clean(parts[0]);
            if (isDefault) { defaultDistro = name; }
            if (name === detectedDistro || name.toLowerCase() === detectedDistro.toLowerCase()) {
                matchedDistro = name;
            }
        }

        if (!matchedDistro) { return null; }

        const isDefault = matchedDistro === defaultDistro;
        const safeDistroName = isDefault ? null : resolveDistroName(matchedDistro);
        if (!isDefault && safeDistroName === null) { return null; }

        const resolvePath = (origPath: string, wsl: { distro: string; internalPath: string } | null): string => {
            if (wsl?.distro === detectedDistro) { return wsl.internalPath; }
            return toWslPath(origPath, isDefault ? null : safeDistroName);
        };

        const finalBin = binWsl?.distro === detectedDistro ? binWsl.internalPath : resolvePath(ctracePath, binWsl);
        const finalInput = inputWsl?.distro === detectedDistro ? inputWsl.internalPath : resolvePath(inputFilePath, inputWsl);

        const validatedParamsTokens = parseAndValidateParams(params).map(token => {
            const eqIndex = token.indexOf('=');
            if (eqIndex > 0) {
                const key = token.substring(0, eqIndex);
                const val = token.substring(eqIndex + 1);
                const wsl = parseWslUNC(val);
                if (wsl || val.match(/^[a-zA-Z]:[\\/]/)) {
                    const finalVal = wsl?.distro === detectedDistro ? wsl.internalPath : resolvePath(val, wsl);
                    return `${key}=${finalVal}`;
                }
            }
            return token;
        });
        const validatedParams = validatedParamsTokens.map(shellEscapeArg).join(' ');

        const prefix = isDefault ? 'wsl' : `wsl -d "${safeDistroName}"`;
        const extraArgs = compileCommands ? ` --compile-commands ${shellEscapeArg(finalInput)}` : '';

        return `${prefix} sh -c "chmod +x ${shellEscapeArg(finalBin)} && ${shellEscapeArg(finalBin)} --input ${shellEscapeArg(finalInput)}${extraArgs} ${validatedParams}"`;
    } catch {
        return null;
    }
}

/**
 * Validates that a WSL distro is reachable and returns its sanitized name,
 * or null if it cannot be reached.
 *
 * The probe is shell-free (`cp.execFileSync` with an args array) so
 * cmd.exe's lack of single-quote quoting is irrelevant.
 * The returned name has shell-significant characters (`"`, `'`, `` ` ``,
 * `\`) stripped so the caller can safely embed it inside a double-quoted
 * cmd.exe argument: `wsl -d "<name>"`.
 */
function resolveDistroName(distro: string): string | null {
    const safeDistro = distro.replace(/["'`\\]/g, '');
    if (!safeDistro) { return null; }
    try {
        cp.execFileSync('wsl', ['-d', safeDistro, 'true'], { timeout: 5000 });
        return safeDistro;
    } catch {
        // fall through
    }
    return null;
}

async function buildFallbackCommand(
    ctracePath: string,
    inputFilePath: string,
    params: string,
    tempFiles: string[],
    compileCommands: boolean
): Promise<BuiltCommand> {
    const ext = path.extname(inputFilePath) || '.c';
    const stamp = `${Date.now()}-${process.pid}`;

    const tempBin   = path.join(os.tmpdir(), `ctrace-bin-${stamp}`);
    const tempInput = path.join(os.tmpdir(), `ctrace-input-${stamp}${ext}`);
    const lBin      = `/tmp/ctrace-${stamp}`;

    await fs.promises.copyFile(ctracePath, tempBin);
    await fs.promises.copyFile(inputFilePath, tempInput);
    tempFiles.push(tempBin, tempInput);

    const wBin = toWslPath(tempBin);
    const wInput = toWslPath(tempInput);

    const validatedParamsTokens = parseAndValidateParams(params).map(token => {
        const eqIndex = token.indexOf('=');
        if (eqIndex > 0) {
            const key = token.substring(0, eqIndex);
            const val = token.substring(eqIndex + 1);
            if (val.match(/^[a-zA-Z]:[\\/]/) || val.startsWith('\\\\') || val.startsWith('//')) {
                return `${key}=${toWslPath(val)}`;
            }
        }
        return token;
    });
    const validatedParams = validatedParamsTokens.map(shellEscapeArg).join(' ');
    const extraArgs = compileCommands ? ` --compile-commands ${shellEscapeArg(wInput)}` : '';

    const command = `wsl sh -c "cp ${shellEscapeArg(wBin)} ${shellEscapeArg(lBin)} && chmod +x ${shellEscapeArg(lBin)} && ${shellEscapeArg(lBin)} --input ${shellEscapeArg(wInput)}${extraArgs} ${validatedParams}; rm -f ${shellEscapeArg(lBin)}"`;
    return { command, tempFiles };
}
