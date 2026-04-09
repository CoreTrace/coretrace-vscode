import * as assert from 'assert';
import { parseAndValidateParams } from '../ctrace/CommandBuilder';

suite('CommandBuilder Test Suite', () => {
    test('Validates safe parameters correctly', () => {
        const result = parseAndValidateParams('--entry-points=main --log-level=debug --all');
        assert.deepStrictEqual(result, ['--entry-points=main', '--log-level=debug', '--all']);
    });

    test('Throws on malicious shell injections', () => {
        const maliciousPayloads = [
            '--flag && rm -rf /',
            '-I path; ls -la',
            '--out=$(whoami)',
            '--test `cat /etc/passwd`',
            '--option | grep root'
        ];

        for (const payload of maliciousPayloads) {
            assert.throws(() => {
                parseAndValidateParams(payload);
            }, /Unsafe CLI/, `Failed to block payload: ${payload}`);
        }
    });

    test('Handles empty or whitespace-only params', () => {
        assert.deepStrictEqual(parseAndValidateParams(''), []);
        assert.deepStrictEqual(parseAndValidateParams('    '), []);
    });
});
