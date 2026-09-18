import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import * as tar from 'tar';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { locateBinary } from './BinaryLocator';

const REPO_LATEST_RELEASE_URL = 'https://api.github.com/repos/CoreTrace/coretrace/releases/latest';

let updatePromise: Promise<string | null> | null = null;

export function isUpdatingBinary(): boolean {
    return updatePromise !== null;
}

let progressListener: ((msg: string) => void) | undefined;

export function setBinaryUpdateListener(listener: (msg: string) => void) {
    progressListener = listener;
}

export async function ensureBinary(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<string | null> {
    if (updatePromise) {
        return updatePromise;
    }
    updatePromise = doEnsureBinary(context, output).finally(() => {
        updatePromise = null;
        if (progressListener) {
            progressListener('__done__');
        }
    });
    return updatePromise;
}

async function doEnsureBinary(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<string | null> {
    // 1. If binary is bundled with the extension (e.g. Target-Platform Marketplace package)
    const bundledBinary = await locateBinary(context.extensionUri.fsPath);
    if (bundledBinary) {
        return bundledBinary;
    }

    const globalStorage = context.globalStorageUri.fsPath;
    const binDir = path.join(globalStorage, 'bin');

    await fs.promises.mkdir(binDir, { recursive: true });

    const downloadedBinaryPath = await getExtractedBinaryPath(binDir);
    const lastCheck = context.globalState.get<number>('coretrace-last-update-check') || 0;
    const lastFailedCheck = context.globalState.get<number>('coretrace-last-failed-update-check') || 0;
    const now = Date.now();
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;
    const FAILURE_BACKOFF = 60 * 1000;

    // If we have a cached binary and checked recently, avoid spamming the GitHub API.
    if (downloadedBinaryPath && now - lastCheck < TWELVE_HOURS) {
        return downloadedBinaryPath;
    }

    // When there is no cached binary, keep retrying with a short backoff.
    // This avoids a 12-hour lockout if the very first download fails.
    if (!downloadedBinaryPath && now - lastFailedCheck < FAILURE_BACKOFF) {
        output.appendLine('Skipping update check due to recent failure backoff.');
        return await locateBinary(context.extensionUri.fsPath);
    }

    try {
        const response = await axios.get(REPO_LATEST_RELEASE_URL, {
            headers: { 'User-Agent': 'vscode-coretrace' },
            timeout: 5000 // Don't block forever
        });
        const release = response.data;
        const latestVersion = release.tag_name;
        
        const currentVersion = context.globalState.get<string>('coretrace-version');
        const cachedBinaryPath = await getExtractedBinaryPath(binDir);

        if (latestVersion !== currentVersion || !cachedBinaryPath) {
            const assetInfo = getAssetForPlatform(release.assets);
            if (assetInfo) {
                output.appendLine(`Selected release asset: ${assetInfo.name}`);
                if (progressListener) { progressListener("0%"); }
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Downloading CoreTrace ${latestVersion}...`,
                    cancellable: false
                }, async (progress) => {
                    output.appendLine(`Downloading CoreTrace release ${latestVersion} from GitHub...`);
                    await downloadAndExtract(assetInfo.url, binDir, progress);
                    await Promise.all([
                        context.globalState.update('coretrace-version', latestVersion),
                        context.globalState.update('coretrace-last-failed-update-check', undefined)
                    ]);
                    output.appendLine(`Updated CoreTrace to ${latestVersion} successfully.`);
                });
            } else {
                output.appendLine(`No GitHub release asset found for platform ${process.platform} arch ${process.arch}`);
            }
        }

        // Update the timestamp only after a successful check (and potential download)
        await context.globalState.update('coretrace-last-update-check', now);

        const bin = await getExtractedBinaryPath(binDir);
        if (bin) return bin;
        
    } catch (err: any) {
        output.appendLine(`Failed to check for CoreTrace updates: ${err.message}`);
        await context.globalState.update('coretrace-last-failed-update-check', now);

        // Keep old behaviour only when we already have a working cached binary.
        if (downloadedBinaryPath) {
            await context.globalState.update('coretrace-last-update-check', now);
        }
    }

    // Try to return the previously downloaded binary first, even if update check failed
    const cachedBin = await getExtractedBinaryPath(binDir);
    if (cachedBin) return cachedBin;

    // Fallback to bundled
    return await locateBinary(context.extensionUri.fsPath);
}

function getAssetForPlatform(assets: any[]): { name: string; url: string } | null {
    const osMap: Record<string, string[]> = {
        'win32': ['windows', 'linux'], // Windows executes via WSL, so fall back to linux if no native windows binary exists
        'linux': ['linux'],
        'darwin': ['darwin', 'macos']
    };
    const archMap: Record<string, string> = {
        'x64': 'amd64',
        'arm64': 'arm64'
    };
    
    const osList = osMap[process.platform] || [process.platform];
    const arch = archMap[process.arch] || process.arch;
    
    for (const os of osList) {
        // First try exact matches (os + arch + .tar.gz)
        for (const asset of assets) {
            const name = asset.name.toLowerCase();
            if (name.includes(os) && name.includes(arch) && name.endsWith('.tar.gz')) {
                return { name: asset.name, url: asset.browser_download_url };
            }
        }
        // Fallback for older formats (os + .tar.gz)
        for (const asset of assets) {
            const name = asset.name.toLowerCase();
            if (name.includes(os) && name.endsWith('.tar.gz')) {
                return { name: asset.name, url: asset.browser_download_url };
            }
        }
    }
    return null;
}

async function downloadAndExtract(url: string, destDir: string, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
    const timestamp = Date.now();
    
    const token = process.env.GITHUB_TOKEN || '';
    const headers: any = { 'User-Agent': 'vscode-coretrace' };
    if (token) headers['Authorization'] = `token ${token}`;

    const controller = new AbortController();
    let timeoutId = setTimeout(() => controller.abort(new Error("Download stalled")), 30000);

    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers,
        signal: controller.signal
    });

    if (response.status !== 200) {
        clearTimeout(timeoutId);
        throw new Error(`Failed to download asset: HTTP ${response.status}`);
    }

    const totalLength = parseInt(response.headers['content-length'], 10);
    let downloadedLength = 0;

    const progressStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => controller.abort(new Error("Download stalled")), 30000);

            downloadedLength += chunk.length;
            if (totalLength) {
                const percent = Math.round((downloadedLength / totalLength) * 100);
                const msg = `${percent}%`;
                progress.report({ message: msg, increment: (chunk.length / totalLength) * 100 });
                if (progressListener) { progressListener(msg); }
            }
            callback(null, chunk);
        }
    });

    // Stream and extract on-the-fly to a temporary directory with strip: 1.
    // The release tarball contains the full CMake install layout (bin/ctrace, lib/libLLVM..., config/...).
    // Streaming directly through memory avoids writing intermediate archives to disk,
    // taking only ~2s while preserving all dependencies and configuration files.
    const tmpDir = path.join(destDir, `tmp-${timestamp}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });

    const candidates = ['ctrace', 'coretrace', 'ctrace.exe', 'coretrace.exe'];

    try {
        const extractStream = tar.x({
            C: tmpDir,
            strip: 1
        });

        await pipeline(response.data, progressStream, extractStream);
        clearTimeout(timeoutId);

        if (progressListener) { progressListener("Finishing..."); }

        // Move the extracted layout (bin, lib, config) into destDir so ctrace can resolve its shared libraries
        // via INSTALL_RPATH "$ORIGIN/../lib"
        for (const folder of ['bin', 'lib', 'config']) {
            const src = path.join(tmpDir, folder);
            const dst = path.join(destDir, folder);
            if (fs.existsSync(src)) {
                await fs.promises.rm(dst, { recursive: true, force: true }).catch(() => {});
                await fs.promises.rename(src, dst);
            }
        }

        // Also check if any standalone binary was extracted at root of tmpDir
        for (const name of candidates) {
            const srcFile = path.join(tmpDir, name);
            if (fs.existsSync(srcFile)) {
                const dstBinDir = path.join(destDir, 'bin');
                await fs.promises.mkdir(dstBinDir, { recursive: true });
                const dstFile = path.join(dstBinDir, name);
                await fs.promises.unlink(dstFile).catch(() => {});
                await fs.promises.rename(srcFile, dstFile);
            }
        }

        const finalBinPath = await getExtractedBinaryPath(destDir);
        if (!finalBinPath) {
            throw new Error("Could not find ctrace/coretrace binary inside the downloaded archive.");
        }

        // Make it executable if on linux/mac
        if (process.platform !== 'win32') {
            await fs.promises.chmod(finalBinPath, 0o755);
        }
    } finally {
        clearTimeout(timeoutId);
        try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch (e) {
            // Ignore removal errors
        }
    }
}

async function getExtractedBinaryPath(binDir: string): Promise<string | null> {
    const candidates = ['ctrace', 'coretrace', 'ctrace.exe', 'coretrace.exe'];
    for (const name of candidates) {
        // Standard CMake install structure: binDir/bin/ctrace
        const fileInBin = path.join(binDir, 'bin', name);
        if (fs.existsSync(fileInBin)) {
            return fileInBin;
        }

        // Nested install structure: binDir/bin/bin/ctrace
        const fileInNestedBin = path.join(binDir, 'bin', 'bin', name);
        if (fs.existsSync(fileInNestedBin)) {
            return fileInNestedBin;
        }

        // Fallback for flat structure: binDir/ctrace
        const file = path.join(binDir, name);
        if (fs.existsSync(file)) {
            return file;
        }
    }
    return null;
}
