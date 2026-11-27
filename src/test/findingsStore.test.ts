import * as assert from 'assert';
import * as vscode from 'vscode';
import { SidebarProvider } from '../SidebarProvider';
import { FindingsStore } from '../ctrace/FindingsStore';
import type { SarifLog } from '../types/sarif';

suite('FindingsStore Test Suite', () => {
    function memoryState(): vscode.Memento {
        const values = new Map<string, unknown>();
        return {
            get: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
            update: async (key: string, value: unknown) => {
                if (value === undefined) { values.delete(key); }
                else { values.set(key, value); }
            },
            keys: () => [...values.keys()],
        } as vscode.Memento;
    }

    test('restores the last findings in a new sidebar session', async () => {
        const state = memoryState();
        const report: SarifLog = {
            version: '2.1.0',
            runs: [{
                tool: { driver: { name: 'ctrace' } },
                results: [{
                    ruleId: 'CT001', level: 'warning', message: { text: 'Potential issue' },
                    locations: [{ physicalLocation: {
                        artifactLocation: { uri: '/workspace/main.c' },
                        region: { startLine: 12 },
                    } }],
                }],
            }],
        };
        await new FindingsStore(state).save(report);
        const restored = new FindingsStore(state).get();
        assert.ok(restored);
        assert.deepStrictEqual(restored.report.runs[0].results, report.runs[0].results);
        await new FindingsStore(state).clear();
        assert.strictEqual(new FindingsStore(state).get(), null);
    });

    test('keeps a successful scan with zero findings', async () => {
        const state = memoryState();
        await new FindingsStore(state).save({ version: '2.1.0', runs: [] });
        const restored = new FindingsStore(state).get();
        assert.ok(restored);
        assert.deepStrictEqual(restored.report.runs[0].results, []);
    });

    test('the recreated sidebar restores partial coverage and retries the setting until saved', async () => {
        const state = memoryState();
        const store = new FindingsStore(state);
        const note = '1 C/C++ file skipped because no C/C++ analyzer was available.';
        await store.save({ version: '2.1.0', runs: [] }, 123, note);
        const provider = new SidebarProvider(vscode.Uri.file(__dirname), store, state);
        let receive!: (message: any) => Promise<void>;
        const delivered: any[] = [];
        let hidden = false;
        const view = { visible: true, onDidChangeVisibility: () => {}, onDidDispose: () => {}, webview: {
            asWebviewUri: (uri: vscode.Uri) => uri, cspSource: 'test',
            onDidReceiveMessage: (listener: typeof receive) => { receive = listener; },
            postMessage: async (message: any) => {
                if (!hidden) { delivered.push(message); }
                return !hidden;
            },
        } } as unknown as vscode.WebviewView;
        try {
            provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
            const ready = () => receive({ type: 'webview-ready' });
            await ready();
            hidden = true;
            await provider.disableDynamicAnalysis();
            hidden = false;
            await ready();
            const replayed = delivered.filter(m => m.type === 'set-dynamic-analysis');
            assert.strictEqual(replayed.length, 1);
            assert.ok(replayed[0].id);
            assert.strictEqual(replayed[0].enabled, false);
            assert.strictEqual(delivered.find(m => m.type === 'analysis-result').coverageNote, note);
            await receive({ type: 'dynamic-setting-saved', id: replayed[0].id });
            await ready();
            assert.strictEqual(delivered.filter(m => m.type === 'set-dynamic-analysis').length, 1);
        } finally { provider.dispose(); }
    });
});
