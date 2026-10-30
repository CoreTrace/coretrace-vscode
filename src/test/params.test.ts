import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCtraceArgs, buildStackAnalyzerArgs, generateConfigFileIfNeeded, CtraceUIState } from '../ctraceRunner';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPORT = '/tmp/report.json';

function settings(values: Record<string, unknown> = {}): any {
    return { get: (key: string, fallback?: unknown) => key in values ? values[key] : fallback };
}

function args(state: CtraceUIState, config: Record<string, unknown> = {}): string[] {
    return buildCtraceArgs({ reportFile: REPORT, ...state }, settings(config));
}

/** The `stack_analyzer` section of the generated config, or null when none is needed. */
function stackConfig(state: CtraceUIState, root: string | undefined = '/work', config: Record<string, unknown> = {}): any {
    const file = path.join(os.tmpdir(), `ctrace-params-${process.pid}-${Date.now()}-${Math.random()}.json`);
    try {
        if (!generateConfigFileIfNeeded(file, state, root, settings(config))) { return null; }
        return JSON.parse(fs.readFileSync(file, 'utf8')).stack_analyzer;
    } finally {
        fs.rmSync(file, { force: true });
    }
}

suite('Analysis parameters: command line', () => {
    const cases: { name: string; state: CtraceUIState; expected: string[] }[] = [
        { name: 'profile fast', state: { analysisProfile: 'fast' }, expected: ['--analysis-profile=fast'] },
        { name: 'profile full', state: { analysisProfile: 'full' }, expected: ['--analysis-profile=full'] },
        { name: 'entry points', state: { entryPoints: ['main', 'int helper(int)'] }, expected: ['--entry-points=main,helper'] },
        { name: 'compile commands', state: { compileCommandsPath: '/w/compile_commands.json' }, expected: ['--compile-commands=/w/compile_commands.json'] },
        { name: 'compdb deps', state: { includeCompdbDeps: true }, expected: ['--include-compdb-deps'] },
        { name: 'config file', state: { configFile: '/w/c.json' }, expected: ['--config=/w/c.json'] },
        { name: 'quiet', state: { quiet: true }, expected: ['--quiet'] },
        { name: 'timing', state: { timing: true }, expected: ['--timing'] },
        { name: 'demangle', state: { demangle: true }, expected: ['--demangle'] },
    ];
    for (const { name, state, expected } of cases) {
        test(`${name} reaches ctrace`, () => {
            const built = args(state);
            for (const arg of expected) { assert.ok(built.includes(arg), `${arg} missing from ${built.join(' ')}`); }
        });
    }

    test('options left at their default add no flag', () => {
        const built = args({ quiet: false, timing: false, demangle: false, includeCompdbDeps: false, smtEnabled: false });
        for (const flag of ['--quiet', '--timing', '--demangle', '--include-compdb-deps', '--smt', '--analysis-profile', '--compile-commands', '--config', '--entry-points']) {
            assert.ok(!built.some(arg => arg.startsWith(flag)), `unexpected ${flag}`);
        }
    });

    test('an invalid profile falls back to full', () => {
        assert.ok(args({ analysisProfile: 'turbo' as any }).includes('--analysis-profile=full'));
    });

    test('SMT options are all sent when SMT is on', () => {
        const built = args({ smtEnabled: true, smtBackend: 'z3', smtSecondaryBackend: 'cvc5', smtMode: 'portfolio', smtTimeoutMs: 500, smtRules: 'recursion' });
        for (const arg of ['--smt=on', '--smt-backend=z3', '--smt-secondary-backend=cvc5', '--smt-mode=portfolio', '--smt-timeout-ms=500', '--smt-rules=recursion']) {
            assert.ok(built.includes(arg), `${arg} missing`);
        }
    });

    test('SMT options are ignored when SMT is off', () => {
        const built = args({ smtEnabled: false, smtBackend: 'z3', smtMode: 'portfolio', smtTimeoutMs: 500, smtRules: 'recursion' });
        assert.ok(!built.some(arg => arg.startsWith('--smt')));
    });

    test('invalid SMT values fall back to safe defaults', () => {
        const built = args({ smtEnabled: true, smtBackend: 'evil' as any, smtMode: 'nope' as any, smtTimeoutMs: -1 });
        assert.ok(built.includes('--smt-backend=interval'));
        assert.ok(built.includes('--smt-mode=single'));
        assert.ok(!built.some(arg => arg.startsWith('--smt-timeout-ms')));
    });

    test('tools outside the allowed list never reach --invoke', () => {
        const built = args({ staticTools: ['cppcheck', 'rm -rf'], invokedTools: ['evil', 'flawfinder'], dynamicEnabled: false });
        assert.ok(built.includes('--invoke=cppcheck,flawfinder'));
    });

    test('turning a family of tools off removes it', () => {
        const built = args({ staticEnabled: false, dynamicEnabled: false });
        assert.ok(!built.includes('--static'));
        assert.ok(!built.includes('--dyn'));
    });

    test('VS Code settings reach ctrace', () => {
        const built = args({}, {
            compileCommandsPath: '/s/compile_commands.json',
            'models.escapeModel': '/m/escape',
            'models.bufferModel': '/m/buffer',
            'models.resourceModel': '/m/resource',
            'analysis.stackLimit': 8192,
        });
        for (const arg of ['--compile-commands=/s/compile_commands.json', '--escape-model=/m/escape', '--buffer-model=/m/buffer', '--resource-model=/m/resource', '--stack-limit=8192']) {
            assert.ok(built.includes(arg), `${arg} missing`);
        }
    });

    test('the sidebar value wins over the VS Code setting', () => {
        const built = args({ compileCommandsPath: '/ui/db.json' }, { compileCommandsPath: '/s/db.json' });
        assert.ok(built.includes('--compile-commands=/ui/db.json'));
        assert.ok(!built.includes('--compile-commands=/s/db.json'));
    });

    test('empty settings add no flag', () => {
        const built = args({}, { 'models.escapeModel': '  ', 'analysis.stackLimit': '', compileCommandsPath: '' });
        assert.ok(!built.some(arg => /--(escape-model|stack-limit|compile-commands)/.test(arg)));
    });

    test('the separate stack pass uses the same analysis options', () => {
        const state: CtraceUIState = { analysisProfile: 'fast', entryPoints: ['main'], compileCommandsPath: '/w/db.json', configFile: '/w/c.json', smtEnabled: true, smtBackend: 'z3' };
        const stack = buildStackAnalyzerArgs(state, settings({ 'analysis.stackLimit': 4096 }));
        for (const arg of ['--analysis-profile=fast', '--entry-points=main', '--compile-commands=/w/db.json', '--config=/w/c.json', '--smt=on', '--smt-backend=z3', '--stack-limit=4096']) {
            assert.ok(stack.includes(arg), `${arg} missing from ${stack.join(' ')}`);
        }
    });
});

