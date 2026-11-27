import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as AnalysisRunner from '../ctrace/AnalysisRunner';
import { FindingsStore } from '../ctrace/FindingsStore';
import * as BinaryUpdater from '../ctrace/BinaryUpdater';
import { setMockWslAvailableForTesting } from '../ctrace/CommandBuilder';
import { BUNDLED_RUNTIME_ANALYZER } from '../ctrace/RuntimeAnalyzer';
import { setScanDirectoryForTesting } from '../ctraceRunner';

/** Run Analysis with dynamic analysis requested, with and without the runtime analyzer. */
suite('Run Analysis and the runtime analyzer', function () {
    this.timeout(60000);

    const runner = AnalysisRunner as { runCommand: typeof AnalysisRunner.runCommand };
    const updater = BinaryUpdater as { ensureBinary: typeof BinaryUpdater.ensureBinary };
    const originalRunCommand = runner.runCommand;
    const originalEnsureBinary = updater.ensureBinary;
    let work = '';
    let fakeBinary = '';
    let launched: string[] = [];
    const configs = new Map<string, string>();
    const originalPath = process.env.PATH;

    const posix = process.platform !== 'win32';
    const run = (uiState: object) => vscode.commands.executeCommand('ctrace.runAnalysis', {
        filePath: path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'sample.c'),
        uiState,
    });
    // Static tools off: the C dependency check would wait for an answer.
    const dynamicOnly = { staticEnabled: false, staticTools: [], dynamicEnabled: true, dynamicTools: ['coretrace-runtime-analyzer'] };
    const sarifRun = () => launched.find(command => command.includes('--sarif-format')) ?? '';

    suiteSetup(async function () {
        // The fixture needs a POSIX shell and symlinks.
        if (!posix) { this.skip(); }
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-dyn-'));
        fakeBinary = path.join(work, 'release', 'bin', 'ctrace');
        fs.mkdirSync(path.dirname(fakeBinary), { recursive: true });
        fs.writeFileSync(fakeBinary, '#!/bin/sh\n', { mode: 0o755 });
        updater.ensureBinary = async () => fakeBinary;
        runner.runCommand = async (command: string) => {
            launched.push(command);
            // The run's config is deleted once ctrace ends: keep what it said.
            const config = command.match(/'--config=([^']+)'/)?.[1];
            if (config && fs.existsSync(config)) { configs.set(command, fs.readFileSync(config, 'utf8')); }
            return { stdout: '', stderr: '', exitCode: 0 };
        };
        // Only sh on PATH: a runtime analyzer installed on this machine must not count.
        const pathDir = path.join(work, 'path');
        fs.mkdirSync(pathDir);
        fs.symlinkSync('/bin/sh', path.join(pathDir, 'sh'));
        process.env.PATH = pathDir;
        setMockWslAvailableForTesting(true);
        setScanDirectoryForTesting(path.join(work, 'scan'));
        await vscode.extensions.getExtension('CoreTrace.coretrace')!.activate();
    });

    suiteTeardown(() => {
        if (!work) { return; }
        process.env.PATH = originalPath;
        runner.runCommand = originalRunCommand;
        updater.ensureBinary = originalEnsureBinary;
        setMockWslAvailableForTesting(null);
        setScanDirectoryForTesting(undefined);
        fs.rmSync(work, { recursive: true, force: true });
    });

    setup(() => { launched = []; configs.clear(); });

    test('without the runtime analyzer, the run goes on without --dyn', async () => {
        await run({ ...dynamicOnly, staticEnabled: true, staticTools: ['ctrace_stack_analyzer'] });
        assert.ok(sarifRun(), 'the analysis must still run');
        assert.ok(!sarifRun().includes("'--dyn'"), sarifRun());
    });

    test('without the runtime analyzer and with the static tools off, nothing runs', async () => {
        await run(dynamicOnly);
        assert.strictEqual(sarifRun(), '', 'a run with no tool would report a clean result');
    });

    test('with the runtime analyzer of the release, --dyn is passed', async () => {
        const bundled = path.join(path.dirname(fakeBinary), BUNDLED_RUNTIME_ANALYZER);
        fs.mkdirSync(path.dirname(bundled), { recursive: true });
        fs.writeFileSync(bundled, '#!/bin/sh\n', { mode: 0o755 });
        try {
            await run(dynamicOnly);
            assert.ok(sarifRun().includes("'--dyn'"), sarifRun());
        } finally {
            fs.rmSync(path.join(work, 'release', 'libexec'), { recursive: true, force: true });
        }
    });

    test('with dynamic analysis turned off, static-only runs are unchanged', async () => {
        await run({ ...dynamicOnly, dynamicEnabled: false, staticEnabled: true, staticTools: ['ctrace_stack_analyzer'] });
        assert.ok(sarifRun(), 'the analysis must run');
        assert.ok(!sarifRun().includes("'--dyn'"));
    });

    test('a config file asking for dynamic analysis does not bring the missing analyzer back', async () => {
        const userConfig = path.join(work, 'user-config.json');
        fs.writeFileSync(userConfig, JSON.stringify({ analysis: { dynamic: true, invoke: ['coretrace-runtime-analyzer', 'cppcheck'] } }));
        await run({ ...dynamicOnly, staticEnabled: true, staticTools: ['ctrace_stack_analyzer'], configFile: userConfig });
        const config = JSON.parse(configs.get(sarifRun()) ?? '{}');
        assert.strictEqual(config.analysis?.dynamic, false, sarifRun());
        assert.deepStrictEqual(config.analysis?.invoke, ['cppcheck']);
        assert.ok(fs.readFileSync(userConfig, 'utf8').includes('"dynamic":true'), "the user's file is left as it was");
    });

    test('BOM-prefixed config-only selection keeps the static scan and its config-relative paths', async () => {
        const userConfig = path.join(work, 'config.json');
        const userData = {
            analysis: { dynamic_analysis: true, invoke: 'ctrace_stack_analyzer' },
            files: { compile_commands: 'db.json' },
            stack_analyzer: { 'buffer-model': 'models/buffers.json' },
        };
        const original = '\uFEFF' + JSON.stringify(userData);
        fs.writeFileSync(userConfig, original);
        await run({ staticEnabled: false, dynamicEnabled: false, configFile: userConfig });
        assert.ok(sarifRun(), 'the config selects a runnable C analyzer');
        const config = JSON.parse(configs.get(sarifRun())!);
        assert.deepStrictEqual(config.analysis, { dynamic: false, invoke: 'ctrace_stack_analyzer' });
        assert.strictEqual(config.files.compile_commands, path.join(work, 'db.json'));
        assert.strictEqual(config.stack_analyzer['buffer-model'], path.join(work, 'models/buffers.json'));
        assert.strictEqual(fs.readFileSync(userConfig, 'utf8'), original);
    });

    test('the static fallback keeps automatically detected entry points', async () => {
        const point = new vscode.Position(0, 0);
        const symbol = new vscode.DocumentSymbol('review_entry', '', vscode.SymbolKind.Function,
            new vscode.Range(point, point), new vscode.Range(point, point));
        const provider = vscode.languages.registerDocumentSymbolProvider({ scheme: 'file', pattern: '**/sample.c' }, {
            provideDocumentSymbols: () => [symbol],
        });
        try {
            await run({ ...dynamicOnly, staticEnabled: true, staticTools: ['ctrace_stack_analyzer'], autoEntryPoints: true });
            assert.match(sarifRun(), /--entry-points=[^']*review_entry/);
        } finally {
            provider.dispose();
        }
    });

    test('in a mixed workspace, Python files still run when no C tool remains', async () => {
        await vscode.commands.executeCommand('ctrace.clearAnalysisCache');
        const launch = runner.runCommand;
        const save = FindingsStore.prototype.save;
        const notes: (string | undefined)[] = [];
        FindingsStore.prototype.save = function (report, savedAt, coverageNote) {
            notes.push(coverageNote);
            return save.call(this, report, savedAt, coverageNote);
        };
        runner.runCommand = async (...args) => {
            const result = await launch(...args);
            return { ...result, stdout: '{"$schema":"sarif","version":"2.1.0","runs":[]}' };
        };
        const options = { uiState: { ...dynamicOnly, staticEnabled: true, staticTools: ['coretrace-python-analyzer'] } };
        try {
            await vscode.commands.executeCommand('ctrace.runWorkspaceAnalysis', options);
            const calls = launched.length;
            await vscode.commands.executeCommand('ctrace.runWorkspaceAnalysis', options);
            assert.strictEqual(launched.length, calls, 'unchanged Python results should come from the cache');
            assert.strictEqual(notes.length, 2);
            assert.match(notes[0] ?? '', /C\/C\+\+ files? skipped/);
            assert.strictEqual(notes[1], notes[0]);
        } finally {
            runner.runCommand = launch;
            FindingsStore.prototype.save = save;
        }
        const inputs = launched.map(command => path.basename(command.match(/--input '([^']+)'/)?.[1] ?? ''));
        assert.ok(inputs.includes('app.py'), inputs.join(', '));
        assert.ok(!inputs.includes('sample.c'), inputs.join(', '));
    });

    test('turning dynamic off afterwards scans only the selected language', async () => {
        await vscode.commands.executeCommand('ctrace.clearAnalysisCache');
        await vscode.commands.executeCommand('ctrace.runWorkspaceAnalysis', {
            uiState: { dynamicEnabled: false, staticTools: ['coretrace-python-analyzer'] },
        });
        assert.ok(launched.some(command => command.includes('app.py')));
        assert.ok(launched.every(command => !command.includes('sample.c')));
    });

    test('an unreadable config stops the scan and the next run can start', async () => {
        await run({ ...dynamicOnly, configFile: path.join(work, 'missing-config.json') });
        assert.strictEqual(launched.length, 0);
        await run({ dynamicEnabled: false, staticTools: ['ctrace_stack_analyzer'] });
        assert.ok(sarifRun());
    });

    test('a malformed tool list does not leave the extension stuck', async () => {
        await run({ ...dynamicOnly, staticEnabled: true, staticTools: ['ctrace_stack_analyzer'], dynamicTools: null });
        await run({ ...dynamicOnly, staticEnabled: true, staticTools: ['ctrace_stack_analyzer'] });
        assert.strictEqual(launched.filter(command => command.includes('--sarif-format')).length, 2);
    });
});
