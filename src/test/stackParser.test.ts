import * as assert from 'assert';
import { parseStackReport } from '../ctrace/StackParser';

suite('StackParser Test Suite', () => {
    test('parses JSON stack analyzer report with functions and stack sizes', () => {
        const jsonReport = JSON.stringify({
            meta: {
                tool: 'ctrace-stack-analyzer',
                inputFile: '/path/to/main.c',
                stackLimit: 8388608
            },
            functions: [
                {
                    name: 'funcC',
                    localStack: 144,
                    maxStack: 144,
                    isRecursive: false
                },
                {
                    name: 'funcB',
                    localStack: 272,
                    maxStack: 416,
                    isRecursive: false
                },
                {
                    name: 'funcA',
                    localStack: 528,
                    maxStack: 944,
                    isRecursive: false
                },
                {
                    name: 'recursiveFunc',
                    localStack: 80,
                    maxStack: 160,
                    isRecursive: true
                },
                {
                    name: 'main',
                    localStack: 16,
                    maxStack: 960,
                    isRecursive: false
                }
            ]
        });

        const sourceCode = `
void funcC(int x) { }
void funcB(int x) { funcC(x); }
void funcA(int x) { funcB(x); }
void recursiveFunc(int n) { if (n > 0) recursiveFunc(n - 1); }
int main() { funcA(1); recursiveFunc(2); return 0; }
        `;

        const report = parseStackReport(jsonReport, sourceCode);
        assert.ok(report, 'Report should be parsed successfully');
        assert.strictEqual(report.functions.length, 5);
        assert.strictEqual(report.peakStack, 960);
        assert.strictEqual(report.recursiveCount, 1);

        const recFn = report.functions.find(f => f.name === 'recursiveFunc');
        assert.ok(recFn);
        assert.strictEqual(recFn.isRecursive, true);

        // Call graph verification
        assert.ok(report.callGraph);
        assert.ok(report.callGraph.nodes.length >= 5);
        assert.ok(report.callGraph.chains.length > 0);
        assert.ok(!report.callGraph.edges.some(edge => edge.from === edge.to && edge.from !== 'recursiveFunc'),
            'Function definitions must not be mistaken for self calls');

        // Check if main -> funcA -> funcB -> funcC chain exists
        const mainChain = report.callGraph.chains.find(c => c[0].name === 'main' && c.some(s => s.name === 'funcC'));
        assert.ok(mainChain, 'Should construct call chain from main to funcC');
    });

    test('uses reported callees without inventing stack-size relationships', () => {
        const report = parseStackReport(JSON.stringify({ functions: [
            { name: 'main', localStack: 16, maxStack: 128, callees: ['worker'] },
            { name: 'worker', localStack: 48, maxStack: 48 },
            { name: 'unrelated', localStack: 8, maxStack: 24 }
        ] }));
        assert.ok(report);
        assert.deepStrictEqual(report.callGraph?.edges.map(edge => [edge.from, edge.to]), [['main', 'worker']]);
        assert.ok(report.callGraph?.nodes.some(node => node.name === 'unrelated'));
    });

    test('parses plaintext IR stack analyzer report', () => {
        const textReport = `
Mode: IR

Function: test_func
	local stack: 32 bytes
	max stack (including callees): 64 bytes
	[ !Info! ] recursive or mutually recursive function detected

Function: other_func
	local stack: 128 bytes
	max stack (including callees): 128 bytes
`;
        const report = parseStackReport(textReport);
        assert.ok(report);
        assert.strictEqual(report.functions.length, 2);
        assert.strictEqual(report.peakStack, 128);
        assert.strictEqual(report.functions[0].localStack, 32);
        assert.strictEqual(report.functions[0].maxStack, 64);
        assert.strictEqual(report.functions[0].isRecursive, true);
    });
});
