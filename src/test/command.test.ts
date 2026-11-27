import * as assert from 'assert';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { parseAndValidateParams, isWslAvailable, buildCommand, executionTarget, pathInExecutionTarget, setMockWslAvailableForTesting } from '../ctrace/CommandBuilder';
import { buildCtraceArgs, buildStackAnalyzerArgs, generateConfigFileIfNeeded, shellQuoteArgs } from '../ctraceRunner';
import { cleanFunctionName } from '../utils/functionCleaner';

suite('CommandBuilder Test Suite', () => {
    test('Validates safe parameters correctly', () => {
        const result = parseAndValidateParams('--entry-points=main --log-level=debug --all');
        assert.deepStrictEqual(result, ['--entry-points=main', '--log-level=debug', '--all']);
    });

    test('Validates comma-separated entry points correctly', () => {
        const result = parseAndValidateParams('--entry-points=main,calculate_sum,MyClass::process');
        assert.deepStrictEqual(result, ['--entry-points=main,calculate_sum,MyClass::process']);
    });

    test('Rejects entry points containing function call parentheses', () => {
        assert.throws(() => {
            parseAndValidateParams('--entry-points=main()');
        }, /Unsafe CLI parameter rejected/);
    });

    test('Throws on malicious shell injections', () => {
        const maliciousPayloads = [
            '--flag && rm -rf /',
            '-I path; ls -la',
            '--out=$(whoami)',
            '--test `cat /etc/passwd`',
            '--option | grep root'
        ];

        for (const payload of maliciousPayloads) {
            assert.throws(() => {
                parseAndValidateParams(payload);
            }, /Unsafe CLI/, `Failed to block payload: ${payload}`);
        }
    });

    test('Keeps real Windows paths: 8.3 names, spaces, parentheses, accents', () => {
        const args = [
            '--report-file=C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\scan\\.ctrace-report-1.txt',
            '--config=C:\\Users\\Jean Dupont\\Program Files (x86)\\réglages.json',
            '--entry-points=main,ns::run',
            '--static',
        ];
        assert.deepStrictEqual(parseAndValidateParams(shellQuoteArgs(args)), args);
    });

    test('Rejects shell syntax hidden in a value or a name', () => {
        for (const args of [['--config=a;b'], ['--config=a`id`'], ['--config=a|b'], ['--config=a>b'], ['--x$(id)=1'], ['--config=a&b']]) {
            assert.throws(() => parseAndValidateParams(shellQuoteArgs(args)), /Unsafe CLI/, args[0]);
        }
    });

    test('Handles empty or whitespace-only params', () => {
        assert.deepStrictEqual(parseAndValidateParams(''), []);
        assert.deepStrictEqual(parseAndValidateParams('    '), []);
    });

    test('isWslAvailable returns a boolean without throwing', () => {
        const result = isWslAvailable();
        assert.strictEqual(typeof result, 'boolean');
    });

    test('buildCommand rejects with WSL requirement error on Windows when WSL is unavailable', async () => {
        if (process.platform !== 'win32') {
            return;
        }
        setMockWslAvailableForTesting(false);
        try {
            await assert.rejects(
                () => buildCommand('dummy_bin', 'dummy_src.c', ''),
                /Windows Subsystem for Linux \(WSL\) is required/
            );
        } finally {
            setMockWslAvailableForTesting(null);
        }
    });

    test('a copied config and its command use the mount root of each WSL target', async function () {
        if (process.platform !== 'win32') { this.skip(); }
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-wsl-config-'));
        const user = path.join(work, 'user.json');
        fs.writeFileSync(user, JSON.stringify({ analysis: { dynamic: true }, files: { compile_commands: 'db.json' } }));
        const child = cp as { execFileSync: typeof cp.execFileSync };
        const exec = child.execFileSync;
        child.execFileSync = ((file: string, args: string[]) => {
            assert.strictEqual(file, 'wsl');
            if (args.includes('-l')) { return '* Ubuntu Running 2\n  Debian Running 2'; }
            if (args.includes('true')) { return ''; }
            assert.ok(args.includes('--exec') && args.includes('wslpath'));
            const root = args.includes('Debian') ? '/drives' : '/volumes';
            return Buffer.from(root + '/' + path.win32.basename(args[args.length - 1]));
        }) as typeof cp.execFileSync;
        setMockWslAvailableForTesting(true);
        try {
            for (const [name, mount] of [['Debian', '/drives'], ['Ubuntu', '/volumes']]) {
                const input = `\\\\wsl$\\${name}\\home\\main.c`;
                const target = executionTarget('C:\\tools\\ctrace', input);
                assert.strictEqual(target.distro, name === 'Ubuntu' ? null : name);
                const generated = path.join(work, name + '.json');
                assert.ok(generateConfigFileIfNeeded(generated, { configFile: user, skipRuntimeAnalyzer: true },
                    undefined, undefined, undefined, file => pathInExecutionTarget(file, target)));
                assert.strictEqual(JSON.parse(fs.readFileSync(generated, 'utf8')).files.compile_commands, mount + '/db.json');
                const built = await buildCommand('C:\\tools\\ctrace', input, shellQuoteArgs(['--config=' + generated]), false, target);
                try {
                    const script = fs.readFileSync(built.tempFiles[0], 'utf8');
                    assert.ok(script.includes(`'--config=${mount}/${name}.json'`), script);
                    assert.ok(script.includes("--input '/home/main.c'"), script);
                } finally { for (const file of built.tempFiles) { fs.unlinkSync(file); } }
            }
        } finally {
            child.execFileSync = exec;
            setMockWslAvailableForTesting(null);
            fs.rmSync(work, { recursive: true, force: true });
        }
    });

    test('buildCommand does not create temporary copies of source files', async () => {
        setMockWslAvailableForTesting(true);
        const dummyBin = path.join(__dirname, 'dummy_bin');
        const dummySrc = path.join(__dirname, 'dummy_src.c');
        fs.writeFileSync(dummyBin, 'echo test');
        fs.writeFileSync(dummySrc, 'int main() { return 0; }');
        try {
            const built = await buildCommand(dummyBin, dummySrc, '--report-file=rep.json');
            for (const tf of built.tempFiles) {
                assert.ok(!tf.includes('dummy_src'), `Input file was copied to temp: ${tf}`);
                assert.ok(!tf.includes('ctrace-input-'), `ctrace-input temp file was created: ${tf}`);
            }
            assert.ok(!built.command.includes('ctrace-input-'), 'Command references ctrace-input temp file');
        } finally {
            setMockWslAvailableForTesting(null);
            if (fs.existsSync(dummyBin)) { fs.unlinkSync(dummyBin); }
            if (fs.existsSync(dummySrc)) { fs.unlinkSync(dummySrc); }
        }
    });

    test('buildStackAnalyzerArgs includes invoke=ctrace_stack_analyzer without sarif-format', () => {
        const dummyConfig: any = {
            get: () => undefined
        };
        const args = buildStackAnalyzerArgs({
            reportFile: '/tmp/rep.json',
            entryPoints: ['main', 'doWork()'],
            compdbFast: true
        }, dummyConfig);

        assert.ok(args.includes('--invoke=ctrace_stack_analyzer'));
        assert.ok(args.includes('--entry-points=main,doWork'));
        assert.ok(!args.some(a => a.includes('--compdb-fast')));
        assert.ok(!args.some(a => a.includes('--only-dir')));
        assert.ok(!args.some(a => a.includes('--sarif-format')));
        assert.ok(!args.some(a => a.includes('--report-file')));
    });

    test('generateConfigFileIfNeeded writes directory filters and stack options to json config', () => {
        const tmpConfig = path.join(__dirname, `test-cfg-${Date.now()}.json`);
        try {
            const hasConfig = generateConfigFileIfNeeded(tmpConfig, {
                onlyDir: 'src,lib',
                excludeDir: 'vendor',
                includeStl: true,
                compdbFast: true
            });
            assert.strictEqual(hasConfig, true);
            const content = JSON.parse(fs.readFileSync(tmpConfig, 'utf8'));
            assert.deepStrictEqual(content.stack_analyzer.only_dirs, ['src', 'lib']);
            assert.deepStrictEqual(content.stack_analyzer.exclude_dirs, ['vendor']);
            assert.strictEqual(content.stack_analyzer.include_stl, true);
            assert.deepStrictEqual(content.stack_analyzer.compdb_fast, true);
        } finally {
            if (fs.existsSync(tmpConfig)) { fs.unlinkSync(tmpConfig); }
        }
    });

    test('buildCtraceArgs includes ctrace_stack_analyzer in static tools', () => {
        const dummyConfig: any = {
            get: () => undefined
        };
        // All 5 static tools selected -> should emit --static
        const allStatic = buildCtraceArgs({
            reportFile: '/tmp/rep.json',
            staticEnabled: true,
            staticTools: ['cppcheck', 'flawfinder', 'ikos', 'tscancode', 'ctrace_stack_analyzer'],
            dynamicEnabled: false,
            dynamicTools: []
        }, dummyConfig);
        assert.ok(allStatic.includes('--static'));
        assert.ok(!allStatic.some(a => a.includes('--dyn')));

        // Only stack analyzer selected under static tools -> should emit --invoke=ctrace_stack_analyzer
        const onlyStack = buildCtraceArgs({
            reportFile: '/tmp/rep.json',
            staticEnabled: true,
            staticTools: ['ctrace_stack_analyzer'],
            dynamicEnabled: false,
            dynamicTools: []
        }, dummyConfig);
        assert.ok(!onlyStack.includes('--static'));
        assert.ok(onlyStack.includes('--invoke=ctrace_stack_analyzer'));
    });
});

