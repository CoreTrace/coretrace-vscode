import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface BuiltCommand {
    /** Shell command ready to be executed via cp.exec */
    command: string;
    /** Temporary files to clean up after execution (Windows only) */
    tempFiles: string[];
}

/**
 * Builds the ctrace shell command for the current platform.
 * - Linux / macOS: native execution
 * - Windows: WSL-aware execution with automatic distro detection and temp-file fallback
 */
export function buildCommand(
    ctracePath: string,
    inputFilePath: string,
    params: string
): BuiltCommand {
    if (process.platform !== 'win32') {
        return buildNativeCommand(ctracePath, inputFilePath, params);
    }
    return buildWindowsCommand(ctracePath, inputFilePath, params);
}

// ─── Linux / macOS ───────────────────────────────────────────────────────────

function buildNativeCommand(ctracePath: string, inputFilePath: string, params: string): BuiltCommand {
    const command = `chmod +x "${ctracePath}" && "${ctracePath}" --input "${inputFilePath}" ${params} --sarif-format`;
    return { command, tempFiles: [] };
}

// ─── Windows / WSL ───────────────────────────────────────────────────────────

function buildWindowsCommand(ctracePath: string, inputFilePath: string, params: string): BuiltCommand {
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
    return buildFallbackCommand(ctracePath, inputFilePath, params, tempFiles);
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
        const stdout = cp.execSync('wsl -l -v', { encoding: 'utf16le' });
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
            try {
                return cp.execSync(`${prefix} wslpath -u "${origPath}"`).toString().trim();
            } catch {
                return origPath.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
            }
        };

        const finalBin = binWsl?.distro === detectedDistro ? binWsl.internalPath : resolvePath(ctracePath, binWsl);
        const finalInput = inputWsl?.distro === detectedDistro ? inputWsl.internalPath : resolvePath(inputFilePath, inputWsl);
        const safeParams = params.replace(/"/g, '\\"');
        const prefix = isDefault ? 'wsl' : `wsl ${distroFlag}`;

        return `${prefix} sh -c "chmod +x '${finalBin}' && '${finalBin}' --input '${finalInput}' ${safeParams} --sarif-format"`;
    } catch {
        return null;
    }
}

/** Returns the -d flag string for wsl, or null if the distro is unreachable. */
function resolveDistroFlag(distro: string): string | null {
    try {
        cp.execSync(`wsl -d "${distro}" true`);
        return `-d "${distro}"`;
    } catch {
        if (!distro.includes(' ')) {
            try {
                cp.execSync(`wsl -d ${distro} true`);
                return `-d ${distro}`;
            } catch { /* fall through */ }
        }
    }
    return null;
}

function buildFallbackCommand(ctracePath: string, inputFilePath: string, params: string, tempFiles: string[]): BuiltCommand {
    const ext = path.extname(inputFilePath) || '.c';
    const stamp = Date.now();

    const tempBin = path.join(os.tmpdir(), `ctrace-bin-${stamp}`);
    const tempInput = path.join(os.tmpdir(), `ctrace-input-${stamp}${ext}`);

    fs.copyFileSync(ctracePath, tempBin);
    fs.copyFileSync(inputFilePath, tempInput);
    tempFiles.push(tempBin, tempInput);

    const resolveWslPath = (p: string): string => {
        try { return cp.execSync(`wsl wslpath -u "${p}"`).toString().trim(); }
        catch { return p.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`); }
    };

    const wBin = resolveWslPath(tempBin);
    const wInput = resolveWslPath(tempInput);
    const lBin = `/tmp/ctrace-${Math.floor(Math.random() * 100000)}`;
    const safeParams = params.replace(/"/g, '\\"');

    const command = `wsl sh -c "cp '${wBin}' '${lBin}' && chmod +x '${lBin}' && '${lBin}' --input '${wInput}' ${safeParams} --sarif-format; rm -f '${lBin}'"`;
    return { command, tempFiles };
}