suite('Analysis parameters: generated config', () => {
    const cases: { name: string; state: CtraceUIState; key: string; expected: unknown }[] = [
        { name: 'function filter', state: { onlyFunction: 'main, helper' }, key: 'only_functions', expected: ['main', 'helper'] },
        { name: 'macros', state: { macros: 'DEBUG,-DVERSION=2' }, key: 'defines', expected: ['DEBUG', 'VERSION=2'] },
        { name: 'compiler arguments', state: { compilerExtraArgs: '-Wall;-O1' }, key: 'compile_args', expected: ['-Wall', '-O1'] },
        { name: 'system libraries', state: { includeStl: true }, key: 'include_stl', expected: true },
        { name: 'fast compdb', state: { compdbFast: true }, key: 'compdb_fast', expected: true },
        { name: 'filter decisions', state: { dumpFilter: true }, key: 'dump_filter', expected: true },
        { name: 'warnings only', state: { warningsOnly: true }, key: 'warnings_only', expected: true },
        { name: 'cross-file on', state: { resourceCrossTu: true }, key: 'resource_cross_tu', expected: true },
        { name: 'cross-file off', state: { resourceCrossTu: false }, key: 'resource_cross_tu', expected: false },
    ];
    for (const { name, state, key, expected } of cases) {
        test(`${name} is written as ${key}`, () => {
            assert.deepStrictEqual(stackConfig(state)?.[key], expected);
        });
    }

    test('no config file is written when nothing needs one', () => {
        assert.strictEqual(stackConfig({}), null);
        assert.strictEqual(stackConfig({ includeStl: false, compdbFast: false, warningsOnly: false, onlyFunction: ' ' }), null);
    });

    test('relative directory filters are resolved from the workspace', () => {
        const config = stackConfig({ onlyDir: 'src, lib/core/', excludeDir: 'build' });
        assert.deepStrictEqual(config.only_dirs, ['/work/src', '/work/lib/core']);
        assert.deepStrictEqual(config.exclude_dirs, ['/work/build']);
    });

    test('absolute directory filters are kept', () => {
        assert.deepStrictEqual(stackConfig({ onlyDir: '/abs/src/' }).only_dirs, ['/abs/src']);
    });

    test('Windows directories are converted for WSL', () => {
        const config = stackConfig({ onlyDir: 'src', excludeDir: 'D:\\vendor\\lib' }, 'C:\\Users\\me\\proj');
        assert.deepStrictEqual(config.only_dirs, ['/mnt/c/Users/me/proj/src']);
        assert.deepStrictEqual(config.exclude_dirs, ['/mnt/d/vendor/lib']);
    });

    test('relative include directories are resolved from the workspace', () => {
        const config = stackConfig({ extraIncludes: 'include,-I/abs/inc' });
        assert.ok(config.include_dirs.includes('/work/include'));
        assert.ok(config.include_dirs.includes('/abs/inc'));
        assert.ok(config.extra_args.includes('-I/work/include'));
    });

    test('VS Code settings are written to the config', () => {
        const config = stackConfig({}, '/work', {
            'performance.compdbFast': true,
            'performance.compileIrCacheDir': '/cache/ir',
            'analysis.resourceCrossTu': 'off',
            'cache.resourceSummaryDir': '/cache/summary',
            'cache.memoryOnly': true,
        });
        assert.strictEqual(config.compdb_fast, true);
        assert.strictEqual(config.compile_ir_cache_dir, '/cache/ir');
        assert.strictEqual(config.resource_cross_tu, false);
        assert.strictEqual(config.resource_summary_cache_dir, '/cache/summary');
        assert.strictEqual(config.resource_summary_cache_memory_only, true);
    });

    test('resourceCrossTu "default" leaves the choice to ctrace', () => {
        assert.strictEqual(stackConfig({}, '/work', { 'analysis.resourceCrossTu': 'default' }), null);
    });

    test('the sidebar cross-file switch wins over the VS Code setting', () => {
        assert.strictEqual(stackConfig({ resourceCrossTu: true }, '/work', { 'analysis.resourceCrossTu': 'off' }).resource_cross_tu, true);
    });

    test('values from a user config file are kept', () => {
        const userConfig = path.join(os.tmpdir(), `ctrace-user-${process.pid}-${Date.now()}.json`);
        fs.writeFileSync(userConfig, JSON.stringify({ stack_analyzer: { jobs: 4 }, output: { verbose: true } }));
        const generated = `${userConfig}.out`;
        try {
            assert.strictEqual(generateConfigFileIfNeeded(generated, { configFile: userConfig, includeStl: true }, '/work', settings()), true);
            const content = JSON.parse(fs.readFileSync(generated, 'utf8'));
            assert.strictEqual(content.stack_analyzer.jobs, 4);
            assert.strictEqual(content.stack_analyzer.include_stl, true);
            assert.strictEqual(content.output.verbose, true);
        } finally {
            fs.rmSync(userConfig, { force: true });
            fs.rmSync(generated, { force: true });
        }
    });
});

