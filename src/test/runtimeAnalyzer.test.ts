import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bundledRuntimeAnalyzer, isRuntimeAnalyzerAvailable, requestsDynamicAnalysis } from '../ctrace/RuntimeAnalyzer';

suite('Runtime analyzer detection Test Suite', () => {
    let work = '';
    setup(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-runtime-')); });
    teardown(() => fs.rmSync(work, { recursive: true, force: true }));

    const ctrace = () => path.join(work, 'bin', 'ctrace');
    const noPath = async () => ({ code: 1 });

    test('the runtime analyzer of the release is found next to ctrace', async () => {
        const bundled = bundledRuntimeAnalyzer(ctrace());
        fs.mkdirSync(path.dirname(bundled), { recursive: true });
        fs.writeFileSync(bundled, '');
        assert.strictEqual(await isRuntimeAnalyzerAvailable(ctrace(), noPath), true);
    });

    test('without it, one on PATH is used', async () => {
        assert.strictEqual(await isRuntimeAnalyzerAvailable(ctrace(), async () => ({ code: 0 })), true);
    });

    test('a release without it and nothing on PATH means no dynamic analysis', async () => {
        assert.strictEqual(await isRuntimeAnalyzerAvailable(ctrace(), noPath), false);
        assert.strictEqual(await isRuntimeAnalyzerAvailable(ctrace(), async () => { throw new Error('no shell'); }), false);
    });

    test('dynamic analysis is requested unless turned off or deselected', () => {
        assert.strictEqual(requestsDynamicAnalysis({}), true);
        assert.strictEqual(requestsDynamicAnalysis({ dynamicTools: ['coretrace-runtime-analyzer'] }), true);
        assert.strictEqual(requestsDynamicAnalysis({ dynamicEnabled: false }), false);
        assert.strictEqual(requestsDynamicAnalysis({ dynamicTools: [] }), false);
    });
});
