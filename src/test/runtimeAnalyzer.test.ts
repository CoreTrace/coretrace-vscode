import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { effectiveAnalyzers, generateConfigFileIfNeeded, readCtraceConfig } from '../ctraceRunner';
import { BUNDLED_RUNTIME_ANALYZER, isRuntimeAnalyzerAvailable, RUNTIME_ANALYZER } from '../ctrace/RuntimeAnalyzer';

suite('Runtime analyzer detection Test Suite', () => {
    let work = '';
    setup(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-runtime-')); });
    teardown(() => fs.rmSync(work, { recursive: true, force: true }));

    const ctrace = () => path.join(work, 'bin', 'ctrace');
    const pathDir = () => path.join(work, 'path');
    // Runs the probe with only pathDir() on PATH, so the host's tools do not count.
    const shell = async (command: string) => ({
        code: cp.spawnSync('/bin/sh', ['-c', command], { env: { PATH: pathDir() } }).status ?? 1,
    });
    const available = (configured?: string) =>
        isRuntimeAnalyzerAvailable({ binary: ctrace(), distro: null }, configured, work, shell);
    const tool = (file: string, mode = 0o755) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '#!/bin/sh\n', { mode });
        return file;
    };
    setup(() => { tool(ctrace()); });
    const posixOnly = function (this: Mocha.Context) { if (process.platform === 'win32') { this.skip(); } };

    test('the runtime analyzer of the release is found next to ctrace', async function () {
        posixOnly.call(this);
        tool(path.join(work, 'bin', BUNDLED_RUNTIME_ANALYZER));
        assert.strictEqual(await available(), true);
    });

    test('a build tree keeps it in libexec next to ctrace', async function () {
        posixOnly.call(this);
        tool(path.join(work, 'bin', BUNDLED_RUNTIME_ANALYZER.replace('../', '')));
        assert.strictEqual(await available(), true);
    });

    test('a bundled file that is not executable, or a directory, does not count', async function () {
        posixOnly.call(this);
        tool(path.join(work, 'bin', BUNDLED_RUNTIME_ANALYZER), 0o644);
        fs.mkdirSync(path.join(work, 'bin', BUNDLED_RUNTIME_ANALYZER.replace('../', '')), { recursive: true });
        assert.strictEqual(await available(), false);
    });

    test('without it, one on PATH is used', async function () {
        posixOnly.call(this);
        assert.strictEqual(await available(), false);
        tool(path.join(pathDir(), 'coretrace-runtime-analyzer'));
        assert.strictEqual(await available(), true);
    });

    test('a configured path replaces the default lookup', async function () {
        posixOnly.call(this);
        tool(path.join(work, 'bin', BUNDLED_RUNTIME_ANALYZER));
        assert.strictEqual(await available(path.join(work, 'missing')), false);
        assert.strictEqual(await available(tool(path.join(work, 'custom', 'analyzer'))), true);
        assert.strictEqual(await available('my-analyzer'), false);
        tool(path.join(pathDir(), 'my-analyzer'));
        assert.strictEqual(await available('my-analyzer'), true);
        tool(path.join(pathDir(), 'test'));
        assert.strictEqual(await available('test'), true, 'ctrace resolves a configured executable even if sh has a builtin of that name');
    });

    test('relative paths use the tools directory and fall back to the analysis cwd', async function () {
        posixOnly.call(this);
        const previousHome = process.env.HOME;
        process.env.HOME = work;
        try {
            const target = { binary: ctrace(), distro: null };
            tool(path.join(work, 'fallback-tool'));
            assert.ok(await isRuntimeAnalyzerAvailable(target, './fallback-tool', work));
            tool(path.join(work, '.coretrace', 'tools', 'bin', 'relative-tool'));
            assert.ok(await isRuntimeAnalyzerAvailable(target, './bin/relative-tool', work));
            assert.strictEqual(await isRuntimeAnalyzerAvailable(target, './fallback-tool', work), false);
        } finally {
            if (previousHome === undefined) { delete process.env.HOME; } else { process.env.HOME = previousHome; }
        }
    });

    test('a shell that cannot start means no dynamic analysis', async () => {
        const failing = async () => { throw new Error('no shell'); };
        assert.strictEqual(await isRuntimeAnalyzerAvailable({ binary: ctrace(), distro: null }, undefined, work, failing), false);
    });

    test('the configured path is read from the ctrace configuration file', () => {
        const config = path.join(work, 'config.json');
        const configuredRuntimeAnalyzer = (file?: string) => effectiveAnalyzers({}, readCtraceConfig(file)).runtimePath;
        assert.strictEqual(configuredRuntimeAnalyzer(undefined), undefined);
        assert.throws(() => configuredRuntimeAnalyzer(config), /Could not read ctrace configuration/);
        fs.writeFileSync(config, JSON.stringify({ tools: { 'coretrace-runtime-analyzer': { path: '/opt/rt/bin/runtime-analyzer' } } }));
        assert.strictEqual(configuredRuntimeAnalyzer(config), '/opt/rt/bin/runtime-analyzer');
        fs.writeFileSync(config, '{ not json');
        assert.throws(() => configuredRuntimeAnalyzer(config), /Could not read ctrace configuration/);
    });

    test('preflight uses the tool flags and config precedence that ctrace uses', () => {
        const off = { staticEnabled: false, dynamicEnabled: false };
        assert.strictEqual(effectiveAnalyzers({}, {}).runtime, true);
        assert.strictEqual(effectiveAnalyzers({ dynamicTools: [] }, {}).runtime, false);
        assert.strictEqual(effectiveAnalyzers(off, { analysis: { dynamic_analysis: true } }).runtime, true);
        assert.strictEqual(effectiveAnalyzers(off, { analysis: { static_analysis: true } }).static, true);
        const config = { invoke: RUNTIME_ANALYZER };
        assert.strictEqual(effectiveAnalyzers(off, config).runtime, true);
        assert.strictEqual(effectiveAnalyzers({ ...off, invokedTools: ['cppcheck'] }, config).runtime, false);
        assert.strictEqual(effectiveAnalyzers(off, { ...config, analysis: { invoke: [] } }).runtime, false);
        assert.strictEqual(effectiveAnalyzers(off, { analysis: { invoke: 'coretrace-python-analyzer' } }).static, false);
    });

    test('a run without the runtime analyzer turns it off in a copy of the user config', () => {
        const user = path.join(work, 'user.json');
        const run = path.join(work, 'run.json');
        assert.strictEqual(generateConfigFileIfNeeded(run, { skipRuntimeAnalyzer: true }), false, 'no config, nothing to write');
        fs.writeFileSync(user, JSON.stringify({ analysis: { dynamic: false, invoke: 'cppcheck' } }));
        assert.strictEqual(generateConfigFileIfNeeded(run, { skipRuntimeAnalyzer: true, configFile: user }), false, 'already off');
        fs.writeFileSync(user, JSON.stringify({ analysis: { invoke: 'coretrace-runtime-analyzer' } }));
        assert.strictEqual(generateConfigFileIfNeeded(run, { configFile: user }), false, 'only when asked');
        assert.strictEqual(generateConfigFileIfNeeded(run, { skipRuntimeAnalyzer: true, configFile: user }), true);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(run, 'utf8')).analysis, { invoke: [] });
    });
});
