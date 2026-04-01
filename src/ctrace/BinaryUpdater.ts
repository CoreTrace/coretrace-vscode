import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import * as tar from 'tar';
import { pipeline } from 'stream/promises';
import { locateBinary } from './BinaryLocator';

const REPO_LATEST_RELEASE_URL = 'https://api.github.com/repos/CoreTrace/coretrace/releases/latest';

let updatePromise: Promise<string | null> | null = null;

export function isUpdatingBinary(): boolean {
    return updatePromise !== null;
}

export async function ensureBinary(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<string | null> {
    if (updatePromise) {
        return updatePromise;
    }
    updatePromise = doEnsureBinary(context, output).finally(() => {
        updatePromise = null;
    });
    return updatePromise;
}

async function doEnsureBinary(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<string | null> {
    const globalStorage = context.globalStorageUri.fsPath;
    const binDir = path.join(globalStorage, 'bin');

    await fs.promises.mkdir(binDir, { recursive: true });

    const downloadedBinaryPath = await getExtractedBinaryPath(binDir);
    const lastCheck = context.globalState.get<number>('coretrace-last-update-check') || 0;
    const now = Date.now();
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;

    // If we have checked recently, avoid spamming the GitHub API.
    // Return the downloaded binary if it exists, otherwise fallback to the packaged binary.
    if (now - lastCheck < TWELVE_HOURS) {
        if (downloadedBinaryPath) return downloadedBinaryPath;
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
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Downloading CoreTrace ${latestVersion}...`,
                    cancellable: false
                }, async (progress) => {
                    output.appendLine(`Downloading CoreTrace release ${latestVersion} from GitHub...`);
                    await downloadAndExtract(assetInfo.url, binDir, progress);
                    context.globalState.update('coretrace-version', latestVersion);
                    output.appendLine(`Updated CoreTrace to ${latestVersion} successfully.`);
                });
            } else {
                output.appendLine(`No GitHub release asset found for platform ${process.platform} arch ${process.arch}`);
            }
        }

        // Update the timestamp only after a successful check (and potential download)
        context.globalState.update('coretrace-last-update-check', now);

        const bin = await getExtractedBinaryPath(binDir);
        if (bin) return bin;
        
    } catch (err: any) {
        output.appendLine(`Failed to check for CoreTrace updates: ${err.message}`);
    }

    // Try to return the previously downloaded binary first, even if update check failed
    const cachedBin = await getExtractedBinaryPath(binDir);
    if (cachedBin) return cachedBin;

    // Fallback to bundled
    return await locateBinary(context.extensionUri.fsPath);
}

function getAssetForPlatform(assets: any[]): { name: string; url: string } | null {
    const osMap: Record<string, string> = {
        'win32': 'windows',
        'linux': 'linux',
        'darwin': 'darwin'
    };
    const archMap: Record<string, string> = {
        'x64': 'amd64',
        'arm64': 'arm64'
    };
    
    const os = osMap[process.platform];
    const arch = archMap[process.arch];
    if (!os || !arch) return null;
    
    // First try exact matches (os + arch + .tar.gz)
    for (const asset of assets) {
        const name = asset.name.toLowerCase();
        if ((name.includes(os) || (process.platform === 'darwin' && name.includes('macos'))) && 
            name.includes(arch) && 
            name.endsWith('.tar.gz')) {
            return { name: asset.name, url: asset.browser_download_url };
        }
    }
    // Fallback for older formats (os + .tar.gz)
    for (const asset of assets) {
        const name = asset.name.toLowerCase();
        if ((name.includes(os) || (process.platform === 'darwin' && name.includes('macos'))) && 
            name.endsWith('.tar.gz')) {
            return { name: asset.name, url: asset.browser_download_url };
        }
    }
    return null;
}

async function downloadAndExtract(url: string, destDir: string, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
    const timestamp = Date.now();
    const tarballPath = path.join(destDir, `download-${timestamp}.tar.gz`);
    
    const token = process.env.GITHUB_TOKEN || '';
    const headers: any = { 'User-Agent': 'vscode-coretrace' };
    if (token) headers['Authorization'] = `token ${token}`;

    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers
    });

    if (response.status !== 200) {
        throw new Error(`Failed to download asset: HTTP ${response.status}`);
    }

    const totalLength = parseInt(response.headers['content-length'], 10);
    let downloadedLength = 0;

    const writer = fs.createWriteStream(tarballPath);

    try {
        response.data.on('data', (chunk: Buffer) => {
            downloadedLength += chunk.length;
            if (totalLength) {
                const percent = Math.round((downloadedLength / totalLength) * 100);
                progress.report({ message: `${percent}%`, increment: (chunk.length / totalLength) * 100 });
            }
        });

        await pipeline(response.data, writer);

        // Extract to a unique temp directory
        const tmpDir = path.join(destDir, `tmp-${timestamp}`);
        await fs.promises.mkdir(tmpDir, { recursive: true });

        try {
            await tar.x({
                file: tarballPath,
                C: tmpDir,
                strip: 0 // Do not strip to avoid dropping root-level binaries
            });

            // Find the extracted binary recursively
            const candidates = ['ctrace', 'coretrace', 'ctrace.exe', 'coretrace.exe'];
            async function findBinary(dir: string): Promise<string | null> {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const name of candidates) {
                    const match = entries.find(e => e.isFile() && e.name === name);
                    if (match) return path.join(dir, match.name);
                }
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const res = await findBinary(path.join(dir, entry.name));
                        if (res) return res;
                    }
                }
                return null;
            }

            const binaryInTmp = await findBinary(tmpDir);
            if (!binaryInTmp) {
                throw new Error("Could not find ctrace/coretrace binary inside the downloaded archive.");
            }

            const finalBinPath = path.join(destDir, path.basename(binaryInTmp));
            // Move binary to the root of destDir
            await fs.promises.rename(binaryInTmp, finalBinPath);

            // Make it executable if on linux/mac
            if (process.platform !== 'win32') {
                await fs.promises.chmod(finalBinPath, 0o755);
            }
        } finally {
            try {
                await fs.promises.rm(tmpDir, { recursive: true, force: true });
            } catch (e) {
                // Ignore removal errors
            }
        }
    } finally {
        try {
            await fs.promises.unlink(tarballPath);
        } catch (e) {
            // Ignore if file doesn't exist or can't be removed
        }
    }
}

async function getExtractedBinaryPath(binDir: string): Promise<string | null> {
    const candidates = ['ctrace', 'coretrace', 'ctrace.exe', 'coretrace.exe'];
    for (const name of candidates) {
        // Fallback for flat structure or the newly moved binary
        const file = path.join(binDir, name);
        if (fs.existsSync(file)) {
            return file;
        }

        // Tarball structure is often: coretrace-vX.Y.Z-arch/bin/ctrace
        // Keeping this for backwards compatibility
        const fileInBin = path.join(binDir, 'bin', name);
        if (fs.existsSync(fileInBin)) {
            return fileInBin;
        }
    }
    return null;
}
