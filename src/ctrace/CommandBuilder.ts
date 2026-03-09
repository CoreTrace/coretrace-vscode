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
 * against an allowlist. Only `--flag` and `--flag=value` forms are accepted
 * where value contains only safe characters (alphanumeric, `.`, `/`, `:`, `@`,
 * `,`, `-`, `_`).
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
 * @param winPath    The Windows path to convert.
 * @param wslPrefix  The wsl invocation prefix to use (default: `"wsl"`).
 */
function toWslPath(winPath: string, wslPrefix: string = 'wsl'): string {
    try {
        // shellEscapeArg wraps in single quotes so backslashes and spaces in
        // Windows paths cannot break out of the wslpath argument.
        return cp.execSync(`${wslPrefix} wslpath -u ${shellEscapeArg(winPath)}`, { timeout: 5000 }).toString().trim();
    } catch {
        return winPath.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
    }
}

/**
 * Builds the ctrace shell command for the current platform.
 * - Linux / macOS: native execution
 * - Windows: WSL-aware execution with automatic distro detection and temp-file fallback
 *
 * Async because the Windows fallback path copies files to the system temp
 * directory using non-blocking I/O rather than blocking the extension host.
 */
export async function buildCommand(
    ctracePath: string,
    inputFilePath: string,
    params: string
): Promise<BuiltCommand> {
    if (process.platform !== 'win32') {
        return buildNativeCommand(ctracePath, inputFilePath, params);
    }
    return buildWindowsCommand(ctracePath, inputFilePath, params);
}

// ─── Linux / macOS ───────────────────────────────────────────────────────────

function buildNativeCommand(ctracePath: string, inputFilePath: string, params: string): BuiltCommand {
    const validatedParams = parseAndValidateParams(params);
    // Use execFile — no shell spawn, so shell metacharacters in any argument
    // can never be interpreted as commands.
    return {
        file: ctracePath,
        args: ['--input', inputFilePath, ...validatedParams, '--sarif-format'],
        tempFiles: [],
    };
}

// ─── Windows / WSL ───────────────────────────────────────────────────────────

async function buildWindowsCommand(ctracePath: string, inputFilePath: string, params: string): Promise<BuiltCommand> {
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
        const result = trySmartDistroExecution(ctracePath, inputFilePath, params, detectedDistro, binWsl, inputWsl);
        if (result) {
            return { command: result, tempFiles };
        }
    }

    // Fallback: copy files to Windows temp folder, run via default WSL distro
    return await buildFallbackCommand(ctracePath, inputFilePath, params, tempFiles);
}

function trySmartDistroExecution(
    ctracePath: string,
    inputFilePath: string,
    params: string,
    detectedDistro: string,
    binWsl: { distro: string; internalPath: string } | null,
    inputWsl: { distro: string; internalPath: string } | null
): string | null {
    try {
        const clean = (s: string) => s.replace(/[\u0000-\u001F\u007F-\u009F\uFEFF\uFFFD]/g, '').trim();
        const stdout = cp.execSync('wsl -l -v', { encoding: 'utf16le', timeout: 5000 });
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
        const distroFlag = isDefault ? '' : resolveDistroFlag(matchedDistro);
        if (distroFlag === null) { return null; } // unreachable distro

        const resolvePath = (origPath: string, wsl: { distro: string; internalPath: string } | null): string => {
            if (wsl?.distro === detectedDistro) { return wsl.internalPath; }
            const prefix = isDefault ? 'wsl' : `wsl ${distroFlag}`;
            return toWslPath(origPath, prefix);
        };

        const finalBin = binWsl?.distro === detectedDistro ? binWsl.internalPath : resolvePath(ctracePath, binWsl);
        const finalInput = inputWsl?.distro === detectedDistro ? inputWsl.internalPath : resolvePath(inputFilePath, inputWsl);
        // Validate params before embedding in the shell string.
        const validatedParams = parseAndValidateParams(params).map(shellEscapeArg).join(' ');
        const prefix = isDefault ? 'wsl' : `wsl ${distroFlag}`;

        return `${prefix} sh -c "chmod +x ${shellEscapeArg(finalBin)} && ${shellEscapeArg(finalBin)} --input ${shellEscapeArg(finalInput)} ${validatedParams} --sarif-format"`;  
    } catch {
        return null;
    }
}

/** Returns the -d flag string for wsl, or null if the distro is unreachable. */
function resolveDistroFlag(distro: string): string | null {
    // Strip any character that could escape the single-quoted argument,
    // specifically double quotes that might break the outer shell string.
    const safeDistro = distro.replace(/["'`\\]/g, '');
    if (!safeDistro) { return null; }
    try {
        cp.execSync(`wsl -d ${shellEscapeArg(safeDistro)} true`, { timeout: 5000 });
        return `-d ${shellEscapeArg(safeDistro)}`;
    } catch {
        // fall through
    }
    return null;
}

async function buildFallbackCommand(ctracePath: string, inputFilePath: string, params: string, tempFiles: string[]): Promise<BuiltCommand> {
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

    const resolveWslPath = (p: string): string => toWslPath(p);

    const wBin   = resolveWslPath(tempBin);
    const wInput = resolveWslPath(tempInput);
    // Validate params before embedding in the shell string.
    const validatedParams = parseAndValidateParams(params).map(shellEscapeArg).join(' ');

    const command = `wsl sh -c "cp ${shellEscapeArg(wBin)} ${shellEscapeArg(lBin)} && chmod +x ${shellEscapeArg(lBin)} && ${shellEscapeArg(lBin)} --input ${shellEscapeArg(wInput)} ${validatedParams} --sarif-format; rm -f ${shellEscapeArg(lBin)}"`;
    return { command, tempFiles };
}
