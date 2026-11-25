import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCommand } from '../ctrace/AnalysisRunner';
import { buildCommand } from '../ctrace/CommandBuilder';
import { checkDependencies } from '../ctrace/DependencyInstaller';
import { CPPCHECK_RESOLVER_SH, HOMEBREW_INSTALL_SH, installErrors } from '../ctrace/ToolPaths';

const posix = process.platform !== 'win32' ? suite : suite.skip;

posix('Cppcheck resolution Test Suite', () => {
    let work = '';
    let saved: NodeJS.ProcessEnv;

    /** A fake Cppcheck reporting `version`, without --output-format=sarif support. */
    function cppcheck(dir: string, version: string): string {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'cppcheck');
        fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = "--version" ] && echo "Cppcheck ${version}"\nexit 1\n`, { mode: 0o755 });
        return file;
    }

    setup(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-cppcheck-'));
        saved = { ...process.env };
        // No Homebrew prefix, an empty home, and only our fake bin dir plus the system on PATH.
        process.env.CORETRACE_HOMEBREW_BIN = path.join(work, 'homebrew', 'bin');
        process.env.HOME = path.join(work, 'home');
        process.env.PATH = `${path.join(work, 'path')}:/usr/bin:/bin`;
        fs.mkdirSync(process.env.HOME, { recursive: true });
    });

    teardown(() => {
        process.env = saved;
        fs.rmSync(work, { recursive: true, force: true });
    });

    const resolve = () => cp.execFileSync('/bin/sh', ['-c', `${CPPCHECK_RESOLVER_SH}\ncoretrace_resolve_cppcheck`], { encoding: 'utf8' }).trim();

    test('a SARIF-capable Cppcheck on PATH is used when Homebrew has none', () => {
        const onPath = cppcheck(path.join(work, 'path'), '2.16');
        assert.strictEqual(resolve(), onPath);
    });

    test('a Homebrew Cppcheck too old for SARIF is skipped for a newer one', () => {
        cppcheck(process.env.CORETRACE_HOMEBREW_BIN!, '2.10');
        const onPath = cppcheck(path.join(work, 'path'), '2.16');
        assert.strictEqual(resolve(), onPath);
    });

    test('Homebrew comes first when it is recent enough', () => {
        const brew = cppcheck(process.env.CORETRACE_HOMEBREW_BIN!, '2.17');
        cppcheck(path.join(work, 'path'), '2.16');
        assert.strictEqual(resolve(), brew);
    });

    test('no SARIF-capable Cppcheck resolves to nothing', () => {
        cppcheck(path.join(work, 'path'), '2.10');
        assert.strictEqual(resolve(), '');
    });

    test('the dependency check and the analysis command pick the same Cppcheck', async () => {
        const onPath = cppcheck(path.join(work, 'path'), '2.16');
        const status = await checkDependencies();
        assert.strictEqual(status.details.cppcheckSarif, true);
        assert.ok(!status.missing.includes('cppcheck'), 'a Cppcheck outside /opt/homebrew/bin must count as installed');

        // A ctrace that prints the Cppcheck it was given.
        const ctrace = path.join(work, 'ctrace');
        fs.writeFileSync(ctrace, '#!/bin/sh\nprintf "%s" "$CORETRACE_CPPCHECK_BIN"\n', { mode: 0o755 });
        const { command } = await buildCommand(ctrace, path.join(work, 'main.c'), '');
        assert.strictEqual((await runCommand(command, work)).stdout, onPath);
    });
});

posix('Homebrew install Test Suite', () => {
    let work = '';
    setup(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-brew-')); });
    teardown(() => fs.rmSync(work, { recursive: true, force: true }));

    /** Runs the installer's Homebrew part with a fake brew that refuses `failing`. */
    function install(failing: string | null): string {
        const bin = path.join(work, 'bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, 'brew'), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "${failing ?? '-'}" ]; then
    echo "==> Fetching nasa-sw-vnv/core/apron"
    echo "Error: Refusing to load formula nasa-sw-vnv/core/apron: tap nasa-sw-vnv/core is not trusted." >&2
    exit 1
  fi
done
echo "==> Installed $*"
`, { mode: 0o755 });
        return cp.execFileSync('/bin/sh', ['-c', `set -e\n${HOMEBREW_INSTALL_SH}`], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, SUDO_USER: '' },
        });
    }

    test('a refused IKOS dependency is reported with Homebrew\'s own message, and the rest still installs', () => {
        const output = install('nasa-sw-vnv/core/ikos');
        const errors = installErrors(output);
        assert.strictEqual(errors.length, 1, output);
        assert.match(errors[0], /^ikos: .*Refusing to load formula nasa-sw-vnv\/core\/apron.*not trusted/);
        assert.match(output, /Installed install cppcheck/, 'a failure must not stop the other packages');
    });

    test('a successful install reports no error', () => {
        assert.deepStrictEqual(installErrors(install(null)), []);
    });
});
