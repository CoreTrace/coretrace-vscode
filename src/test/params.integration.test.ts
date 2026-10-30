import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCommand } from '../ctrace/AnalysisRunner';
import { buildCommand } from '../ctrace/CommandBuilder';
import { parseSarifOutput } from '../ctrace/SarifParser';
import { parseStackReport } from '../ctrace/StackParser';
import { buildCtraceArgs, buildStackAnalyzerArgs, generateConfigFileIfNeeded, shellQuoteArgs, CtraceUIState } from '../ctraceRunner';

/**
 * Runs each parameter through the extension's code and a real ctrace, to prove
 * that ctrace understands it and that it changes the result.
 * Needs a binary: set CTRACE_BIN, or put `ctrace` at the repository root.
 * Skipped otherwise, which includes CI.
 */
const REPO_BINARY = path.resolve(__dirname, '..', '..', 'ctrace');
const BIN = process.env.CTRACE_BIN || (fs.existsSync(REPO_BINARY) ? REPO_BINARY : '');

const SOURCE = `#include <stdlib.h>
#include <string.h>
#include "cfg.h"
int helper(int n) { char b[64]; b[0] = (char)n; return b[0]; }
void leak_one(void) { char *p = malloc(10); p[0] = 1; }
#ifdef ENABLE_BUG
void macro_only_fn(void) { char *q = malloc(4); free(q); free(q); }
#endif
int recurse(int n) { char big[128]; big[0] = (char)n; return n > 0 ? recurse(n - 1) + big[0] : 0; }
int main(void) { char s[BUF_SIZE]; strcpy(s, "x"); leak_one(); return helper(1) + recurse(3) + s[0]; }
`;

interface Run {
    functions: string[];
    limitFunctions: string[];
    rules: string[];
    hasSarif: boolean;
    output: string;
}

