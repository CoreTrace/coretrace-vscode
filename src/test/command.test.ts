import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseAndValidateParams, isWslAvailable, buildCommand } from '../ctrace/CommandBuilder';
import { cleanFunctionName } from '../utils/functionCleaner';

suite('CommandBuilder Test Suite', () => {
    test('Validates safe parameters correctly', () => {
        const result = parseAndValidateParams('--entry-points=main --log-level=debug --all');
        assert.deepStrictEqual(result, ['--entry-points=main', '--log-level=debug', '--all']);
    });

    test('Validates comma-separated entry points correctly', () => {
        const result = parseAndValidateParams('--entry-points=main,calculate_sum,MyClass::process');
        assert.deepStrictEqual(result, ['--entry-points=main,calculate_sum,MyClass::process']);
    });

    test('Rejects entry points containing function call parentheses', () => {
        assert.throws(() => {
            parseAndValidateParams('--entry-points=main()');
        }, /Unsafe CLI parameter rejected/);
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

    test('isWslAvailable returns a boolean without throwing', () => {
        const result = isWslAvailable();
        assert.strictEqual(typeof result, 'boolean');
    });

    test('buildCommand does not create temporary copies of source files', async () => {
        const dummyBin = path.join(__dirname, 'dummy_bin');
        const dummySrc = path.join(__dirname, 'dummy_src.c');
        fs.writeFileSync(dummyBin, 'echo test');
        fs.writeFileSync(dummySrc, 'int main() { return 0; }');
        try {
            const built = await buildCommand(dummyBin, dummySrc, '--report-file=rep.json');
            for (const tf of built.tempFiles) {
                assert.ok(!tf.includes('dummy_src'), `Input file was copied to temp: ${tf}`);
                assert.ok(!tf.includes('ctrace-input-'), `ctrace-input temp file was created: ${tf}`);
            }
            assert.ok(!built.command.includes('ctrace-input-'), 'Command references ctrace-input temp file');
        } finally {
            if (fs.existsSync(dummyBin)) { fs.unlinkSync(dummyBin); }
            if (fs.existsSync(dummySrc)) { fs.unlinkSync(dummySrc); }
        }
    });
});

suite('SymbolExtractor cleanFunctionName Test Suite', () => {
    test('Sanitizes simple and signature function names', () => {
        assert.strictEqual(cleanFunctionName('main'), 'main');
        assert.strictEqual(cleanFunctionName('main()'), 'main');
        assert.strictEqual(cleanFunctionName('int main()'), 'main');
        assert.strictEqual(cleanFunctionName('int main(int argc, char** argv)'), 'main');
    });

    test('Sanitizes namespaced and class methods', () => {
        assert.strictEqual(cleanFunctionName('void MyClass::processData(int x)'), 'MyClass::processData');
        assert.strictEqual(cleanFunctionName('ns::sub::Calculator::compute()'), 'ns::sub::Calculator::compute');
    });

    test('Sanitizes functions with return types and template syntax', () => {
        assert.strictEqual(cleanFunctionName('std::vector<int> get_items()'), 'get_items');
        assert.strictEqual(cleanFunctionName('char* get_name()'), 'get_name');
        assert.strictEqual(cleanFunctionName('template<typename T> void process<T>()'), 'process');
        assert.strictEqual(cleanFunctionName('virtual void execute() const noexcept override'), 'execute');
    });

    test('Handles edge cases (empty, undefined, invalid chars)', () => {
        assert.strictEqual(cleanFunctionName(''), '');
        assert.strictEqual(cleanFunctionName('   '), '');
        assert.strictEqual(cleanFunctionName('`whoami`()'), 'whoami');
    });
});

