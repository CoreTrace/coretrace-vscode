import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildWindowsCommandForTesting, executionDistro, setMockWslAvailableForTesting, setWslExecForTesting } from '../ctrace/CommandBuilder';
import { shellQuoteArgs } from '../ctraceRunner';

/**
 * The two Windows execution branches, on any platform, with a fake wsl.exe:
 * a source in a WSL distribution (UNC path), and a Windows source run through
 * a temporary copy of the CLI.
 */
suite('WSL command Test Suite', () => {
    let work = '';
    let built: { command: string; tempFiles: string[] } | undefined;

    /** wslpath and the distribution list, as wsl.exe answers them. */
    const fakeWsl = (args: string[]) => {
        if (args[0] === '-l') { return '  NAME      STATE           VERSION\n* Ubuntu    Running         2\n  Debian    Stopped         2\n'; }
        if (args.includes('wslpath')) {
            const target = args[args.length - 1].replace(/\\/g, '/');
            const unc = target.match(/^\/\/wsl(?:\$|\.localhost)\/[^/]+(\/.*)$/i);
            if (unc) { return unc[1]; }
            return target.replace(/^([a-zA-Z]):/, (_m, drive: string) => `/mnt/${drive.toLowerCase()}`);
        }
        return '';
    };

    setup(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-wsl-'));
        setMockWslAvailableForTesting(true);
        setWslExecForTesting(fakeWsl);
        built = undefined;
    });

    teardown(() => {
        for (const file of built?.tempFiles ?? []) { fs.rmSync(file, { force: true }); }
        setMockWslAvailableForTesting(null);
        setWslExecForTesting(null);
        fs.rmSync(work, { recursive: true, force: true });
    });

    const script = () => fs.readFileSync(built!.tempFiles.find(file => file.endsWith('.sh'))!, 'utf8');
    const ctrace = () => {
        const file = path.join(work, 'ctrace');
        fs.writeFileSync(file, 'binary');
        return file;
    };

    test('a Windows path with spaces stays one argument through the temporary-copy branch', async () => {
        const args = ['--report-file=C:\\My Project\\report.json', '--compile-commands=C:\\My Project\\build\\compile_commands.json', '--static'];
        built = await buildWindowsCommandForTesting(ctrace(), 'C:\\My Project\\src\\main.c', shellQuoteArgs(args));
        const text = script();
        assert.ok(text.includes("'--report-file=/mnt/c/My Project/report.json'"), text);
        assert.ok(text.includes("'--compile-commands=/mnt/c/My Project/build/compile_commands.json'"), text);
        assert.ok(text.includes("--input '/mnt/c/My Project/src/main.c'"), text);
        assert.match(built.command, /^wsl --exec sh "/);
    });

    test('a source inside a WSL distribution with spaces runs in that distribution', async () => {
        const args = ['--report-file=C:\\My Project\\report.json'];
        built = await buildWindowsCommandForTesting(ctrace(), '\\\\wsl$\\Debian\\home\\me\\My Project\\main.c', shellQuoteArgs(args));
        const text = script();
        assert.ok(text.includes("--input '/home/me/My Project/main.c'"), text);
        assert.ok(text.includes("'--report-file=/mnt/c/My Project/report.json'"), text);
        assert.match(built.command, /^wsl -d "Debian" --exec sh "/, 'the non-default distribution must be used');
    });

    test('the analyzers are checked in the distribution that runs the scan', () => {
        // Debian is not the default: a scan of its files runs, and must be checked, there.
        assert.strictEqual(executionDistro('\\\\wsl$\\Debian\\home\\me\\main.c'), 'Debian');
        assert.strictEqual(executionDistro('\\\\wsl.localhost\\debian\\home\\me\\main.c'), 'Debian');
        // The default distribution, an ordinary Windows path, or an unknown distribution keep the default (null).
        assert.strictEqual(executionDistro('\\\\wsl$\\Ubuntu\\home\\me\\main.c'), null);
        assert.strictEqual(executionDistro('C:\\My Project\\main.c'), null);
        assert.strictEqual(executionDistro('\\\\wsl$\\Arch\\home\\me\\main.c'), null);
        assert.strictEqual(executionDistro(undefined), null);
    });

    test('without wsl.exe, the default distribution is kept', () => {
        setWslExecForTesting(() => { throw new Error('wsl.exe not found'); });
        assert.strictEqual(executionDistro('\\\\wsl$\\Debian\\home\\me\\main.c'), null);
    });

    test('an unsafe argument is still rejected, and leaves no temporary copy behind', async () => {
        const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('ctrace-bin-')));
        await assert.rejects(
            buildWindowsCommandForTesting(ctrace(), 'C:\\src\\main.c', shellQuoteArgs(['--report-file=C:\\x;rm -rf ~'])),
            /Unsafe CLI parameter rejected/
        );
        const after = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('ctrace-bin-') && !before.has(name));
        assert.deepStrictEqual(after, [], 'the temporary CLI copy must be removed');
    });
});
