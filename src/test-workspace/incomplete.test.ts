import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as AnalysisRunner from '../ctrace/AnalysisRunner';
import * as BinaryUpdater from '../ctrace/BinaryUpdater';
import { setMockWslAvailableForTesting } from '../ctrace/CommandBuilder';
import { setScanDirectoryForTesting } from '../ctraceRunner';

/** Workspace scans where ctrace exits 3 (a tool could not run) on one file. */
suite('Incomplete scans', function () {
    this.timeout(60000);

    const runner = AnalysisRunner as { runCommand: typeof AnalysisRunner.runCommand };
    const updater = BinaryUpdater as { ensureBinary: typeof BinaryUpdater.ensureBinary };
    const originalRunCommand = runner.runCommand;
    const originalEnsureBinary = updater.ensureBinary;
    let work = '';
    let root = '';
    let launched: string[] = [];

    const inputOf = (command: string) => command.match(/--input '([^']+)'/)?.[1] ?? '';
    const sarifFor = (file: string) => JSON.stringify({
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [{
            tool: { driver: { name: 'cppcheck' } },
            results: [{
                ruleId: 'partialRule', level: 'warning', message: { text: `found in ${path.basename(file)}` },
                locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: 1 } } }],
            }],
        }],
    });
    const scan = () => vscode.commands.executeCommand('ctrace.runWorkspaceAnalysis', {
        // No C tool selected: the C dependency check would wait for an answer.
        uiState: { staticTools: ['coretrace-python-analyzer'], dynamicEnabled: false },
    });
    const analysed = () => launched.filter(c => c.includes('--sarif-format')).map(c => path.basename(inputOf(c))).sort();

    suiteSetup(async () => {
        root = vscode.workspace.workspaceFolders![0].uri.fsPath;
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-incomplete-'));
        const fakeBinary = path.join(work, 'ctrace');
        fs.writeFileSync(fakeBinary, '#!/bin/sh\n', { mode: 0o755 });
        updater.ensureBinary = async () => fakeBinary;
        runner.runCommand = async (command: string) => {
            launched.push(command);
            if (!command.includes('--sarif-format')) { return { stdout: '', stderr: '', exitCode: 0 }; }
            const file = inputOf(command);
            // sample.c: findings, but tscancode could not run. app.py: complete, with findings.
            return file.endsWith('sample.c')
                ? { stdout: sarifFor(file), stderr: '[ERROR] Analysis incomplete: tscancode could not run (exit code 3)', exitCode: 3 }
                : { stdout: sarifFor(file), stderr: '', exitCode: 2 };
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

    test('the findings of an incomplete file are shown, and the file is retried on the next scan', async function () {
        if (process.platform === 'win32') { this.skip(); }
        await vscode.commands.executeCommand('ctrace.clearAnalysisCache');
        launched = [];
        await scan();
        assert.deepStrictEqual(analysed(), ['app.py', 'sample.c']);
        const diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(path.join(root, 'sample.c')))
            .filter(d => d.source?.startsWith('CoreTrace'));
        assert.strictEqual(diagnostics.length, 1, 'the available findings of the incomplete file must be shown');

        launched = [];
        await scan();
        // app.py (exit 2, complete) comes from the cache; sample.c (exit 3) is analysed again.
        assert.deepStrictEqual(analysed(), ['sample.c']);
    });
});
