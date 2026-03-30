import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import * as tar from 'tar';
import { locateBinary } from './BinaryLocator';

const REPO_LATEST_RELEASE_URL = 'https://api.github.com/repos/CoreTrace/coretrace/releases/latest';

export async function ensureBinary(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<string | null> {
    const globalStorage = context.globalStorageUri.fsPath;
    const binDir = path.join(globalStorage, 'bin');

    if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
    }

    const downloadedBinaryPath = await getExtractedBinaryPath(binDir);
    const lastCheck = context.globalState.get<number>('coretrace-last-update-check') || 0;
    const now = Date.now();
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;

    // Si on a déjà vérifié récemment, on ne spamme pas l'API GitHub.
    // On retourne le binaire téléchargé s'il existe, sinon on tente de replier sur le binaire packagé.
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
        
        context.globalState.update('coretrace-last-update-check', now);

        const currentVersion = context.globalState.get<string>('coretrace-version');
        const downloadedBinaryPath = await getExtractedBinaryPath(binDir);

        if (latestVersion !== currentVersion || !downloadedBinaryPath) {
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
    const tarballPath = path.join(destDir, 'download.tar.gz');
    
    const token = process.env.GITHUB_TOKEN || '';
    const headers: any = { 'User-Agent': 'vscode-coretrace' };
    if (token) headers['Authorization'] = `token ${token}`;

    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers
    });

    const totalLength = parseInt(response.headers['content-length'], 10);
    let downloadedLength = 0;

    const writer = fs.createWriteStream(tarballPath);

    response.data.on('data', (chunk: Buffer) => {
        downloadedLength += chunk.length;
        if (totalLength) {
            const percent = Math.round((downloadedLength / totalLength) * 100);
            progress.report({ message: `${percent}%`, increment: (chunk.length / totalLength) * 100 });
        }
    });

    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });

    // Extract
    await tar.x({
        file: tarballPath,
        C: destDir,
        strip: 1 // Sometimes they bundle it under a folder like coretrace-v0.73.1-linux-amd64/ctrace. We strip first dir.
    });

    fs.unlinkSync(tarballPath);

    // Make extracted files executable if on linux/mac
    if (process.platform !== 'win32') {
        const binPath = await getExtractedBinaryPath(destDir);
        if (binPath) {
            fs.chmodSync(binPath, 0o755);
        }
    }
}

async function getExtractedBinaryPath(binDir: string): Promise<string | null> {
    const candidates = ['ctrace', 'coretrace', 'ctrace.exe', 'coretrace.exe'];
    for (const name of candidates) {
         const file = path.join(binDir, name);
         if (fs.existsSync(file)) {
             return file;
         }
    }
    return null;
}
