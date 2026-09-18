import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { checkDependencies, getInstallationScript } from '../ctrace/DependencyInstaller';
import { buildCommand } from '../ctrace/CommandBuilder';

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

    test('buildCommand includes tools directory and CORETRACE environment variables', async () => {
        const dummyBin = path.join(__dirname, 'dummy_bin');
        const dummySrc = path.join(__dirname, 'dummy_src.c');
        fs.writeFileSync(dummyBin, 'echo test');
        fs.writeFileSync(dummySrc, 'int main() { return 0; }');
        try {
            const built = await buildCommand(dummyBin, dummySrc, '--report-file=rep.json');
            assert.ok(built.command.includes('.coretrace/tools'), 'Command should navigate to or reference .coretrace/tools');
            assert.ok(built.command.includes('CORETRACE_CPPCHECK_BIN'), 'Command should export CORETRACE_CPPCHECK_BIN');
            assert.ok(built.command.includes('CORETRACE_IKOS_BIN'), 'Command should export CORETRACE_IKOS_BIN');
            assert.ok(built.command.includes('CORETRACE_TSCANCODE_BIN'), 'Command should export CORETRACE_TSCANCODE_BIN');
            assert.ok(built.command.includes('CORETRACE_FLAWFINDER_SCRIPT'), 'Command should export CORETRACE_FLAWFINDER_SCRIPT');
        } finally {
            try { fs.unlinkSync(dummyBin); } catch {}
            try { fs.unlinkSync(dummySrc); } catch {}
        }
    });
});
