import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadAndExtract, extractDmg, getAssetForPlatform } from '../ctrace/BinaryUpdater';

/**
 * Proves the macOS install path on a real Mac: these tests need hdiutil and
 * ditto, so they are skipped on Linux and Windows. CI runs them on macos-latest.
 */
suite('BinaryUpdater on macOS', function () {
    this.timeout(120000);
    let work = '';

    suiteSetup(function () {
        if (process.platform !== 'darwin') { this.skip(); }
        // realpath: /var is a symlink to /private/var, and hdiutil reports the latter.
        work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-mac-')));
    });

    suiteTeardown(() => {
        if (work) { fs.rmSync(work, { recursive: true, force: true }); }
    });

    const mounted = () => cp.execFileSync('hdiutil', ['info'], { encoding: 'utf8' });

    test('a disk image with the release layout is extracted without its top-level folder', async () => {
        // Same layout as the release: one folder wrapping bin/, lib/, config/ and libexec/.
        const root = path.join(work, 'src', 'coretrace-v9.9.9-macos-arm64');
        fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(root, 'lib'));
        fs.mkdirSync(path.join(root, 'config'));
        fs.mkdirSync(path.join(root, 'libexec', 'coretrace'), { recursive: true });
        fs.writeFileSync(path.join(root, 'bin', 'ctrace'), '#!/bin/sh\necho fake-ctrace\n', { mode: 0o755 });
        fs.writeFileSync(path.join(root, 'lib', 'libLLVM.1.dylib'), 'lib');
        fs.symlinkSync('libLLVM.1.dylib', path.join(root, 'lib', 'libLLVM.dylib'));
        fs.writeFileSync(path.join(root, 'config', 'tool-config.json'), '{}');
        fs.writeFileSync(path.join(root, 'libexec', 'coretrace', 'coretrace-python-analyzer'), '#!/bin/sh\n', { mode: 0o755 });

        const dmgDir = path.join(work, 'image');
        fs.mkdirSync(dmgDir);
        const dmg = path.join(dmgDir, 'coretrace.dmg');
        cp.execFileSync('hdiutil', ['create', '-quiet', '-srcfolder', path.join(work, 'src'), '-volname', 'CoreTrace', '-format', 'UDZO', dmg]);

        const target = path.join(work, 'extracted');
        fs.mkdirSync(target);
        await extractDmg(dmg, target);

        assert.deepStrictEqual(fs.readdirSync(target).filter(name => !name.startsWith('.')).sort(), ['bin', 'config', 'lib', 'libexec']);
        assert.strictEqual(cp.execFileSync(path.join(target, 'bin', 'ctrace'), { encoding: 'utf8' }).trim(), 'fake-ctrace');
        assert.ok(fs.lstatSync(path.join(target, 'lib', 'libLLVM.dylib')).isSymbolicLink(), 'symlinks must survive the copy');
        fs.accessSync(path.join(target, 'libexec', 'coretrace', 'coretrace-python-analyzer'), fs.constants.X_OK);
        assert.ok(!mounted().includes(dmgDir), 'the disk image must be unmounted afterwards');
    });

    test('a corrupt disk image fails cleanly and leaves nothing mounted', async () => {
        const dmgDir = path.join(work, 'broken');
        fs.mkdirSync(dmgDir);
        const dmg = path.join(dmgDir, 'coretrace.dmg');
        fs.writeFileSync(dmg, 'this is not a disk image');
        const target = path.join(work, 'broken-out');
        fs.mkdirSync(target);
        await assert.rejects(extractDmg(dmg, target));
        assert.ok(!mounted().includes(dmgDir));
    });

    test('the latest release downloads, installs and runs on Apple Silicon', async function () {
        // Downloads ~90 MB: only where asked for (CI), and only where a release exists.
        if (process.env.CORETRACE_E2E_DOWNLOAD !== '1' || process.arch !== 'arm64') { this.skip(); }
        this.timeout(600000);

        const headers: Record<string, string> = { 'User-Agent': 'vscode-coretrace-tests' };
        if (process.env.GITHUB_TOKEN) { headers.Authorization = `token ${process.env.GITHUB_TOKEN}`; }
        const response = await fetch('https://api.github.com/repos/CoreTrace/coretrace/releases/latest', { headers });
        assert.ok(response.ok, `GitHub API answered HTTP ${response.status}`);
        const release = await response.json() as { tag_name: string; assets: any[] };

        const asset = getAssetForPlatform(release.assets);
        assert.ok(asset, `no macOS file in release ${release.tag_name}`);
        assert.match(asset.name, /\.dmg$/);

        const install = path.join(work, 'install');
        fs.mkdirSync(install);
        await downloadAndExtract(asset.url, asset.name, install, { report: () => { /* no UI in tests */ } });

        const binary = path.join(install, 'bin', 'ctrace');
        assert.ok(fs.existsSync(binary), `bin/ctrace missing, got: ${fs.readdirSync(install).join(', ')}`);
        assert.ok(fs.existsSync(path.join(install, 'lib')), 'lib/ missing');
        assert.ok(fs.existsSync(path.join(install, 'libexec')), 'libexec/ missing');
        assert.deepStrictEqual(fs.readdirSync(install).filter(name => name.startsWith('tmp-')), [], 'temporary folder left behind');
        assert.ok(!mounted().includes(install), 'the disk image must be unmounted afterwards');

        // Running it proves the dylibs load from the install folder.
        const version = cp.execFileSync(binary, ['--version'], { encoding: 'utf8' });
        assert.ok(version.includes(release.tag_name.replace(/^v/, '')), `unexpected version output: ${version}`);

        // And a real analysis, the way the extension starts the stack analyzer.
        const source = path.join(work, 'sample.c');
        fs.writeFileSync(source, 'int helper(int n) { char b[64]; b[0] = (char)n; return b[0]; }\nint main(void) { return helper(1); }\n');
        const run = cp.spawnSync(binary, ['--input', source, '--invoke=ctrace_stack_analyzer'], { encoding: 'utf8', cwd: work, timeout: 120000 });
        const output = `${run.stdout}${run.stderr}`;
        assert.match(output, /Function: helper/, `analysis output:\n${output.slice(0, 2000)}`);
    });
});
