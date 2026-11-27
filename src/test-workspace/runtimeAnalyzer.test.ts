import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as AnalysisRunner from '../ctrace/AnalysisRunner';
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
    const originalPath = process.env.PATH;

    const posix = process.platform !== 'win32';
    const run = (uiState: object) => vscode.commands.executeCommand('ctrace.runAnalysis', {
        filePath: path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'sample.c'),
        uiState,
    });
    // Static tools off: the C dependency check would wait for an answer.
    const dynamicOnly = { staticEnabled: false, staticTools: [], dynamicEnabled: true, dynamicTools: ['coretrace-runtime-analyzer'] };
    const sarifRun = () => launched.find(command => command.includes('--sarif-format')) ?? '';

    suiteSetup(async () => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-dyn-'));
        fakeBinary = path.join(work, 'release', 'bin', 'ctrace');
        fs.mkdirSync(path.dirname(fakeBinary), { recursive: true });
        fs.writeFileSync(fakeBinary, '#!/bin/sh\n', { mode: 0o755 });
        updater.ensureBinary = async () => fakeBinary;
        runner.runCommand = async (command: string) => {
            launched.push(command);
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
        process.env.PATH = originalPath;
        runner.runCommand = originalRunCommand;
        updater.ensureBinary = originalEnsureBinary;
        setMockWslAvailableForTesting(null);
        setScanDirectoryForTesting(undefined);
        fs.rmSync(work, { recursive: true, force: true });
    });

    setup(() => { launched = []; });

    test('without the runtime analyzer, the run goes on without --dyn', async function () {
        if (!posix) { this.skip(); }
        await run({ ...dynamicOnly, staticEnabled: true, staticTools: ['ctrace_stack_analyzer'] });
        assert.ok(sarifRun(), 'the analysis must still run');
        assert.ok(!sarifRun().includes("'--dyn'"), sarifRun());
    });

    test('without the runtime analyzer and with the static tools off, nothing runs', async function () {
        if (!posix) { this.skip(); }
        await run(dynamicOnly);
        assert.strictEqual(sarifRun(), '', 'a run with no tool would report a clean result');
    });

    test('with the runtime analyzer of the release, --dyn is passed', async function () {
        if (!posix) { this.skip(); }
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

    test('with dynamic analysis turned off, static-only runs are unchanged', async function () {
        if (!posix) { this.skip(); }
        await run({ ...dynamicOnly, dynamicEnabled: false, staticEnabled: true, staticTools: ['coretrace-python-analyzer'] });
        assert.ok(sarifRun(), 'the analysis must run');
        assert.ok(!sarifRun().includes("'--dyn'"));
    });
});