suite('SymbolExtractor cleanFunctionName Test Suite', () => {
    test('Sanitizes simple and signature function names', () => {
        assert.strictEqual(cleanFunctionName('main'), 'main');
        assert.strictEqual(cleanFunctionName('main()'), 'main');
        assert.strictEqual(cleanFunctionName('int main()'), 'main');
        assert.strictEqual(cleanFunctionName('int main(int argc, char** argv)'), 'main');
    });

    test('Sanitizes namespaced and class methods', () => {
        assert.strictEqual(cleanFunctionName('void MyClass::processData(int x)'), 'MyClass::processData');
        assert.strictEqual(cleanFunctionName('ns::sub::Calculator::compute()'), 'ns::sub::Calculator::compute');
    });

    test('Sanitizes functions with return types and template syntax', () => {
        assert.strictEqual(cleanFunctionName('std::vector<int> get_items()'), 'get_items');
        assert.strictEqual(cleanFunctionName('char* get_name()'), 'get_name');
        assert.strictEqual(cleanFunctionName('template<typename T> void process<T>()'), 'process');
        assert.strictEqual(cleanFunctionName('virtual void execute() const noexcept override'), 'execute');
    });

    test('Handles edge cases (empty, undefined, invalid chars)', () => {
        assert.strictEqual(cleanFunctionName(''), '');
        assert.strictEqual(cleanFunctionName('   '), '');
        assert.strictEqual(cleanFunctionName('`whoami`()'), 'whoami');
    });
});

