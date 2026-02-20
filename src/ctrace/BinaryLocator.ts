import * as fs from 'fs';
import * as path from 'path';

/**
 * Locates the ctrace binary inside the extension installation folder.
 * Returns the resolved path, or null if not found.
 */
export function locateBinary(extensionPath: string): string | null {
    const candidates = ['ctrace', 'coretrace'];

    for (const name of candidates) {
        const candidate = path.join(extensionPath, name);
        if (isExecutableFile(candidate)) {
            return candidate;
        }
    }

    return null;
}

function isExecutableFile(filePath: string): boolean {
    try {
        const stat = fs.statSync(filePath);
        return stat.isFile();
    } catch {
        return false;
    }
}
