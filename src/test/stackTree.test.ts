import * as assert from 'assert';

// Plain script shared with the webview (no typings).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require('../../media/stackTree.js');

function report(fns: Record<string, { peak: number; calls?: string[]; file?: string }>) {
    const names = Object.keys(fns);
    return {
        peakStack: Math.max(...names.map(n => fns[n].peak)),
        recursiveCount: 0,
        functions: names.map(name => ({ name, localStack: 8, maxStack: fns[name].peak, isRecursive: false, file: fns[name].file })),
        callGraph: {
            nodes: names.map(name => ({ id: name, name, localStack: 8, maxStack: fns[name].peak, isRecursive: false })),
            edges: names.flatMap(from => (fns[from].calls ?? []).map(to => ({ from, to }))),
            chains: [],
        },
    };
}

const visibleIds = (result: any) => result.rows.filter((r: any) => r.kind === 'function').map((r: any) => r.id);

suite('Stack call tree Test Suite', () => {
    const app = report({
        helper: { peak: 10, calls: ['leaf'] },
        main: { peak: 100, calls: ['parse', 'helper'] },
        parse: { peak: 90, calls: ['leaf'] },
        leaf: { peak: 40 },
        unused: { peak: 500 },
    });

    test('main comes first, callees are sorted by peak, unlinked functions are grouped', () => {
        const model = lib.createModel(app);
        assert.deepStrictEqual(model.roots, ['main']);
        assert.deepStrictEqual(model.children.get('main'), ['parse', 'helper']);
        assert.deepStrictEqual(model.standalone, ['unused']);
        assert.strictEqual(model.callCount, 4);

        const { rows } = lib.flattenTree(model, { expanded: new Set(['main']) });
        assert.deepStrictEqual(rows.map((r: any) => r.kind === 'group' ? `group:${r.count}` : r.id), ['main', 'parse', 'helper', 'group:1']);
        assert.deepStrictEqual(rows.map((r: any) => r.depth), [0, 1, 1, 0]);
    });

    test('hot path follows the heaviest callee, and only those rows are marked', () => {
        const model = lib.createModel(app);
        assert.deepStrictEqual(model.hotPath, ['main', 'parse', 'leaf']);
        const { rows } = lib.flattenTree(model, { expanded: lib.allExpanded(model) });
        const hot = rows.filter((r: any) => r.hot).map((r: any) => r.key);
        assert.deepStrictEqual(hot, ['main', 'main\nparse', 'main\nparse\nleaf']);
        // `leaf` is also reached through `helper`, but that row is not on the path.
        assert.strictEqual(rows.filter((r: any) => r.id === 'leaf').length, 2);
    });

    test('the default layout opens the path to the hottest function', () => {
        const model = lib.createModel(app);
        const ids = visibleIds(lib.flattenTree(model, { expanded: lib.defaultExpanded(model) }));
        assert.deepStrictEqual(ids, ['main', 'parse', 'leaf', 'helper']);
    });

    test('recursion ends on a marked row instead of looping forever', () => {
        const model = lib.createModel(report({
            main: { peak: 30, calls: ['a'] },
            a: { peak: 20, calls: ['b'] },
            b: { peak: 10, calls: ['a', 'b'] },
        }));
        const { rows, truncated } = lib.flattenTree(model, { expanded: lib.allExpanded(model) });
        assert.strictEqual(truncated, false);
        assert.deepStrictEqual(rows.filter((r: any) => r.isCycleRef).map((r: any) => r.id).sort(), ['a', 'b']);
        assert.ok(rows.filter((r: any) => r.isCycleRef).every((r: any) => !r.expandable));
    });

    test('a cycle nobody enters is still reachable from a root', () => {
        const model = lib.createModel(report({
            ping: { peak: 10, calls: ['pong'] },
            pong: { peak: 20, calls: ['ping'] },
        }));
        assert.deepStrictEqual(model.roots, ['pong']);
        assert.deepStrictEqual(model.standalone, []);
        assert.ok(lib.pathTo(model, 'ping'));
    });

    test('a function that only calls itself is not treated as unlinked', () => {
        const model = lib.createModel(report({ fact: { peak: 10, calls: ['fact'] } }));
        assert.deepStrictEqual(model.roots, ['fact']);
        assert.deepStrictEqual(model.standalone, []);
    });

    test('without any call link, functions are listed without a group', () => {
        const model = lib.createModel(report({ a: { peak: 1 }, b: { peak: 2 } }));
        const { rows } = lib.flattenTree(model, {});
        assert.deepStrictEqual(rows.map((r: any) => `${r.kind}:${r.id}`), ['function:b', 'function:a']);
    });

    test('a filter keeps the matches and the rows leading to them, all open', () => {
        const model = lib.createModel(app);
        const result = lib.flattenTree(model, { expanded: new Set(), query: 'LEAF' });
        assert.strictEqual(result.matchCount, 1);
        assert.deepStrictEqual(visibleIds(result), ['main', 'parse', 'leaf', 'helper', 'leaf']);
        assert.deepStrictEqual(result.rows.filter((r: any) => r.match).map((r: any) => r.key), ['main\nparse\nleaf', 'main\nhelper\nleaf']);
    });

    test('a filter also searches file names', () => {
        const model = lib.createModel(report({ a: { peak: 1, file: '/src/net/socket.c' }, b: { peak: 2 } }));
        assert.deepStrictEqual(visibleIds(lib.flattenTree(model, { query: 'socket' })), ['a']);
    });

    test('a densely connected graph is cut off instead of freezing the sidebar', () => {
        const fns: Record<string, { peak: number; calls: string[] }> = {};
        for (let i = 0; i < 40; i++) {
            fns[`f${i}`] = { peak: 40 - i, calls: Array.from({ length: 40 - i - 1 }, (_, j) => `f${i + j + 1}`) };
        }
        const model = lib.createModel(report(fns));
        const started = Date.now();
        const { rows, truncated } = lib.flattenTree(model, { query: 'f', maxRows: 200 });
        assert.strictEqual(rows.length, 200);
        assert.strictEqual(truncated, true);
        assert.ok(Date.now() - started < 2000);
    });

    test('ranking lists every function, heaviest first', () => {
        const model = lib.createModel(app);
        assert.deepStrictEqual(lib.rankedRows(model).map((r: any) => r.id), ['unused', 'main', 'parse', 'leaf', 'helper']);
        assert.deepStrictEqual(lib.rankedRows(model, 'par').map((r: any) => r.id), ['parse']);
    });

    test('pathTo gives the rows to open, including the unlinked group', () => {
        const model = lib.createModel(app);
        assert.deepStrictEqual(lib.pathTo(model, 'leaf'), { key: 'main\nparse\nleaf', open: ['main', 'main\nparse'] });
        assert.deepStrictEqual(lib.pathTo(model, 'unused').open, [lib.STANDALONE_KEY]);
        assert.strictEqual(lib.pathTo(model, 'nope'), null);
    });

    test('resolveName finds qualified functions from a CodeLens name', () => {
        const model = lib.createModel(report({ 'Worker::run': { peak: 5 }, main: { peak: 1 } }));
        assert.strictEqual(lib.resolveName(model, 'main'), 'main');
        assert.strictEqual(lib.resolveName(model, 'run'), 'Worker::run');
        assert.strictEqual(lib.resolveName(model, 'missing'), null);
    });

    test('an empty report does not throw', () => {
        const model = lib.createModel({ functions: [], peakStack: 0 });
        assert.deepStrictEqual(lib.flattenTree(model, {}).rows, []);
        assert.deepStrictEqual(model.hotPath, []);
    });
});
