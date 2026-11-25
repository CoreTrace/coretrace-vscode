import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as AnalysisRunner from '../ctrace/AnalysisRunner';
import * as BinaryUpdater from '../ctrace/BinaryUpdater';
import { setMockWslAvailableForTesting } from '../ctrace/CommandBuilder';
import { IGNORE_FILE_NAME } from '../ctrace/FindingIgnoreList';
import { setScanDirectoryForTesting } from '../ctraceRunner';

/** Clear Analysis Cache, after a real Run Analysis whose ctrace reports one finding. */
suite('Clear Analysis Cache', function () {
    this.timeout(60000);

    const runner = AnalysisRunner as { runCommand: typeof AnalysisRunner.runCommand };
    const updater = BinaryUpdater as { ensureBinary: typeof BinaryUpdater.ensureBinary };
    const originalRunCommand = runner.runCommand;
    const originalEnsureBinary = updater.ensureBinary;
    let work = '';
    let root = '';
    let sample = '';
    let ignoreFile = '';
    let gate: Promise<void> | undefined;

    const sarif = () => JSON.stringify({
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [{
            tool: { driver: { name: 'cppcheck' } },
            results: [{
                ruleId: 'testRule', level: 'warning', message: { text: 'a finding to clear' },
                locations: [{ physicalLocation: { artifactLocation: { uri: sample }, region: { startLine: 1 } } }],
            }],
        }],
    });

    const diagnostics = () => vscode.languages.getDiagnostics(vscode.Uri.file(sample))
        .filter(d => d.source?.startsWith('CoreTrace'));
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const run = () => vscode.commands.executeCommand('ctrace.runAnalysis', {
        filePath: sample,
        uiState: { staticEnabled: false, staticTools: [], dynamicEnabled: false, dynamicTools: [] },
    });

    suiteSetup(async () => {
        root = vscode.workspace.workspaceFolders![0].uri.fsPath;
        sample = path.join(root, 'sample.c');
        ignoreFile = path.join(root, IGNORE_FILE_NAME);
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-clear-'));
        const fakeBinary = path.join(work, 'ctrace');
        fs.writeFileSync(fakeBinary, '#!/bin/sh\n', { mode: 0o755 });
        updater.ensureBinary = async () => fakeBinary;
        runner.runCommand = async (command: string) => {
            if (gate) { await gate; }
            // The stack pass gets nothing; the SARIF pass reports the finding.
            return { stdout: command.includes('--sarif-format') ? sarif() : '', stderr: '', exitCode: 0 };
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
        fs.rmSync(ignoreFile, { force: true });
        fs.rmSync(work, { recursive: true, force: true });
    });

    test('the Problems panel is cleared, and an ignore-list change does not bring the findings back', async function () {
        if (process.platform === 'win32') { this.skip(); }
        await run();
        assert.strictEqual(diagnostics().length, 1, 'the run should publish its finding');

        await vscode.commands.executeCommand('ctrace.clearAnalysisCache');
        assert.strictEqual(diagnostics().length, 0, 'Clear Analysis Cache must clear the Problems panel');

        // Changing the ignore list republishes the last results: there must be none left.
        fs.writeFileSync(ignoreFile, JSON.stringify({ version: 1, ignored: [{ fingerprint: 'abcdef123456' }] }));
        await sleep(1500);
        assert.strictEqual(diagnostics().length, 0, 'cleared findings came back after an ignore-list change');
    });

    test('clearing is refused while an analysis runs, so it cannot write its results back', async function () {
        if (process.platform === 'win32') { this.skip(); }
        await vscode.commands.executeCommand('ctrace.clearAnalysisCache');
        let release!: () => void;
        gate = new Promise(resolve => { release = resolve; });
        const running = run();
        await sleep(300);
        await vscode.commands.executeCommand('ctrace.clearAnalysisCache');
        release();
        gate = undefined;
        await running;
        assert.strictEqual(diagnostics().length, 1, 'the run finished with its finding, the clear was refused');

        await vscode.commands.executeCommand('ctrace.clearAnalysisCache');
        assert.strictEqual(diagnostics().length, 0);
    });
});
