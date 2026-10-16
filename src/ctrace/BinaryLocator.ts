import * as fs from 'fs';
import * as path from 'path';

/**
 * Locates the ctrace binary inside the extension installation folder.
 * Returns the resolved path, or null if not found.
 */
export async function locateBinary(extensionPath: string): Promise<string | null> {
    const candidates = ['ctrace', 'coretrace', 'ctrace.exe', 'coretrace.exe'];

    for (const name of candidates) {
        const candidateInBin = path.join(extensionPath, 'bin', name);
        if (await isExecutableFile(candidateInBin)) {
            return candidateInBin;
        }

        const candidate = path.join(extensionPath, name);
        if (await isExecutableFile(candidate)) {
            return candidate;
        }
    }

    return null;
}

/**
 * Looks for a ctrace binary on PATH (e.g. built from source on macOS, where
 * no prebuilt release exists). Returns the resolved path, or null.
 */
export async function locateBinaryOnPath(): Promise<string | null> {
    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
        for (const name of ['ctrace', 'coretrace']) {
            const candidate = path.join(dir, name);
            if (await isExecutableFile(candidate)) {
                return candidate;
            }
        }
    }
    return null;
}

async function isExecutableFile(filePath: string): Promise<boolean> {
    try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) { return false; }
        // On Linux/macOS check the execute bit. On Windows X_OK is not
        // meaningful (WSL binaries lack it on the host FS), so a file-existence
        // check is the best we can do — AnalysisRunner handles chmod +x anyway.
        if (process.platform !== 'win32') {
            await fs.promises.access(filePath, fs.constants.X_OK);
        }
        return true;
    } catch {
        return false;
    }
}