suite('Analysis parameters: real ctrace', function () {
    this.timeout(90000);
    let root = '';
    let file = '';

    suiteSetup(function () {
        if (!BIN || process.platform === 'win32') { this.skip(); }
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-params-'));
        fs.mkdirSync(path.join(root, 'src'));
        fs.mkdirSync(path.join(root, 'include'));
        fs.writeFileSync(path.join(root, 'include', 'cfg.h'), '#define BUF_SIZE 8\n');
        file = path.join(root, 'src', 'app.c');
        fs.writeFileSync(file, SOURCE);
    });

    suiteTeardown(() => {
        if (root) { fs.rmSync(root, { recursive: true, force: true }); }
    });

    /** Same sequence as extension.ts: config file, SARIF pass, stack pass. */
    async function analyse(state: CtraceUIState, config: Record<string, unknown> = {}): Promise<Run> {
        const settings: any = { get: (key: string, fallback?: unknown) => key in config ? config[key] : fallback };
        const full: CtraceUIState = { staticEnabled: true, staticTools: ['ctrace_stack_analyzer'], dynamicEnabled: false, dynamicTools: [], extraIncludes: 'include', ...state };
        const stamp = `${Date.now()}-${Math.random()}`;
        const report = path.join(root, `report-${stamp}.json`);
        const generated = path.join(root, `config-${stamp}.json`);
        const hasConfig = generateConfigFileIfNeeded(generated, full, root, settings);
        const configFile = hasConfig ? generated : undefined;
        // Not the workspace: like the extension, ctrace must not depend on the cwd.
        const cwd = os.tmpdir();
        const sarifRun = await runCommand(
            (await buildCommand(BIN, file, shellQuoteArgs(buildCtraceArgs({ ...full, reportFile: report, configFile }, settings)))).command, cwd);
        const sarif = await parseSarifOutput(sarifRun.stdout, report);
        const stackRun = await runCommand(
            (await buildCommand(BIN, file, shellQuoteArgs(buildStackAnalyzerArgs({ ...full, configFile }, settings)))).command, cwd);
        const stackOutput = stackRun.stdout + stackRun.stderr;
        const stack = parseStackReport(stackOutput, SOURCE);
        return {
            functions: (stack?.functions ?? []).map(fn => fn.name).sort(),
            limitFunctions: (stack?.functions ?? []).filter(fn => fn.exceedsLimit).map(fn => fn.name).sort(),
            rules: (sarif?.runs ?? []).flatMap(run => run.results ?? []).map(result => result.ruleId ?? ''),
            hasSarif: sarif !== null,
            output: sarifRun.stdout + sarifRun.stderr + stackOutput,
        };
    }

    const ALL = ['helper', 'leak_one', 'main', 'recurse'];

    test('baseline: the fixture is analysed', async () => {
        const run = await analyse({});
        assert.deepStrictEqual(run.functions, ALL);
        assert.ok(run.rules.length > 0);
    });

    test('ctrace does reject an unknown config key, so "accepted" below means something', async () => {
        const bad = path.join(root, 'bad.json');
        fs.writeFileSync(bad, JSON.stringify({ stack_analyzer: { bogus_key: 1 } }));
        const { command } = await buildCommand(BIN, file, shellQuoteArgs([`--config=${bad}`, '--invoke=ctrace_stack_analyzer']));
        const result = await runCommand(command, os.tmpdir());
        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.stdout + result.stderr, /Unknown key/);
    });

    test('include directories make the file compile', async () => {
        const run = await analyse({ extraIncludes: '' });
        assert.deepStrictEqual(run.functions, []);
        assert.match(run.output, /Compilation failed|file not found/i);
    });

    test('function filter narrows the report', async () => {
        assert.deepStrictEqual((await analyse({ onlyFunction: 'helper' })).functions, ['helper']);
    });

    test('entry points narrow the report', async () => {
        assert.deepStrictEqual((await analyse({ entryPoints: ['helper'] })).functions, ['helper']);
    });

    test('relative "only directories" keeps the files inside', async () => {
        assert.deepStrictEqual((await analyse({ onlyDir: 'src' })).functions, ALL);
    });

    test('relative "only directories" drops the files outside', async () => {
        assert.deepStrictEqual((await analyse({ onlyDir: 'vendor' })).functions, []);
    });

    test('relative "exclude directories" skips the files inside', async () => {
        assert.deepStrictEqual((await analyse({ excludeDir: 'src' })).functions, []);
    });

    test('macros reach the compiler', async () => {
        assert.ok((await analyse({ macros: 'ENABLE_BUG' })).functions.includes('macro_only_fn'));
    });

    test('extra compiler arguments reach the compiler', async () => {
        assert.ok((await analyse({ compilerExtraArgs: '-DENABLE_BUG' })).functions.includes('macro_only_fn'));
    });

    test('compile_commands.json provides the flags', async () => {
        const database = path.join(root, 'compile_commands.json');
        fs.writeFileSync(database, JSON.stringify([{ directory: root, file, arguments: ['clang', '-c', `-I${root}/include`, '-DENABLE_BUG', file] }]));
        try {
            assert.ok((await analyse({ extraIncludes: '', compileCommandsPath: database })).functions.includes('macro_only_fn'));
        } finally {
            fs.rmSync(database, { force: true });
        }
    });

    test('warnings only hides info-level findings', async () => {
        const all = await analyse({});
        const warnings = await analyse({ warningsOnly: true });
        assert.ok(warnings.rules.length < all.rules.length, `${warnings.rules.length} vs ${all.rules.length}`);
    });

    test('stack limit adds findings and flags functions in the Stack Tree', async () => {
        const run = await analyse({}, { 'analysis.stackLimit': 64 });
        assert.ok(run.rules.includes('StackFrameTooLarge'));
        assert.ok(run.limitFunctions.includes('helper'), run.limitFunctions.join(','));
        assert.ok(!run.limitFunctions.includes('leak_one'));
        assert.deepStrictEqual((await analyse({})).limitFunctions, []);
    });

    test('timings are printed', async () => {
        const plain = await analyse({});
        const timed = await analyse({ timing: true });
        assert.ok(timed.output.length > plain.output.length);
    });

    test('filter decisions are printed', async () => {
        const plain = await analyse({});
        const dumped = await analyse({ dumpFilter: true });
        assert.ok(dumped.output.length > plain.output.length);
    });

    test('compile IR cache directory is used', async () => {
        const cache = path.join(root, 'ir-cache');
        await analyse({}, { 'performance.compileIrCacheDir': cache });
        assert.ok(fs.readdirSync(cache).length > 0);
    });

    // No visible effect on this small fixture: this proves ctrace accepts them
    // and that the analysis still works, not that they change the result.
    const accepted: { name: string; state?: CtraceUIState; config?: Record<string, unknown> }[] = [
        { name: 'profile fast', state: { analysisProfile: 'fast' } },
        { name: 'profile full', state: { analysisProfile: 'full' } },
        { name: 'SMT with z3', state: { smtEnabled: true, smtBackend: 'z3', smtSecondaryBackend: 'interval', smtMode: 'single', smtTimeoutMs: 500, smtRules: 'recursion' } },
        { name: 'SMT portfolio', state: { smtEnabled: true, smtBackend: 'interval', smtSecondaryBackend: 'interval', smtMode: 'portfolio' } },
        { name: 'system libraries', state: { includeStl: true } },
        { name: 'cross-file on', state: { resourceCrossTu: true } },
        { name: 'cross-file off', state: { resourceCrossTu: false } },
        { name: 'fast compdb', state: { compdbFast: true } },
        { name: 'compdb deps', state: { includeCompdbDeps: true } },
        { name: 'quiet', state: { quiet: true } },
        { name: 'demangle', state: { demangle: true } },
        { name: 'resource summary directory', config: { 'cache.resourceSummaryDir': '/tmp/ctrace-summary-test' } },
        { name: 'memory-only summaries', config: { 'cache.memoryOnly': true } },
    ];
    for (const { name, state, config } of accepted) {
        test(`${name} is accepted`, async () => {
            const run = await analyse(state ?? {}, config ?? {});
            assert.doesNotMatch(run.output, /Unknown key|failed to load config|unrecognized option/i);
            assert.ok(run.hasSarif);
            assert.deepStrictEqual(run.functions, ALL);
        });
    }
});
