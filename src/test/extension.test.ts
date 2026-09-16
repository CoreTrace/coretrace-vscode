import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Activation & Integration Test Suite', () => {

    test('Extension should be present', () => {
        const extension = vscode.extensions.getExtension('CoreTrace.ctrace-audit');
        assert.ok(extension, 'Extension not found. Check the publisher.name in package.json.');
    });

    test('Extension should activate successfully', async () => {
        const extension = vscode.extensions.getExtension('CoreTrace.ctrace-audit');
        assert.ok(extension, 'Extension not found. Cannot activate.');
        
        // Will throw if activation fails (e.g. fs access errors, dependency crashes)
        await extension.activate();
        assert.strictEqual(extension.isActive, true, 'Extension failed to switch to active state.');
    });

    test('Extension registers all expected commands', async () => {
        const extension = vscode.extensions.getExtension('CoreTrace.ctrace-audit');
        assert.ok(extension, 'Extension not found. Cannot check commands.');
        await extension.activate();
        
        // This will grab all registered commands in vscode
        const commands = await vscode.commands.getCommands();

        assert.ok(commands.includes('ctrace.runAnalysis'), 'Command ctrace.runAnalysis is missing');
        assert.ok(commands.includes('ctrace.runWorkspaceAnalysis'), 'Command ctrace.runWorkspaceAnalysis is missing');
        assert.ok(commands.includes('ctrace.clearAnalysisCache'), 'Command ctrace.clearAnalysisCache is missing');
    });
});
