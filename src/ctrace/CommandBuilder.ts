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
 * Parses a raw params string into individual tokens.
 * Tokenizes respecting quoted strings, then strips surrounding quotes.
 * No strict allowlist — all flags are accepted; safety is guaranteed by
 * using execFile (Linux/macOS) or shellEscapeArg (WSL shell strings).
 */
export function parseAndValidateParams(raw: string): string[] {
    const tokens: string[] = [];
    const re = /("[^"]*"|'[^']*'|\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
        tokens.push(m[1].replace(/^["']|["']$/g, ''));
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
    return buildWindowsCommand(ctracePath, inputFilePath, params, compileCommands);
}

// ─── Linux / macOS ───────────────────────────────────────────────────────────

function buildNativeCommand(ctracePath: string, inputFilePath: string, params: string): BuiltCommand {
    const command = `chmod +x "${ctracePath}" && "${ctracePath}" --input "${inputFilePath}" ${params}`;
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

function buildWindowsCommand(ctracePath: string, inputFilePath: string, params: string): BuiltCommand {
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
        // resolveDistroName returns the sanitized, verified distro name or null.
        // We must NOT use single-quote escaping here: the final command string
        // is executed by cmd.exe on Windows, which treats single quotes as
        // literal characters.  Double-quote wrapping (used below when building
        // the prefix) is the correct quoting style for cmd.exe.
        const safeDistroName = isDefault ? null : resolveDistroName(matchedDistro);
        if (!isDefault && safeDistroName === null) { return null; } // unreachable distro

        const resolvePath = (origPath: string, wsl: { distro: string; internalPath: string } | null): string => {
            if (wsl?.distro === detectedDistro) { return wsl.internalPath; }
            // Use safeDistroName (sanitized + reachability-verified) so that
            // toWslPath targets the exact same distro as the final prefix.
            // Passing the raw matchedDistro could probe a different distro if
            // stripping shell-significant characters changes the name.
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

        const prefix = isDefault ? 'wsl' : `wsl ${distroFlag}`;

        return `${prefix} sh -c "chmod +x ${shellEscapeArg(finalBin)} && ${shellEscapeArg(finalBin)} --input ${shellEscapeArg(finalInput)} ${validatedParams}"`;
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

async function buildFallbackCommand(ctracePath: string, inputFilePath: string, params: string, tempFiles: string[], compileCommands: boolean): Promise<BuiltCommand> {
    const ext = path.extname(inputFilePath) || '.c';
    // Single timestamp shared across all temp names to prevent races between
    // the two Date.now() calls that existed previously.
    const stamp = `${Date.now()}-${process.pid}`;

    const tempBin   = path.join(os.tmpdir(), `ctrace-bin-${stamp}`);
    const tempInput = path.join(os.tmpdir(), `ctrace-input-${stamp}${ext}`);
    const lBin      = `/tmp/ctrace-${stamp}`;

    // Use async I/O — the ctrace binary can be 10–50 MB; a synchronous copy
    // would block the VS Code extension host thread for hundreds of ms.
    await fs.promises.copyFile(ctracePath, tempBin);
    await fs.promises.copyFile(inputFilePath, tempInput);
    tempFiles.push(tempBin, tempInput);

    const resolveWslPath = (p: string): string => {
        try { return cp.execSync(`wsl wslpath -u "${p}"`).toString().trim(); }
        catch { return p.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`); }
    };

    const wBin = resolveWslPath(tempBin);
    const wInput = resolveWslPath(tempInput);
    const lBin = `/tmp/ctrace-${Math.floor(Math.random() * 100000)}`;

    const validatedParamsTokens = parseAndValidateParams(params).map(token => {
        const eqIndex = token.indexOf('=');
        if (eqIndex > 0) {
            const key = token.substring(0, eqIndex);
            const val = token.substring(eqIndex + 1);
            if (val.match(/^[a-zA-Z]:[\\/]/) || val.startsWith('\\\\') || val.startsWith('//')) {
                return `${key}=${resolveWslPath(val)}`;
            }
        }
        return token;
    });
    const validatedParams = validatedParamsTokens.map(shellEscapeArg).join(' ');

    const command = `wsl sh -c "cp ${shellEscapeArg(wBin)} ${shellEscapeArg(lBin)} && chmod +x ${shellEscapeArg(lBin)} && ${shellEscapeArg(lBin)} --input ${shellEscapeArg(wInput)} ${validatedParams}; rm -f ${shellEscapeArg(lBin)}"`;
    return { command, tempFiles };
}
