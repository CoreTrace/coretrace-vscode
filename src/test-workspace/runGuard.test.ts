import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as AnalysisRunner from '../ctrace/AnalysisRunner';
import * as BinaryUpdater from '../ctrace/BinaryUpdater';
import { setMockWslAvailableForTesting } from '../ctrace/CommandBuilder';
import { setScanDirectoryForTesting } from '../ctraceRunner';

/** The Run Analysis guard, with a stubbed ctrace that can be held open. */
suite('Run Analysis guard', function () {
    this.timeout(60000);

    const runner = AnalysisRunner as { runCommand: typeof AnalysisRunner.runCommand };
    const updater = BinaryUpdater as { ensureBinary: typeof BinaryUpdater.ensureBinary };
    const originalRunCommand = runner.runCommand;
    const originalEnsureBinary = updater.ensureBinary;
    let work = '';
    let root = '';
    let launched: string[] = [];
    let gate: Promise<void> | undefined;

    const staticOff = { staticEnabled: false, staticTools: [], dynamicEnabled: false, dynamicTools: [] };
    const run = (filePath: string, uiState: object = staticOff) =>
        vscode.commands.executeCommand('ctrace.runAnalysis', { filePath, uiState });
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    suiteSetup(async () => {
        root = vscode.workspace.workspaceFolders![0].uri.fsPath;
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-guard-'));
        const fakeBinary = path.join(work, 'ctrace');
        fs.writeFileSync(fakeBinary, '#!/bin/sh\n', { mode: 0o755 });
        updater.ensureBinary = async () => fakeBinary;
        runner.runCommand = async (command: string) => {
            launched.push(command);
            if (gate) { await gate; }
            return { stdout: '', stderr: '', exitCode: 0 };
        };
        setMockWslAvailableForTesting(true);
        setScanDirectoryForTesting(path.join(work, 'scan'));
        await vscode.extensions.getExtension('CoreTrace.coretrace')!.activate();
    });

    suiteTeardown(() => {
        runner.runCommand = originalRunCommand;
        updater.ensureBinary = originalEnsureBinary;
        setMockWslAvailableForTesting(null);
        setScanDirectoryForTesting(undefined);
        fs.rmSync(work, { recursive: true, force: true });
    });

    setup(() => { launched = []; gate = undefined; });

    test('a second request while a run is active starts nothing', async () => {
        let release!: () => void;
        gate = new Promise(resolve => { release = resolve; });
        const first = run(path.join(root, 'sample.c'));
        await sleep(300);
        const launchedByFirst = launched.length;
        assert.ok(launchedByFirst > 0, 'the first run should have started ctrace');

        // Returns at once instead of waiting for, or racing, the first run.
        await run(path.join(root, 'sample.c'));
        assert.strictEqual(launched.length, launchedByFirst, 'the second request launched ctrace');

        release();
        await first;
    });

    test('two requests sent together run once', async () => {
        await Promise.all([run(path.join(root, 'sample.c')), run(path.join(root, 'sample.c'))]);
        const sarifRuns = launched.filter(command => command.includes('--sarif-format'));
        assert.strictEqual(sarifRuns.length, 1, launched.join('\n'));
    });

    test('a setup step that fails releases the guard, and the next run works', async () => {
        // Automatic entry points open the file: a missing one makes setup throw.
        const missing = path.join(root, 'deleted-before-setup.c');
        await run(missing, { ...staticOff, autoEntryPoints: true });
        assert.deepStrictEqual(launched, []);

        await run(path.join(root, 'sample.c'));
        assert.ok(launched.length > 0, 'the guard stayed taken after the failed setup');
    });
});
