import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { dmgContentRoot, getAssetForPlatform, installStagedRelease, INSTALL_FOLDERS, recoverInterruptedUpdate } from '../ctrace/BinaryUpdater';

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

suite('BinaryUpdater release install Test Suite', () => {
    let work = '';
    setup(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-install-')); });
    teardown(() => fs.rmSync(work, { recursive: true, force: true }));

    /** A release layout whose CLI prints `label` and reads its library. */
    function layout(dir: string, label: string, folders = ['bin', 'lib', 'libexec']): void {
        for (const folder of folders) { fs.mkdirSync(path.join(dir, folder), { recursive: true }); }
        if (folders.includes('lib')) { fs.writeFileSync(path.join(dir, 'lib', 'libcore.txt'), label); }
        if (folders.includes('libexec')) { fs.writeFileSync(path.join(dir, 'libexec', 'tool'), label); }
        if (folders.includes('bin')) {
            fs.writeFileSync(path.join(dir, 'bin', 'ctrace'),
                `#!/bin/sh\nprintf '%s+' '${label}'; cat "$(dirname "$0")/../lib/libcore.txt"\n`, { mode: 0o755 });
        }
    }

    const posix = process.platform !== 'win32';
    const run = (dest: string) => cp.execFileSync(path.join(dest, 'bin', 'ctrace'), { encoding: 'utf8' });
    const leftovers = (dest: string) => fs.readdirSync(dest).filter(name => name.startsWith('previous-'));

    test('a release without a CLI leaves the installed one untouched', async () => {
        const dest = path.join(work, 'install');
        const staged = path.join(work, 'staged');
        layout(dest, 'old');
        layout(staged, 'new', ['bin', 'lib']);
        fs.unlinkSync(path.join(staged, 'bin', 'ctrace'));

        await assert.rejects(installStagedRelease(staged, dest), /installed version was kept/);
        assert.strictEqual(fs.readFileSync(path.join(dest, 'lib', 'libcore.txt'), 'utf8'), 'old');
        if (posix) { assert.strictEqual(run(dest), 'old+old'); }
        assert.deepStrictEqual(leftovers(dest), []);
    });

    test('a failure partway through puts the previous release back', async () => {
        const dest = path.join(work, 'install');
        const staged = path.join(work, 'staged');
        layout(dest, 'old');
        layout(staged, 'new');
        // The new bin/ goes in, then moving the new lib/ fails.
        const failingRename = async (from: string, to: string) => {
            if (from === path.join(staged, 'lib')) { throw new Error('disk full'); }
            await fs.promises.rename(from, to);
        };

        await assert.rejects(installStagedRelease(staged, dest, failingRename), /disk full.*kept/);
        assert.strictEqual(fs.readFileSync(path.join(dest, 'lib', 'libcore.txt'), 'utf8'), 'old');
        assert.strictEqual(fs.readFileSync(path.join(dest, 'libexec', 'tool'), 'utf8'), 'old');
        if (posix) { assert.strictEqual(run(dest), 'old+old', 'the old CLI must run with its own libraries'); }
        assert.deepStrictEqual(leftovers(dest), []);
    });

    test('a successful install replaces every folder, including ones the new release drops', async () => {
        const dest = path.join(work, 'install');
        const staged = path.join(work, 'staged');
        layout(dest, 'old');
        layout(staged, 'new', ['bin', 'lib']);

        const binary = await installStagedRelease(staged, dest);
        assert.strictEqual(binary, path.join(dest, 'bin', 'ctrace'));
        if (posix) { assert.strictEqual(run(dest), 'new+new'); }
        assert.ok(!fs.existsSync(path.join(dest, 'libexec')), 'no folder of the old release may stay behind');
        assert.deepStrictEqual(leftovers(dest), []);
    });

    test('a CLI shipped at the root of the archive is installed in bin/', async () => {
        const dest = path.join(work, 'install');
        const staged = path.join(work, 'staged');
        fs.mkdirSync(staged, { recursive: true });
        fs.writeFileSync(path.join(staged, 'ctrace'), '#!/bin/sh\n', { mode: 0o755 });
        assert.strictEqual(await installStagedRelease(staged, dest), path.join(dest, 'bin', 'ctrace'));
    });

    test('an update interrupted after moving the old release aside is rolled back at the next start', async () => {
        const dest = path.join(work, 'install');
        layout(path.join(dest, 'previous-1'), 'old');
        // Killed after the new lib/ went in, before the new bin/.
        fs.mkdirSync(path.join(dest, 'lib'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'lib', 'libcore.txt'), 'new');

        await recoverInterruptedUpdate(dest);
        assert.strictEqual(fs.readFileSync(path.join(dest, 'lib', 'libcore.txt'), 'utf8'), 'old');
        if (posix) { assert.strictEqual(run(dest), 'old+old'); }
        assert.deepStrictEqual(leftovers(dest), []);
    });

    test('a moved-aside release is only deleted when the current one is complete', async () => {
        const dest = path.join(work, 'install');
        layout(dest, 'new');
        layout(path.join(dest, 'previous-1'), 'old');
        await recoverInterruptedUpdate(dest);
        if (posix) { assert.strictEqual(run(dest), 'new+new'); }
        assert.deepStrictEqual(leftovers(dest), []);
    });
});
