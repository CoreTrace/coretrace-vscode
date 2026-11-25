import * as assert from 'assert';
import { analysesLanguage, buildCtraceArgs, sourceLanguage, workspaceSourceExtensions, CtraceUIState } from '../ctraceRunner';

const ALL_STATIC = ['cppcheck', 'flawfinder', 'ikos', 'tscancode', 'ctrace_stack_analyzer', 'coretrace-python-analyzer'];
const settings: any = { get: (_key: string, fallback?: unknown) => fallback };
const args = (state: CtraceUIState, language: 'c' | 'python') =>
    buildCtraceArgs({ reportFile: '/tmp/r.json', ...state }, settings, language);
const invoked = (built: string[]) => built.find(arg => arg.startsWith('--invoke='))?.slice('--invoke='.length).split(',') ?? [];

suite('Python analysis Test Suite', () => {
    test('files are recognised by their extension', () => {
        assert.strictEqual(sourceLanguage('/w/app.py'), 'python');
        assert.strictEqual(sourceLanguage('/w/APP.PY'), 'python');
        assert.strictEqual(sourceLanguage('/w/main.cpp'), 'c');
        assert.strictEqual(sourceLanguage('/w/main.h'), 'c');
        assert.strictEqual(sourceLanguage('/w/notes.txt'), undefined);
        assert.strictEqual(sourceLanguage('/w/setup.pyc'), undefined);
    });

    test('a workspace scan looks for Python files only when they are analysed', () => {
        assert.strictEqual(workspaceSourceExtensions(['c']), '{c,cpp,cc,cxx}');
        assert.strictEqual(workspaceSourceExtensions(['c', 'python']), '{c,cpp,cc,cxx,py}');
    });

    test('Python files need the Python analyzer, C files are always analysed', () => {
        assert.strictEqual(analysesLanguage({}, 'python'), true);
        assert.strictEqual(analysesLanguage({ staticTools: ALL_STATIC }, 'python'), true);
        assert.strictEqual(analysesLanguage({ staticTools: ['cppcheck'] }, 'python'), false);
        assert.strictEqual(analysesLanguage({ staticEnabled: false }, 'python'), false);
        assert.strictEqual(analysesLanguage({ staticTools: [] }, 'c'), true);
    });

    test('every tool selected: --static for both languages, --dyn only for C', () => {
        const state: CtraceUIState = { staticTools: ALL_STATIC, dynamicTools: ['coretrace-runtime-analyzer'] };
        const c = args(state, 'c');
        const python = args(state, 'python');
        assert.ok(c.includes('--static') && c.includes('--dyn'));
        assert.ok(python.includes('--static'));
        assert.ok(!python.includes('--dyn'), 'the runtime analyzer builds C programs only');
    });

    test('turning the Python analyzer off keeps C runs on --static', () => {
        const state: CtraceUIState = { staticTools: ALL_STATIC.filter(tool => tool !== 'coretrace-python-analyzer'), dynamicEnabled: false };
        assert.ok(args(state, 'c').includes('--static'));
        assert.deepStrictEqual(invoked(args(state, 'c')), []);
    });

    test('a C run never names the Python analyzer, which ctrace before 0.85 rejects', () => {
        const state: CtraceUIState = { staticTools: ['cppcheck', 'coretrace-python-analyzer'], invokedTools: ['coretrace-python-analyzer'], dynamicEnabled: false };
        assert.deepStrictEqual(invoked(args(state, 'c')), ['cppcheck']);
        assert.ok(!args(state, 'c').includes('--static'));
    });

    test('a Python run never names C tools', () => {
        const state: CtraceUIState = { staticTools: ['cppcheck', 'ikos', 'coretrace-python-analyzer'], invokedTools: ['flawfinder'], dynamicEnabled: false };
        const python = args(state, 'python');
        assert.ok(python.includes('--static'));
        assert.deepStrictEqual(invoked(python), []);
    });

    test('a Python run with the analyzer off has no tool to run', () => {
        const python = args({ staticTools: ['cppcheck'], dynamicEnabled: false }, 'python');
        assert.ok(!python.includes('--static'));
        assert.deepStrictEqual(invoked(python), []);
    });
});
