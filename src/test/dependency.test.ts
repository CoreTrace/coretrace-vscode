import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { checkDependencies, getInstallationScript } from '../ctrace/DependencyInstaller';
import { buildCommand, setMockWslAvailableForTesting } from '../ctrace/CommandBuilder';

suite('DependencyInstaller Test Suite', () => {
    test('getInstallationScript generates all required tool steps', () => {
        const script = getInstallationScript();
        assert.ok(script.includes('cppcheck'), 'Script should reference cppcheck');
        assert.ok(script.includes('flawfinder'), 'Script should reference flawfinder');
        assert.ok(script.includes('ikos'), 'Script should reference ikos');
        assert.ok(script.includes('tscancode'), 'Script should reference tscancode');
        assert.ok(script.includes('/opt/homebrew/bin'), 'Script should configure /opt/homebrew/bin');
        assert.ok(script.includes('.coretrace/tools'), 'Script should configure ~/.coretrace/tools');
        assert.ok(script.includes('--output-format=sarif'), 'Script should handle cppcheck SARIF compatibility');
        assert.ok(script.includes('GIT_WORK_TREE'), 'Script should sanitize GIT_WORK_TREE');
        assert.ok(script.includes('GIT_DIR'), 'Script should sanitize GIT_DIR');
        assert.ok(script.includes('apt-get'), 'Script should support Debian/Ubuntu (apt)');
        assert.ok(script.includes('dnf'), 'Script should support Fedora/RHEL (dnf)');
        assert.ok(script.includes('pacman'), 'Script should support Arch Linux (pacman)');
        assert.ok(script.includes('zypper'), 'Script should support openSUSE (zypper)');
        assert.ok(script.includes('apk'), 'Script should support Alpine (apk)');
    });

    test('checkDependencies returns structured dependency status', async () => {
        const status = await checkDependencies();
        assert.strictEqual(typeof status.allInstalled, 'boolean');
        assert.ok(Array.isArray(status.missing));
        assert.strictEqual(typeof status.details.cppcheck, 'boolean');
        assert.strictEqual(typeof status.details.flawfinder, 'boolean');
        assert.strictEqual(typeof status.details.ikos, 'boolean');
        assert.strictEqual(typeof status.details.tscancode, 'boolean');
    });

    test('checkDependencies reports missing WSL when WSL is unavailable on Windows', async () => {
        if (process.platform !== 'win32') {
            return;
        }
        setMockWslAvailableForTesting(false);
        try {
            const status = await checkDependencies();
            assert.strictEqual(status.allInstalled, false);
            assert.ok(status.missing.includes('wsl'));
        } finally {
            setMockWslAvailableForTesting(null);
        }
    });

    test('buildCommand includes tools directory and CORETRACE environment variables', async () => {
        setMockWslAvailableForTesting(true);
        const dummyBin = path.join(__dirname, 'dummy_bin');
        const dummySrc = path.join(__dirname, 'dummy_src.c');
        fs.writeFileSync(dummyBin, 'echo test');
        fs.writeFileSync(dummySrc, 'int main() { return 0; }');
        let built: { command: string; tempFiles: string[] } | undefined;
        try {
            built = await buildCommand(dummyBin, dummySrc, '--report-file=rep.json');
            let executedContent = built.command;
            if (process.platform === 'win32') {
                const shFile = built.tempFiles.find(f => f.endsWith('.sh'));
                if (shFile && fs.existsSync(shFile)) {
                    executedContent = fs.readFileSync(shFile, 'utf8');
                }
            }
            assert.ok(executedContent.includes('.coretrace/tools'), 'Command should navigate to or reference .coretrace/tools');
            assert.ok(executedContent.includes('CORETRACE_CPPCHECK_BIN'), 'Command should export CORETRACE_CPPCHECK_BIN');
            assert.ok(executedContent.includes('CORETRACE_IKOS_BIN'), 'Command should export CORETRACE_IKOS_BIN');
            assert.ok(executedContent.includes('CORETRACE_TSCANCODE_BIN'), 'Command should export CORETRACE_TSCANCODE_BIN');
            assert.ok(executedContent.includes('CORETRACE_FLAWFINDER_SCRIPT'), 'Command should export CORETRACE_FLAWFINDER_SCRIPT');
        } finally {
            setMockWslAvailableForTesting(null);
            if (built?.tempFiles) {
                for (const tf of built.tempFiles) {
                    try { fs.unlinkSync(tf); } catch {}
                }
            }
            try { fs.unlinkSync(dummyBin); } catch {}
            try { fs.unlinkSync(dummySrc); } catch {}
        }
    });
});
