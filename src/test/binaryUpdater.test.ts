import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dmgContentRoot, getAssetForPlatform, INSTALL_FOLDERS } from '../ctrace/BinaryUpdater';

// File names of the v0.85.0 release.
const RELEASE = [
    'coretrace-v0.85.0-linux-amd64.tar.gz',
    'coretrace-v0.85.0-linux-amd64.tar.gz.sha256',
    'coretrace-v0.85.0-linux-arm64.tar.gz',
    'coretrace-v0.85.0-linux-arm64.tar.gz.sha256',
    'coretrace-v0.85.0-macos-arm64.dmg',
    'coretrace-v0.85.0-macos-arm64.dmg.sha256',
].map(name => ({ name, browser_download_url: `https://example.test/${name}` }));

const pick = (platform: string, arch: string, assets = RELEASE) => getAssetForPlatform(assets, platform, arch)?.name ?? null;

suite('BinaryUpdater release asset Test Suite', () => {
    test('Apple Silicon Macs get the disk image', () => {
        assert.strictEqual(pick('darwin', 'arm64'), 'coretrace-v0.85.0-macos-arm64.dmg');
    });

    test('Intel Macs get nothing rather than a binary they cannot run', () => {
        assert.strictEqual(pick('darwin', 'x64'), null);
    });

    test('Linux gets the tarball of its CPU', () => {
        assert.strictEqual(pick('linux', 'x64'), 'coretrace-v0.85.0-linux-amd64.tar.gz');
        assert.strictEqual(pick('linux', 'arm64'), 'coretrace-v0.85.0-linux-arm64.tar.gz');
    });

    test('Windows falls back to the Linux tarball for WSL', () => {
        assert.strictEqual(pick('win32', 'x64'), 'coretrace-v0.85.0-linux-amd64.tar.gz');
    });

    test('checksum files and disk images are never picked on Linux', () => {
        const assets = [{ name: 'coretrace-linux-amd64.dmg', browser_download_url: 'u' }, { name: 'coretrace-linux-amd64.tar.gz.sha256', browser_download_url: 'u' }];
        assert.strictEqual(pick('linux', 'x64', assets), null);
    });

    test('a macOS tarball is still accepted', () => {
        const assets = [{ name: 'coretrace-darwin-arm64.tar.gz', browser_download_url: 'u' }];
        assert.strictEqual(pick('darwin', 'arm64', assets), 'coretrace-darwin-arm64.tar.gz');
    });

    test('older releases that name no CPU are still found', () => {
        const assets = [{ name: 'coretrace-linux.tar.gz', browser_download_url: 'u' }];
        assert.strictEqual(pick('linux', 'x64', assets), 'coretrace-linux.tar.gz');
    });

    test('libexec is installed with the other folders', () => {
        assert.deepStrictEqual(INSTALL_FOLDERS, ['bin', 'lib', 'config', 'libexec']);
    });

    test('the single top-level folder of a disk image is skipped', async () => {
        const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-dmg-'));
        try {
            fs.mkdirSync(path.join(mount, 'coretrace-v0.85.0-macos-arm64', 'bin'), { recursive: true });
            fs.mkdirSync(path.join(mount, '.Trashes'));
            fs.writeFileSync(path.join(mount, '.DS_Store'), '');
            assert.strictEqual(await dmgContentRoot(mount), path.join(mount, 'coretrace-v0.85.0-macos-arm64'));
        } finally {
            fs.rmSync(mount, { recursive: true, force: true });
        }
    });

    test('a disk image with bin/ at its root is used as is', async () => {
        const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-dmg-'));
        try {
            fs.mkdirSync(path.join(mount, 'bin'));
            fs.mkdirSync(path.join(mount, 'lib'));
            assert.strictEqual(await dmgContentRoot(mount), mount);
        } finally {
            fs.rmSync(mount, { recursive: true, force: true });
        }
    });
});
