import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as AnalysisRunner from '../ctrace/AnalysisRunner';
import * as BinaryUpdater from '../ctrace/BinaryUpdater';
import { setMockWslAvailableForTesting } from '../ctrace/CommandBuilder';
import { setScanDirectoryForTesting } from '../ctraceRunner';

const ALL_STATIC = ['cppcheck', 'flawfinder', 'ikos', 'tscancode', 'ctrace_stack_analyzer', 'coretrace-python-analyzer'];

/**
 * Runs the real Run Analysis command on the fixture, which holds C, Python
 * and a .venv, with the binary lookup and the process launcher replaced.
 */
suite('Run Analysis on Python files', function () {
    this.timeout(60000);

    const runner = AnalysisRunner as { runCommand: typeof AnalysisRunner.runCommand };
    const updater = BinaryUpdater as { ensureBinary: typeof BinaryUpdater.ensureBinary };
    const originalRunCommand = runner.runCommand;
    const originalEnsureBinary = updater.ensureBinary;
    let launched: string[] = [];
    let work = '';
    let root = '';

    suiteSetup(async () => {
        root = vscode.workspace.workspaceFolders![0].uri.fsPath;
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-py-'));
        const fakeBinary = path.join(work, 'ctrace');
        fs.writeFileSync(fakeBinary, '#!/bin/sh\n', { mode: 0o755 });
        updater.ensureBinary = async () => fakeBinary;
        runner.runCommand = async (command: string) => {
            launched.push(command);
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

    setup(() => { launched = []; });

    const inputOf = (command: string) => command.match(/--input '([^']+)'/)?.[1] ?? command;
    const posix = process.platform !== 'win32';

    test('a Python file is analysed once, with --static and without the C-only passes', async () => {
        await vscode.commands.executeCommand('ctrace.runAnalysis', {
            filePath: path.join(root, 'app.py'),
            uiState: { staticTools: ALL_STATIC, dynamicTools: ['coretrace-runtime-analyzer'] },
        });
        assert.strictEqual(launched.length, 1, `expected one run, got:\n${launched.join('\n')}`);
        if (posix) {
            assert.strictEqual(inputOf(launched[0]), path.join(root, 'app.py'));
            assert.ok(launched[0].includes("'--static'"));
            assert.ok(!launched[0].includes("'--dyn'"), 'no runtime analysis for Python');
            assert.ok(!launched[0].includes('ctrace_stack_analyzer'), 'no stack pass for Python');
        }
    });

    test('nothing is launched for a Python file when the Python analyzer is off', async () => {
        await vscode.commands.executeCommand('ctrace.runAnalysis', {
            filePath: path.join(root, 'app.py'),
            uiState: { staticTools: ALL_STATIC.filter(tool => tool !== 'coretrace-python-analyzer'), dynamicEnabled: false },
        });
        assert.deepStrictEqual(launched, []);
    });

    test('a workspace scan covers C and Python files and skips virtual environments', async () => {
        await vscode.commands.executeCommand('ctrace.clearAnalysisCache');
        await vscode.commands.executeCommand('ctrace.runWorkspaceAnalysis', {
            // No C tool selected: the C dependency check would wait for an answer.
            uiState: { staticTools: ['coretrace-python-analyzer'], dynamicEnabled: false },
        });
        if (!posix) {
            assert.ok(launched.length >= 2);
            return;
        }
        const inputs = launched.map(inputOf).map(file => path.relative(root, file)).sort();
        assert.ok(inputs.includes('app.py'), inputs.join(', '));
        assert.ok(inputs.includes('sample.c'), inputs.join(', '));
        assert.ok(!inputs.some(file => file.includes('.venv')), `virtual environment scanned: ${inputs.join(', ')}`);
        const cRun = launched.find(command => inputOf(command).endsWith('sample.c'))!;
        assert.ok(!cRun.includes('coretrace-python-analyzer'), 'a C run must never name the Python analyzer');
    });

    test('with a real ctrace 0.85 or newer, Python findings reach the Problems panel', async function () {
        // CTRACE_BIN: a ctrace with the Python analyzer, e.g. the one the extension downloads.
        const binary = process.env.CTRACE_BIN;
        if (!binary || !posix) { this.skip(); }
        runner.runCommand = originalRunCommand;
        updater.ensureBinary = async () => binary!;
        try {
            const file = path.join(root, 'app.py');
            await vscode.commands.executeCommand('ctrace.runAnalysis', {
                filePath: file,
                uiState: { staticTools: ['coretrace-python-analyzer'], dynamicEnabled: false },
            });
            const diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(file));
            const evalFinding = diagnostics.find(d => String((d.code as any)?.value ?? d.code).startsWith('dangerous-eval'));
            assert.ok(evalFinding, `no dangerous-eval finding, got: ${diagnostics.map(d => `${d.source} ${d.message}`).join(' | ') || 'none'}`);
            assert.strictEqual(evalFinding.source, 'CoreTrace (coretrace-python-analyzer)');
            assert.strictEqual(evalFinding.range.start.line, 1);
        } finally {
            runner.runCommand = async (command: string) => {
                launched.push(command);
                return { stdout: '', stderr: '', exitCode: 0 };
            };
            updater.ensureBinary = originalEnsureBinary;
        }
    });
});
