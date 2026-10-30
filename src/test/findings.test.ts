import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { updateDiagnostics, getFindingForDiagnostic, cweIds } from '../ctrace/DiagnosticsManager';
import { FindingIgnoreList, computeFingerprint, IGNORE_FILE_NAME } from '../ctrace/FindingIgnoreList';
import {
    analysisContextKey,
    cacheFileAnalysis,
    clearCache,
    initAnalysisCache,
    partitionFiles,
    persistAnalysisCache,
} from '../ctrace/WorkspaceScanner';

function tempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sarifWith(result: Record<string, unknown>, tool = 'cppcheck'): any {
    return { version: '2.1.0', runs: [{ tool: { driver: { name: tool } }, results: [result] }] };
}

function resultAt(file: string, line: number, extra: Record<string, unknown> = {}) {
    return {
        ruleId: 'doubleFree',
        level: 'error',
        message: { text: "Memory pointed to by 'ptr' is freed twice." },
        locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: line, startColumn: 5 } } }],
        ...extra,
    };
}

suite('CWE enrichment Test Suite', () => {
    test('cweIds normalises ctrace properties and GitHub-style tags', () => {
        assert.deepStrictEqual(cweIds({ cwe: 'CWE-415' }), ['CWE-415']);
        assert.deepStrictEqual(cweIds({ cwe: 476 }), ['CWE-476']);
        assert.deepStrictEqual(cweIds({ cwe: ['cwe-120', 'CWE-120'], tags: ['external/cwe/cwe-787', 'security'] }), ['CWE-120', 'CWE-787']);
        assert.deepStrictEqual(cweIds({ cwe: 'not a cwe' }), []);
        assert.deepStrictEqual(cweIds(undefined), []);
    });

    test('diagnostics link to the CWE and name the analyzers', () => {
        const dir = tempDir('ctrace-cwe-');
        const file = path.join(dir, 'double_free.c');
        fs.writeFileSync(file, 'int main() {\n  free(p);\n  free(p);\n}\n');
        const collection = vscode.languages.createDiagnosticCollection('ctrace-test');
        try {
            const sarif = sarifWith(resultAt(file, 3, {
                properties: {
                    cwe: 'CWE-415',
                    alsoReportedBy: [{ tool: 'ctrace_stack_analyzer', ruleId: 'ResourceLifetime.DoubleRelease' }],
                },
            }));
            updateDiagnostics(sarif, collection, file, true);
            const [diagnostic] = collection.get(vscode.Uri.file(file)) ?? [];
            assert.ok(diagnostic);
            assert.strictEqual(diagnostic.source, 'CoreTrace (cppcheck)');
            const code = diagnostic.code as { value: string; target: vscode.Uri };
            assert.strictEqual(code.value, 'doubleFree · CWE-415');
            assert.strictEqual(code.target.toString(), 'https://cwe.mitre.org/data/definitions/415.html');
            assert.match(diagnostic.message, /Also reported by: ctrace_stack_analyzer \(ResourceLifetime\.DoubleRelease\)/);
        } finally {
            collection.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a result without CWE keeps the rule id as plain code', () => {
        const dir = tempDir('ctrace-cwe-');
        const file = path.join(dir, 'a.c');
        fs.writeFileSync(file, 'x\n');
        const collection = vscode.languages.createDiagnosticCollection('ctrace-test');
        try {
            updateDiagnostics(sarifWith(resultAt(file, 1)), collection, file, true);
            assert.strictEqual(collection.get(vscode.Uri.file(file))?.[0].code, 'doubleFree');
        } finally {
            collection.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('Ignored findings Test Suite', () => {
    test('fingerprint ignores the line number but not the source line', () => {
        const a = computeFingerprint('rule', 'src/a.c', 'msg', '  strcpy(buf, src);');
        assert.strictEqual(a, computeFingerprint('rule', 'src/a.c', 'msg', 'strcpy(buf,  src);'));
        assert.notStrictEqual(a, computeFingerprint('rule', 'src/a.c', 'msg', 'strcpy(other, src);'));
        assert.notStrictEqual(a, computeFingerprint('rule', 'src/b.c', 'msg', 'strcpy(buf, src);'));
    });

    test('an ignored finding stays ignored when code is inserted above it', () => {
        const dir = tempDir('ctrace-ignore-');
        const file = path.join(dir, 'a.c');
        const collection = vscode.languages.createDiagnosticCollection('ctrace-test');
        try {
            fs.writeFileSync(file, 'void f() {\n  free(p);\n}\n');
            const first = sarifWith(resultAt(file, 2));
            updateDiagnostics(first, collection, file, true);
            const fingerprint = first.runs[0].results[0].properties.ctraceFingerprint;
            assert.ok(fingerprint);

            fs.writeFileSync(file, '// new comment\n// another\nvoid f() {\n  free(p);\n}\n');
            const second = sarifWith(resultAt(file, 4));
            updateDiagnostics(second, collection, file, true, { isIgnored: fp => fp === fingerprint });
            assert.strictEqual(second.runs[0].results[0].properties.ctraceIgnored, true);
            assert.strictEqual(collection.get(vscode.Uri.file(file))?.length ?? 0, 0);
        } finally {
            collection.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('published diagnostics can be mapped back to their finding for the quick fix', () => {
        const dir = tempDir('ctrace-ignore-');
        const file = path.join(dir, 'a.c');
        fs.writeFileSync(file, 'x\ny\n');
        const collection = vscode.languages.createDiagnosticCollection('ctrace-test');
        try {
            updateDiagnostics(sarifWith(resultAt(file, 2)), collection, file, true);
            const published = collection.get(vscode.Uri.file(file))![0];
            // Code actions receive copies, so look up with an equal diagnostic.
            const copy = new vscode.Diagnostic(published.range, published.message, published.severity);
            const finding = getFindingForDiagnostic(vscode.Uri.file(file), copy);
            assert.ok(finding);
            assert.strictEqual(finding.ruleId, 'doubleFree');
            assert.strictEqual(finding.line, 2);
            assert.strictEqual(finding.file, file);
        } finally {
            collection.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('ignore list persists entries and tolerates a broken file', async () => {
        const dir = tempDir('ctrace-ignore-');
        const list = new FindingIgnoreList(dir);
        try {
            let changes = 0;
            list.onDidChange(() => changes++);
            await list.add({ fingerprint: 'abc123def456', ruleId: 'doubleFree', file: 'a.c', line: 3, reason: 'checked by caller' });
            await list.add({ fingerprint: 'abc123def456', ruleId: 'doubleFree' });
            assert.strictEqual(changes, 1);
            assert.ok(list.has('abc123def456'));

            const onDisk = JSON.parse(fs.readFileSync(path.join(dir, IGNORE_FILE_NAME), 'utf8'));
            assert.strictEqual(onDisk.version, 1);
            assert.strictEqual(onDisk.ignored.length, 1);
            assert.strictEqual(onDisk.ignored[0].reason, 'checked by caller');

            const reopened = new FindingIgnoreList(dir);
            assert.ok(reopened.has('abc123def456'));
            reopened.dispose();

            await list.remove(['abc123def456']);
            assert.ok(!list.has('abc123def456'));

            fs.writeFileSync(path.join(dir, IGNORE_FILE_NAME), '{ not json');
            assert.doesNotThrow(() => list.reload());
            assert.deepStrictEqual(list.list(), []);
        } finally {
            list.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('ignoring requires a workspace folder', async () => {
        const list = new FindingIgnoreList(undefined);
        try {
            await assert.rejects(list.add({ fingerprint: 'abc123def456' }), /workspace folder/);
        } finally {
            list.dispose();
        }
    });
});

suite('Incremental workspace scan Test Suite', () => {
    const emptySarif = (name: string) => ({ version: '2.1.0' as const, runs: [{ tool: { driver: { name } }, results: [] }] });

    teardown(async () => {
        await clearCache();
        await initAnalysisCache(undefined);
    });

    test('only changed files or files analysed with other options are re-analysed', async () => {
        const dir = tempDir('ctrace-incr-');
        const a = path.join(dir, 'a.c');
        const b = path.join(dir, 'b.c');
        fs.writeFileSync(a, 'int a;');
        fs.writeFileSync(b, 'int b;');
        try {
            let partition = await partitionFiles([a, b], 'key1');
            assert.deepStrictEqual(partition.changed.map(f => f.fsPath), [a, b]);
            for (const file of partition.changed) {
                cacheFileAnalysis(file, 'key1', { sarif: emptySarif(path.basename(file.fsPath)), stack: null });
            }

            partition = await partitionFiles([a, b], 'key1');
            assert.deepStrictEqual(partition.changed, []);
            assert.strictEqual(partition.cached.get(a)?.sarif.runs[0].tool.driver.name, 'a.c');

            fs.writeFileSync(b, 'int b = 2;');
            partition = await partitionFiles([a, b], 'key1');
            assert.deepStrictEqual(partition.changed.map(f => f.fsPath), [b]);

            partition = await partitionFiles([a, b], 'key2');
            assert.deepStrictEqual(partition.changed.map(f => f.fsPath), [a, b]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the cache survives a restart and drops deleted files', async () => {
        const dir = tempDir('ctrace-incr-');
        const storage = path.join(dir, 'storage');
        const a = path.join(dir, 'a.c');
        const gone = path.join(dir, 'gone.c');
        fs.writeFileSync(a, 'int a;');
        fs.writeFileSync(gone, 'int g;');
        try {
            await initAnalysisCache(storage);
            for (const file of (await partitionFiles([a, gone], 'key')).changed) {
                cacheFileAnalysis(file, 'key', { sarif: emptySarif('x'), stack: null });
            }
            fs.unlinkSync(gone);
            await persistAnalysisCache();

            // Simulate a new session: in-memory state is gone, the file stays.
            const persisted = fs.readFileSync(path.join(storage, 'workspace-scan-cache.v1.json'), 'utf8');
            await clearCache();
            fs.mkdirSync(storage, { recursive: true });
            fs.writeFileSync(path.join(storage, 'workspace-scan-cache.v1.json'), persisted);
            await initAnalysisCache(storage);

            const partition = await partitionFiles([a], 'key');
            assert.deepStrictEqual(partition.changed, []);
            assert.ok(partition.cached.has(a));
            assert.ok(!JSON.parse(persisted).some(([p]: [string]) => p === gone));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('context key changes with the options and the dependency files', async () => {
        const dir = tempDir('ctrace-incr-');
        const compdb = path.join(dir, 'compile_commands.json');
        fs.writeFileSync(compdb, '[]');
        try {
            const base = await analysisContextKey(['--static'], [compdb]);
            assert.strictEqual(base, await analysisContextKey(['--static'], [compdb]));
            assert.notStrictEqual(base, await analysisContextKey(['--static', '--smt=on'], [compdb]));
            fs.writeFileSync(compdb, '[{"file":"a.c"}]');
            assert.notStrictEqual(base, await analysisContextKey(['--static'], [compdb]));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