suite('Analysis parameters: wiring between the sidebar, the runner and package.json', () => {
    const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const mainJs = read('media/main.js');
    const sidebarHtml = read('src/SidebarProvider.ts');
    const runner = read('src/ctraceRunner.ts');
    const readState = mainJs.slice(mainJs.indexOf('function readCtraceUiState()'), mainJs.indexOf('function selectedInvokeTools()'));
    const restoreState = mainJs.slice(mainJs.indexOf('function restoreUiState()'), mainJs.indexOf('function saveUiState()'));
    const stateKeys = [...readState.matchAll(/^\s+([a-zA-Z]+):/gm)].map(match => match[1]);

    test('the sidebar state is parsed correctly by this test', () => {
        assert.ok(stateKeys.length > 20, `only found ${stateKeys.join(',')}`);
    });

    test('every control read by the sidebar exists in its HTML', () => {
        const ids = [...readState.matchAll(/(?:valueOf|checked|numberValueOf)\('([^']+)'\)/g)].map(match => match[1]);
        assert.ok(ids.length > 15);
        for (const id of ids) {
            assert.ok(sidebarHtml.includes(`id="${id}"`), `no control with id "${id}"`);
        }
    });

    test('every control of the settings panel is read by the sidebar', () => {
        const panel = sidebarHtml.slice(sidebarHtml.indexOf('id="settings-view"'), sidebarHtml.indexOf('id="dashboard-results"'));
        const ids = [...panel.matchAll(/<(?:input|select)[^>]*\bid="([^"]+)"/g)].map(match => match[1]).filter(id => id !== 'settings-search');
        assert.ok(ids.length > 15);
        for (const id of ids) {
            assert.ok(readState.includes(`'${id}'`), `"${id}" is shown but never sent to the analysis`);
        }
    });

    test('every value sent by the sidebar is restored after a reload', () => {
        const derived = new Set(['scanMode', 'staticEnabled', 'dynamicEnabled', 'invokedTools']);
        for (const key of stateKeys.filter(k => !derived.has(k))) {
            assert.ok(restoreState.includes(`saved.${key}`), `${key} is lost after a reload`);
        }
    });

    test('every value sent by the sidebar is used by the runner', () => {
        const consumers = runner + read('src/extension.ts');
        // scanMode travels next to uiState, as a command argument.
        for (const key of stateKeys.filter(k => k !== 'scanMode')) {
            assert.ok(consumers.includes(`State.${key}`) || consumers.includes(`uiState?.${key}`), `${key} is sent by the sidebar but ignored by the runner`);
        }
    });

    test('every declared setting is read by the code, and the reverse', () => {
        const declared = Object.keys(JSON.parse(read('package.json')).contributes.configuration.properties)
            .map(key => key.replace(/^ctrace\./, ''));
        const sources = runner + read('src/extension.ts');
        for (const key of declared) {
            assert.ok(sources.includes(`'${key}'`), `ctrace.${key} is declared but never read`);
        }
        const readKeys = [...runner.matchAll(/config(?:String|Value|TriState)\((?:vscodeConfig|config), '([^']+)'\)/g)].map(match => match[1]);
        assert.ok(readKeys.length > 5);
        for (const key of readKeys) {
            assert.ok(declared.includes(key), `ctrace.${key} is read but not declared in package.json`);
        }
    });
});
