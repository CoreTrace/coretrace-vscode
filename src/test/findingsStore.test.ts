import * as assert from 'assert';
import type * as vscode from 'vscode';
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
});
