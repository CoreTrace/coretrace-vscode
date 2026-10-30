import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { runCommand } from '../ctrace/AnalysisRunner';
import { buildCommand } from '../ctrace/CommandBuilder';
import { updateDiagnostics } from '../ctrace/DiagnosticsManager';

const posixOnly = process.platform === 'win32' ? test.skip : test;

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

suite('AnalysisRunner Test Suite', () => {
    test('returns exit code 0 and stdout on success', async () => {
        const result = await runCommand('echo hello', os.tmpdir());
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'hello');
        assert.ok(!result.killed);
    });

    test('returns the non-zero exit code of the command', async () => {
        const result = await runCommand('exit 3', os.tmpdir());
        assert.strictEqual(result.exitCode, 3);
    });

    posixOnly('timeout kills grandchild processes, not only the shell', async () => {
        const pidFile = path.join(os.tmpdir(), `ctrace-test-pid-${process.pid}-${Date.now()}`);
        // `cd …;` forces sh to fork instead of exec'ing sleep, like the real command.
        const command = `cd /tmp || true; sleep 30 & echo $! > '${pidFile}'; wait`;
        const result = await runCommand(command, os.tmpdir(), undefined, 500);
        assert.strictEqual(result.killed, true);
        assert.match(result.stderr, /timed out after 0.5s/);

        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        fs.unlinkSync(pidFile);
        await new Promise(r => setTimeout(r, 200));
        const alive = isAlive(pid);
        if (alive) { cp.execSync(`kill -9 ${pid}`); }
        assert.strictEqual(alive, false, 'sleep should have been killed with its process group');
    });

    test('cancellation stops the command and reports killed', async () => {
        const source = new vscode.CancellationTokenSource();
        setTimeout(() => source.cancel(), 200);
        const started = Date.now();
        const result = await runCommand('sleep 30', os.tmpdir(), source.token);
        assert.strictEqual(result.killed, true);
        assert.ok(Date.now() - started < 5000);
        source.dispose();
    });
});

suite('Native command quoting Test Suite', () => {
    posixOnly('shell metacharacters in file paths are not expanded', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-quote-'));
        const marker = path.join(dir, 'pwned');
        const bin = path.join(dir, 'fake ctrace');
        // The fake binary prints the --input argument it received.
        fs.writeFileSync(bin, '#!/bin/sh\nwhile [ "$1" != "--input" ]; do shift; done\nprintf "%s" "$2"\n');
        const src = path.join(dir, `a$(touch ${marker})"b".c`);
        try {
            const { command } = await buildCommand(bin, src, '');
            const result = await runCommand(command, dir);
            assert.strictEqual(fs.existsSync(marker), false, 'command substitution must not run');
            assert.strictEqual(result.stdout, src);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('DiagnosticsManager Test Suite', () => {
    function sarifFor(uri: string, line: number, message: string) {
        return {
            version: '2.1.0',
            runs: [{
                tool: { driver: { name: 'cppcheck' } },
                results: [{
                    ruleId: 'rule',
                    level: 'warning',
                    message: { text: message },
                    locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }],
                }],
            }],
        };
    }

    test('workspace mode keeps diagnostics reported into a shared header by several files', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-diag-'));
        const header = path.join(dir, 'shared.h');
        fs.writeFileSync(header, '');
        const collection = vscode.languages.createDiagnosticCollection('ctrace-test');
        try {
            updateDiagnostics(sarifFor(header, 1, 'from a.c'), collection, path.join(dir, 'a.c'), false);
            updateDiagnostics(sarifFor(header, 2, 'from b.c'), collection, path.join(dir, 'b.c'), false);
            updateDiagnostics(sarifFor(header, 2, 'from b.c'), collection, path.join(dir, 'b.c'), false);
            const messages = (collection.get(vscode.Uri.file(header)) ?? []).map(d => d.message).sort();
            assert.deepStrictEqual(messages, ['from a.c', 'from b.c']);
        } finally {
            collection.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('single-file mode replaces previous diagnostics', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-diag-'));
        const file = path.join(dir, 'a.c');
        fs.writeFileSync(file, '');
        const collection = vscode.languages.createDiagnosticCollection('ctrace-test');
        try {
            updateDiagnostics(sarifFor(file, 1, 'old'), collection, file, true);
            updateDiagnostics(sarifFor(file, 3, 'new'), collection, file, true);
            const messages = (collection.get(vscode.Uri.file(file)) ?? []).map(d => d.message);
            assert.deepStrictEqual(messages, ['new']);
        } finally {
            collection.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
