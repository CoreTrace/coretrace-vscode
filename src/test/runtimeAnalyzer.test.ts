import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateConfigFileIfNeeded } from '../ctraceRunner';
import { BUNDLED_RUNTIME_ANALYZER, configuredRuntimeAnalyzer, isRuntimeAnalyzerAvailable, requestsDynamicAnalysis } from '../ctrace/RuntimeAnalyzer';

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
        isRuntimeAnalyzerAvailable({ binary: ctrace(), distro: null }, configured, shell);
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
    });

    test('a shell that cannot start means no dynamic analysis', async () => {
        const failing = async () => { throw new Error('no shell'); };
        assert.strictEqual(await isRuntimeAnalyzerAvailable({ binary: ctrace(), distro: null }, undefined, failing), false);
    });

    test('the configured path is read from the ctrace configuration file', () => {
        const config = path.join(work, 'config.json');
        assert.strictEqual(configuredRuntimeAnalyzer(undefined), undefined);
        assert.strictEqual(configuredRuntimeAnalyzer(config), undefined);
        fs.writeFileSync(config, JSON.stringify({ tools: { 'coretrace-runtime-analyzer': { path: '/opt/rt/bin/runtime-analyzer' } } }));
        assert.strictEqual(configuredRuntimeAnalyzer(config), '/opt/rt/bin/runtime-analyzer');
        fs.writeFileSync(config, '{ not json');
        assert.strictEqual(configuredRuntimeAnalyzer(config), undefined);
    });

    test('dynamic analysis is requested unless turned off or deselected', () => {
        assert.strictEqual(requestsDynamicAnalysis({}), true);
        assert.strictEqual(requestsDynamicAnalysis({ dynamicTools: ['coretrace-runtime-analyzer'] }), true);
        assert.strictEqual(requestsDynamicAnalysis({ dynamicEnabled: false }), false);
        assert.strictEqual(requestsDynamicAnalysis({ dynamicTools: [] }), false);
        assert.strictEqual(requestsDynamicAnalysis({ dynamicTools: null }), true, 'like buildCtraceArgs, a non-array is the default');
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
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(run, 'utf8')).analysis, { invoke: [], dynamic: false });
    });
});
