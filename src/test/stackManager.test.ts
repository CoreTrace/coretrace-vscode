import * as assert from 'assert';
import { StackManager } from '../ctrace/StackManager';

suite('StackManager Test Suite', () => {
    teardown(() => StackManager.instance.clear());

    const fn = (name: string, file: string | undefined, maxStack: number) =>
        ({ name, file, localStack: maxStack, maxStack, isRecursive: false });

    test('CodeLens gets the definition of the file it is shown in', () => {
        StackManager.instance.updateStackData({
            peakStack: 32, recursiveCount: 0,
            functions: [fn('helper', '/w/a.c', 16), fn('helper', '/w/b.c', 32)],
        });
        assert.strictEqual(StackManager.instance.getFunction('helper', '/w/a.c')?.maxStack, 16);
        assert.strictEqual(StackManager.instance.getFunction('helper', '/w/b.c')?.maxStack, 32);
        // c.c has no helper of its own: another file's is not shown there.
        assert.strictEqual(StackManager.instance.getFunction('helper', '/w/c.c'), undefined);
    });

    test('a definition whose file is unknown is still found', () => {
        StackManager.instance.updateStackData({ peakStack: 8, recursiveCount: 0, functions: [fn('inline_fn', undefined, 8)] });
        assert.strictEqual(StackManager.instance.getFunction('inline_fn', '/w/a.h')?.maxStack, 8);
        assert.strictEqual(StackManager.instance.getFunction('inline_fn')?.maxStack, 8);
    });
});
