import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface BuiltCommand {
    /**
     * When set, use cp.execFile(file, args) — no shell, no injection risk.
     * Preferred for Linux / macOS.
     */
    file?: string;
    args?: string[];
    /**
     * Shell command string used only for WSL paths (Windows).
     * Always built from validated, shell-escaped arguments.
     */
    command?: string;
    /** Temporary files to clean up after execution (Windows only) */
    tempFiles: string[];
}

// ─── Parameter validation ─────────────────────────────────────────────────────

/**
 * Parses a raw params string into individual tokens and validates every token
 * against an allowlist. Only `--flag` and `--flag=value` forms are accepted.
 *
 * Permitted value characters: alphanumeric, `.`, `@`, `,`, `-`, `_`.
 * Explicitly rejected: `/` and `:` — these are excluded to prevent
 * path-traversal payloads such as `--file=../../etc/passwd` or
 * `--config=/etc/shadow` from reaching the CLI.
 *
 * Throws if any token does not match, preventing shell injection via
 * metacharacters such as `;`, `|`, `&`, `$()`, backticks, etc.
 */
export function parseAndValidateParams(raw: string): string[] {
    // Tokenize on whitespace; strip surrounding quotes from each token.
    const tokens: string[] = [];
    const re = /("[^"]*"|'[^']*'|\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
        tokens.push(m[1].replace(/^["']|["']$/g, ''));
    }

    // Strict allowlist: --flag  or  --flag=safeValue
    // Note: / and : are intentionally excluded to prevent path-traversal payloads
    // such as --file=../../etc/passwd or --config=/etc/shadow.
    const safe = /^--[a-zA-Z][a-zA-Z0-9-]*(?:=[a-zA-Z0-9_.@,\-]*)?$/;
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
 * Falls back to a simple `/mnt/<drive>/` prefix substitution if the command
 * fails or times out.
 *
 * Uses `cp.execFileSync` with an explicit args array so no shell is involved
 * and no shell quoting is needed.  On Windows, `execSync` runs via `cmd.exe`
 * which does NOT honour POSIX single-quote quoting, meaning
 * `shellEscapeArg`-wrapped paths would be passed to wsl with literal `'`
 * characters and fail to convert.
 *
 * @param winPath     The Windows path to convert.
 * @param distroName  The WSL distro to run inside, or null for the default.
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
 * Builds the ctrace shell command for the current platform.
 * - Linux / macOS: native execution
 * - Windows: WSL-aware execution with automatic distro detection and temp-file fallback
 *
 * When `compileCommands` is true, `inputFilePath` is treated as a path to a
 * `compile_commands.json` database and is still passed through `--input`.
 *
 * Note: current ctrace CLI (see `ctrace --help`) does not expose a
 * `--compile-commands` flag, so we cannot use a dedicated option here.
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

function buildNativeCommand(ctracePath: string, inputFilePath: string, params: string, compileCommands: boolean): BuiltCommand {
    const validatedParams = parseAndValidateParams(params);
    // ctrace accepts compile_commands.json through --input for file discovery,
    // and requires --compile-commands for the stack analyzer configuration.
    const args = ['--input', inputFilePath, ...validatedParams, '--sarif-format'];
    if (compileCommands) {
        args.push('--compile-commands', inputFilePath);
    }
    
    // Use execFile — no shell spawn, so shell metacharacters in any argument
    // can never be interpreted as commands.
    return {
        file: ctracePath,
        args,
        tempFiles: [],
    };
}

// ─── Windows / WSL ───────────────────────────────────────────────────────────

async function buildWindowsCommand(ctracePath: string, inputFilePath: string, params: string, compileCommands: boolean): Promise<BuiltCommand> {
    const tempFiles: string[] = [];

    const parseWslUNC = (p: string) => {
        const normalized = p.replace(/\\/g, '/');
        const match = normalized.match(/^\/{2,}[^\/]+\/([^\/]+)\/(.+)$/i);
        return match ? { distro: match[1], internalPath: '/' + match[2] } : null;
    };

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
        // Validate params before embedding in the shell string.
        const validatedParams = parseAndValidateParams(params).map(shellEscapeArg).join(' ');
        // Use double-quoted distro name for the cmd.exe-level prefix.
        // safeDistroName has '"', "'", '`' and '\' stripped, so embedding
        // it inside "..." is safe even for names that contain spaces.
        const prefix = isDefault ? 'wsl' : `wsl -d "${safeDistroName}"`;
        // ctrace accepts compile_commands.json through --input for file discovery,
        // and requires --compile-commands for stack analyzer configuration.
        const extraArgs = compileCommands ? `--compile-commands ${shellEscapeArg(finalInput)}` : '';

        return `${prefix} sh -c "chmod +x ${shellEscapeArg(finalBin)} && ${shellEscapeArg(finalBin)} --input ${shellEscapeArg(finalInput)} ${extraArgs} ${validatedParams} --sarif-format"`;
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

    const wBin   = toWslPath(tempBin);
    const wInput = toWslPath(tempInput);
    // Validate params before embedding in the shell string.
    const validatedParams = parseAndValidateParams(params).map(shellEscapeArg).join(' ');
    // ctrace accepts compile_commands.json through --input for file discovery,
    // and requires --compile-commands for stack analyzer configuration.
    const extraArgs = compileCommands ? `--compile-commands ${shellEscapeArg(wInput)}` : '';

    const command = `wsl sh -c "cp ${shellEscapeArg(wBin)} ${shellEscapeArg(lBin)} && chmod +x ${shellEscapeArg(lBin)} && ${shellEscapeArg(lBin)} --input ${shellEscapeArg(wInput)} ${extraArgs} ${validatedParams} --sarif-format; rm -f ${shellEscapeArg(lBin)}"`;
    return { command, tempFiles };
}
