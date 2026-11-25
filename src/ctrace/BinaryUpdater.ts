import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as tar from 'tar';
import * as cp from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import { locateBinary, locateBinaryOnPath } from './BinaryLocator';

const execFileAsync = promisify(cp.execFile);

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
    await recoverInterruptedUpdate(binDir);

    const downloadedBinaryPath = await getExtractedBinaryPath(binDir);
    const lastCheck = context.globalState.get<number>('coretrace-last-update-check') || 0;
    const lastFailedCheck = context.globalState.get<number>('coretrace-last-failed-update-check') || 0;
    const now = Date.now();
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;
    const FAILURE_BACKOFF = 60 * 1000;

    // If we have a cached binary and checked recently, avoid spamming the GitHub API.
    // A PATH binary counts too: platforms without a release asset (macOS) would otherwise hit the API on every scan.
    const knownBinary = downloadedBinaryPath ?? await locateBinaryOnPath();
    if (knownBinary && now - lastCheck < TWELVE_HOURS) {
        return knownBinary;
    }

    // When there is no cached binary, keep retrying with a short backoff.
    // This avoids a 12-hour lockout if the very first download fails.
    if (!downloadedBinaryPath && now - lastFailedCheck < FAILURE_BACKOFF) {
        output.appendLine('Skipping update check due to recent failure backoff.');
        return await locateBinaryOnPath();
    }

    try {
        const response = await fetch(REPO_LATEST_RELEASE_URL, {
            headers: { 'User-Agent': 'vscode-coretrace' },
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) {
            throw new Error(`Failed to check releases: HTTP ${response.status}`);
        }
        const release = await response.json() as { tag_name: string; assets: any[] };
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
                    await downloadAndExtract(assetInfo.url, assetInfo.name, binDir, progress);
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

    // Bundled was already checked at the top; last resort is a user-installed ctrace.
    return await locateBinaryOnPath();
}

const ARCHIVE_EXTENSIONS: Record<string, string[]> = {
    // macOS releases ship a disk image; hdiutil is always available there.
    'darwin': ['.dmg', '.tar.gz'],
};
const KNOWN_ARCHS = ['amd64', 'x86_64', 'x64', 'arm64', 'aarch64'];

/**
 * Picks the release file for a platform. A file built for another CPU is
 * never returned: it would download fine and then fail to run.
 */
export function getAssetForPlatform(
    assets: any[],
    platform: string = process.platform,
    nodeArch: string = process.arch
): { name: string; url: string } | null {
    const osMap: Record<string, string[]> = {
        'win32': ['windows', 'linux'], // Windows executes via WSL, so fall back to linux if no native windows binary exists
        'linux': ['linux'],
        'darwin': ['darwin', 'macos']
    };
    const archMap: Record<string, string[]> = {
        'x64': ['amd64', 'x86_64', 'x64'],
        'arm64': ['arm64', 'aarch64']
    };

    const osList = osMap[platform] || [platform];
    const archs = archMap[nodeArch] || [nodeArch];
    const extensions = ARCHIVE_EXTENSIONS[platform] || ['.tar.gz'];
    const isArchive = (name: string) => extensions.some(ext => name.endsWith(ext));

    for (const os of osList) {
        // First try exact matches (os + arch + archive)
        for (const asset of assets) {
            const name = String(asset.name).toLowerCase();
            if (name.includes(os) && archs.some(arch => name.includes(arch)) && isArchive(name)) {
                return { name: asset.name, url: asset.browser_download_url };
            }
        }
        // Fallback for older formats that do not name a CPU (os + archive)
        for (const asset of assets) {
            const name = String(asset.name).toLowerCase();
            if (name.includes(os) && isArchive(name) && !KNOWN_ARCHS.some(arch => name.includes(arch))) {
                return { name: asset.name, url: asset.browser_download_url };
            }
        }
    }
    return null;
}

/** Folders of the release layout. `libexec` holds helper analyzers on macOS. */
export const INSTALL_FOLDERS = ['bin', 'lib', 'config', 'libexec'];

/**
 * Copies the content of a macOS disk image into `targetDir`, without the
 * single top-level folder the release wraps everything in (like tar's strip: 1).
 */
export async function extractDmg(dmgPath: string, targetDir: string): Promise<void> {
    const mountPoint = path.join(path.dirname(dmgPath), 'mnt');
    await fs.promises.mkdir(mountPoint, { recursive: true });
    await execFileAsync('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountPoint, dmgPath]);
    try {
        const source = await dmgContentRoot(mountPoint);
        // ditto keeps symlinks and permissions, which the dylibs rely on.
        await execFileAsync('ditto', [source, targetDir]);
    } finally {
        await execFileAsync('hdiutil', ['detach', mountPoint, '-force']).catch(() => { /* already unmounted */ });
    }
}

/** The folder holding bin/, lib/…: the volume itself, or its single top-level folder. */
export async function dmgContentRoot(mountPoint: string): Promise<string> {
    const entries = await fs.promises.readdir(mountPoint, { withFileTypes: true });
    if (entries.some(entry => entry.isDirectory() && entry.name === 'bin')) { return mountPoint; }
    const folders = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
    return folders.length === 1 ? path.join(mountPoint, folders[0].name) : mountPoint;
}

export async function downloadAndExtract(url: string, assetName: string, destDir: string, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
    const timestamp = Date.now();
    
    const token = process.env.GITHUB_TOKEN || '';
    const headers: any = { 'User-Agent': 'vscode-coretrace' };
    if (token) headers['Authorization'] = `token ${token}`;

    const controller = new AbortController();
    let timeoutId = setTimeout(() => controller.abort(new Error("Download stalled")), 30000);

    let response: Response;
    try {
        response = await fetch(url, { headers, signal: controller.signal });
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }

    if (!response.ok || !response.body) {
        clearTimeout(timeoutId);
        throw new Error(`Failed to download asset: HTTP ${response.status}`);
    }

    const totalLength = parseInt(response.headers.get('content-length') || '', 10);
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

    try {
        if (assetName.toLowerCase().endsWith('.dmg')) {
            // hdiutil cannot read from a stream: save the image, then mount it.
            const dmgDir = path.join(tmpDir, 'dmg');
            await fs.promises.mkdir(dmgDir, { recursive: true });
            const dmgPath = path.join(dmgDir, 'coretrace.dmg');
            await pipeline(Readable.fromWeb(response.body as any), progressStream, fs.createWriteStream(dmgPath));
            clearTimeout(timeoutId);
            if (progressListener) { progressListener("Extracting..."); }
            await extractDmg(dmgPath, tmpDir);
        } else {
            const extractStream = tar.x({
                C: tmpDir,
                strip: 1
            });

            await pipeline(Readable.fromWeb(response.body as any), progressStream, extractStream);
        }
        clearTimeout(timeoutId);

        if (progressListener) { progressListener("Finishing..."); }

        await installStagedRelease(tmpDir, destDir);
    } finally {
        clearTimeout(timeoutId);
        try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch (e) {
            // Ignore removal errors
        }
    }
}

const BINARY_NAMES = ['ctrace', 'coretrace', 'ctrace.exe', 'coretrace.exe'];
const PREVIOUS_PREFIX = 'previous-';

type RenameFn = (from: string, to: string) => Promise<void>;

/**
 * Replaces the installed release in `destDir` with the one extracted in
 * `stagedDir`, without ever leaving a broken installation:
 * 1. the staged release is checked first: without a CLI, nothing is touched;
 * 2. the installed folders are moved aside, then the staged ones moved in;
 * 3. on any failure the new folders are removed and the old ones put back,
 *    so the previous CLI keeps running with its own libraries.
 * The moved-aside copy is deleted only once the new layout is complete, and
 * recoverInterruptedUpdate() restores it if the process dies in between.
 *
 * @param rename Replaceable in tests, to fail partway through.
 */
export async function installStagedRelease(
    stagedDir: string,
    destDir: string,
    rename: RenameFn = (from, to) => fs.promises.rename(from, to)
): Promise<string> {
    // A release can ship its CLI at the root instead of in bin/.
    for (const name of BINARY_NAMES) {
        const loose = path.join(stagedDir, name);
        if (fs.existsSync(loose)) {
            await fs.promises.mkdir(path.join(stagedDir, 'bin'), { recursive: true });
            await fs.promises.rename(loose, path.join(stagedDir, 'bin', name));
        }
    }

    const stagedBinary = BINARY_NAMES.map(name => path.join(stagedDir, 'bin', name)).find(isNonEmptyFile);
    if (!stagedBinary) {
        throw new Error('Could not find the ctrace binary inside the downloaded archive. The installed version was kept.');
    }
    if (process.platform !== 'win32') {
        await fs.promises.chmod(stagedBinary, 0o755);
    }

    const backupDir = path.join(destDir, `${PREVIOUS_PREFIX}${Date.now()}`);
    await fs.promises.mkdir(backupDir, { recursive: true });
    const movedAside: string[] = [];
    const installed: string[] = [];
    try {
        for (const folder of INSTALL_FOLDERS) {
            if (fs.existsSync(path.join(destDir, folder))) {
                await rename(path.join(destDir, folder), path.join(backupDir, folder));
                movedAside.push(folder);
            }
        }
        // Move the extracted layout (bin, lib, config, libexec) into destDir so ctrace can resolve its shared
        // libraries via INSTALL_RPATH "$ORIGIN/../lib" (Linux) or "@loader_path/../lib" (macOS)
        for (const folder of INSTALL_FOLDERS) {
            if (fs.existsSync(path.join(stagedDir, folder))) {
                await rename(path.join(stagedDir, folder), path.join(destDir, folder));
                installed.push(folder);
            }
        }
    } catch (error) {
        for (const folder of installed) {
            await fs.promises.rm(path.join(destDir, folder), { recursive: true, force: true }).catch(() => { /* best effort */ });
        }
        for (const folder of movedAside) {
            await fs.promises.rm(path.join(destDir, folder), { recursive: true, force: true }).catch(() => { /* best effort */ });
            await fs.promises.rename(path.join(backupDir, folder), path.join(destDir, folder));
        }
        await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
        throw new Error(`Could not install the new CoreTrace release (${(error as Error).message}). The installed version was kept.`);
    }

    await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => { /* deleted at the next start */ });
    return path.join(destDir, 'bin', path.basename(stagedBinary));
}

/**
 * Finishes an update interrupted between moving the old release aside and
 * deleting it: the old one is restored if the new one is not complete.
 */
export async function recoverInterruptedUpdate(destDir: string): Promise<void> {
    let entries: string[];
    try {
        entries = (await fs.promises.readdir(destDir)).filter(name => name.startsWith(PREVIOUS_PREFIX)).sort();
    } catch {
        return;
    }
    if (entries.length === 0) { return; }
    const current = BINARY_NAMES.some(name => isNonEmptyFile(path.join(destDir, 'bin', name)));
    for (const entry of entries) {
        const backupDir = path.join(destDir, entry);
        const latest = entry === entries[entries.length - 1];
        if (!current && latest) {
            for (const folder of INSTALL_FOLDERS) {
                if (fs.existsSync(path.join(backupDir, folder))) {
                    await fs.promises.rm(path.join(destDir, folder), { recursive: true, force: true });
                    await fs.promises.rename(path.join(backupDir, folder), path.join(destDir, folder));
                }
            }
        }
        await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => { /* retried at the next start */ });
    }
}

function isNonEmptyFile(file: string): boolean {
    try {
        const stat = fs.statSync(file);
        return stat.isFile() && stat.size > 0;
    } catch {
        return false;
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
