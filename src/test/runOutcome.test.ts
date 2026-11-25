import * as assert from 'assert';
import { failedTools } from '../ctrace/RunOutcome';

suite('Run outcome Test Suite', () => {
    test('the tools that could not run are read from ctrace output', () => {
        // As printed by ctrace 0.85 with tscancode missing.
        const output = [
            '|42| == CoreTrace == [INFO] (cppcheck) Diagnostics summary: info=0, warning=0, error=1',
            'Error: Command not found in PATH: tscancode',
            '|42| == CoreTrace == [ERROR] Analysis incomplete: tscancode could not run (exit code 3)',
        ].join('\n');
        assert.deepStrictEqual(failedTools(output), ['tscancode']);
    });

    test('several tools in one line or several lines are all named once', () => {
        const output = 'Analysis incomplete: ikos, tscancode and coretrace-runtime-analyzer could not run (exit code 3)\n'
            + 'Error: Command not found in PATH: coretrace-runtime-analyzer';
        assert.deepStrictEqual(failedTools(output), ['ikos', 'tscancode', 'coretrace-runtime-analyzer']);
    });

    test('a complete run names no tool', () => {
        assert.deepStrictEqual(failedTools('[INFO] Verdict: info=0, warning=1, error=0, fail-on=error (exit code 0)'), []);
    });
});
