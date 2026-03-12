import * as fs from 'fs';
import * as path from 'path';

/**
 * Locates the ctrace binary inside the extension installation folder.
 * Returns the resolved path, or null if not found.
 */
export async function locateBinary(extensionPath: string): Promise<string | null> {
    const candidates = ['ctrace', 'coretrace'];

    for (const name of candidates) {
        const candidate = path.join(extensionPath, name);
        if (await isExecutableFile(candidate)) {
            return candidate;
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
