import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as AnalysisRunner from '../ctrace/AnalysisRunner';
import * as BinaryUpdater from '../ctrace/BinaryUpdater';
import { setMockWslAvailableForTesting } from '../ctrace/CommandBuilder';
import { setScanDirectoryForTesting } from '../ctraceRunner';

/**
 * Runs the real "Run Analysis" command in a window with a workspace, with the
 * binary lookup and the process launcher replaced, to see what would be run.
 */
suite('Run Analysis with requested settings', function () {
    this.timeout(60000);

    const runner = AnalysisRunner as { runCommand: typeof AnalysisRunner.runCommand };
    const updater = BinaryUpdater as { ensureBinary: typeof BinaryUpdater.ensureBinary };
    const originalRunCommand = runner.runCommand;
    const originalEnsureBinary = updater.ensureBinary;
    let launched: { command: string; config: any }[] = [];
    let work = '';

    suiteSetup(async () => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-run-'));
        const fakeBinary = path.join(work, 'ctrace');
        fs.writeFileSync(fakeBinary, '#!/bin/sh\n', { mode: 0o755 });
        updater.ensureBinary = async () => fakeBinary;
        runner.runCommand = async (command: string) => {
            // Read the config now: the run deletes it once finished.
            const configPath = command.match(/--config=([^'"\s]+)/)?.[1];
            const config = configPath && fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null;
            launched.push({ command, config });
            return { stdout: '', stderr: '', exitCode: 0 };
        };
        // Windows runs ctrace through WSL; the command is built but never run here.
        setMockWslAvailableForTesting(true);
        await vscode.extensions.getExtension('CoreTrace.coretrace')!.activate();
    });

    suiteTeardown(() => {
        runner.runCommand = originalRunCommand;
        updater.ensureBinary = originalEnsureBinary;
        setMockWslAvailableForTesting(null);
        setScanDirectoryForTesting(undefined);
        fs.rmSync(work, { recursive: true, force: true });
    });

    setup(() => { launched = []; });

    async function runWithMacro(): Promise<void> {
        const sample = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'sample.c');
        await vscode.commands.executeCommand('ctrace.runAnalysis', {
            filePath: sample,
            // No static tool: the dependency check would wait for an answer.
            uiState: { staticEnabled: false, staticTools: [], dynamicEnabled: false, dynamicTools: [], macros: 'FEATURE=1' },
        });
    }

    test('the test window has a workspace, which Run Analysis requires', () => {
        assert.ok(vscode.workspace.workspaceFolders?.length);
    });

    test('no analysis is launched when the scan files cannot be written', async () => {
        // A folder below a regular file can never be created, even as root.
        const blocker = path.join(work, 'not-a-folder');
        fs.writeFileSync(blocker, '');
        setScanDirectoryForTesting(path.join(blocker, 'scan'));
        await runWithMacro();
        assert.deepStrictEqual(launched, []);
    });

    test('the requested macro reaches ctrace through the config when it can be written', async () => {
        setScanDirectoryForTesting(path.join(work, 'scan'));
        await runWithMacro();
        assert.ok(launched.length > 0, 'ctrace was not launched');
        // On Windows the arguments live in a WSL script, not in the command.
        if (process.platform === 'win32') { return; }
        const withConfig = launched.filter(run => run.config);
        assert.ok(withConfig.length > 0, `no --config in: ${launched.map(run => run.command).join('\n')}`);
        for (const run of withConfig) {
            assert.deepStrictEqual(run.config.stack_analyzer.defines, ['FEATURE=1']);
        }
        assert.ok(!launched[0].command.includes(vscode.extensions.getExtension('CoreTrace.coretrace')!.extensionPath + path.sep + '.ctrace-'),
            'scan files must not be written to the extension folder');
    });
});
