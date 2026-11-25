import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as AnalysisRunner from '../ctrace/AnalysisRunner';
import * as BinaryUpdater from '../ctrace/BinaryUpdater';
import { setMockWslAvailableForTesting } from '../ctrace/CommandBuilder';
import * as DependencyInstaller from '../ctrace/DependencyInstaller';
import { setScanDirectoryForTesting } from '../ctraceRunner';

/**
 * Run Analysis with a missing analyzer and the user choosing Install
 * Analyzers: the installer and its check are replaced, the rest is real.
 */
suite('Run Analysis after installing analyzers', function () {
    this.timeout(60000);

    const runner = AnalysisRunner as { runCommand: typeof AnalysisRunner.runCommand };
    const updater = BinaryUpdater as { ensureBinary: typeof BinaryUpdater.ensureBinary };
    const installer = DependencyInstaller as {
        checkDependencies: typeof DependencyInstaller.checkDependencies;
        installDependencies: typeof DependencyInstaller.installDependencies;
    };
    const window = vscode.window as { showWarningMessage: typeof vscode.window.showWarningMessage };
    const originals = {
        runCommand: runner.runCommand,
        ensureBinary: updater.ensureBinary,
        checkDependencies: installer.checkDependencies,
        installDependencies: installer.installDependencies,
        showWarningMessage: window.showWarningMessage,
    };
    let work = '';
    let launched: string[] = [];
    let prompts = 0;
    let installs = 0;
    let installWorks = true;
    let ikosInstalled = false;

    const status = (): DependencyInstaller.DependencyStatus => ({
        allInstalled: ikosInstalled,
        missing: ikosInstalled ? [] : ['ikos'],
        details: { cppcheck: true, cppcheckHomebrew: false, cppcheckSarif: true, flawfinder: true, ikos: ikosInstalled, tscancode: true },
    });
    const run = () => vscode.commands.executeCommand('ctrace.runAnalysis', {
        filePath: path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'sample.c'),
        uiState: { staticTools: ['ikos'], dynamicEnabled: false },
    });
    const analysed = () => launched.filter(command => command.includes('--sarif-format')).length;

    suiteSetup(async () => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-resume-'));
        const fakeBinary = path.join(work, 'ctrace');
        fs.writeFileSync(fakeBinary, '#!/bin/sh\n', { mode: 0o755 });
        updater.ensureBinary = async () => fakeBinary;
        runner.runCommand = async (command: string) => {
            launched.push(command);
            return { stdout: '', stderr: '', exitCode: 0 };
        };
        installer.checkDependencies = async () => status();
        installer.installDependencies = async () => {
            installs++;
            ikosInstalled = installWorks;
            return installWorks;
        };
        window.showWarningMessage = ((message: string, ...items: string[]) => {
            if (items.includes('Install Analyzers')) {
                prompts++;
                return Promise.resolve('Install Analyzers');
            }
            return originals.showWarningMessage(message, ...items);
        }) as typeof vscode.window.showWarningMessage;
        setMockWslAvailableForTesting(true);
        setScanDirectoryForTesting(path.join(work, 'scan'));
        await vscode.extensions.getExtension('CoreTrace.coretrace')!.activate();
    });

    suiteTeardown(() => {
        runner.runCommand = originals.runCommand;
        updater.ensureBinary = originals.ensureBinary;
        installer.checkDependencies = originals.checkDependencies;
        installer.installDependencies = originals.installDependencies;
        window.showWarningMessage = originals.showWarningMessage;
        setMockWslAvailableForTesting(null);
        setScanDirectoryForTesting(undefined);
        fs.rmSync(work, { recursive: true, force: true });
    });

    setup(() => { launched = []; prompts = 0; installs = 0; });

    test('a failed repair does not start the scan', async function () {
        if (process.platform === 'win32') { this.skip(); }
        ikosInstalled = false;
        installWorks = false;
        await run();
        assert.strictEqual(installs, 1);
        assert.strictEqual(analysed(), 0);
    });

    test('after a successful repair the original scan resumes, and the next run asks nothing', async function () {
        if (process.platform === 'win32') { this.skip(); }
        ikosInstalled = false;
        installWorks = true;
        await run();
        assert.strictEqual(installs, 1);
        assert.strictEqual(analysed(), 1, 'the scan must resume after the verified install');

        launched = []; prompts = 0; installs = 0;
        await run();
        assert.strictEqual(prompts, 0, 'no installer prompt once the tools are verified');
        assert.strictEqual(installs, 0);
        assert.strictEqual(analysed(), 1);
    });
});
