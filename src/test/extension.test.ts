import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Activation & Integration Test Suite', function () {
    this.timeout(20000);

    test('Extension should be present', () => {
        const extension = vscode.extensions.getExtension('CoreTrace.coretrace-audit');
        assert.ok(extension, 'Extension not found. Check the publisher.name in package.json.');
    });

    test('Extension should activate successfully', async () => {
        const extension = vscode.extensions.getExtension('CoreTrace.coretrace-audit');
        assert.ok(extension, 'Extension not found. Cannot activate.');
        
        // Will throw if activation fails (e.g. fs access errors, dependency crashes)
        await extension.activate();
        assert.strictEqual(extension.isActive, true, 'Extension failed to switch to active state.');
    });

    test('Sidebar view opens in VS Code', async () => {
        const extension = vscode.extensions.getExtension('CoreTrace.coretrace-audit');
        assert.ok(extension);
        await extension.activate();
        await vscode.commands.executeCommand('workbench.view.extension.ctrace-sidebar-view');
        await vscode.commands.executeCommand('ctrace-audit-view.focus');
    });

    test('Extension registers all expected commands', async () => {
        const extension = vscode.extensions.getExtension('CoreTrace.coretrace-audit');
        assert.ok(extension, 'Extension not found. Cannot check commands.');
        await extension.activate();
        
        // This will grab all registered commands in vscode
        const commands = await vscode.commands.getCommands();

        assert.ok(commands.includes('ctrace.runAnalysis'), 'Command ctrace.runAnalysis is missing');
        assert.ok(commands.includes('ctrace.runWorkspaceAnalysis'), 'Command ctrace.runWorkspaceAnalysis is missing');
        assert.ok(commands.includes('ctrace.clearAnalysisCache'), 'Command ctrace.clearAnalysisCache is missing');
        assert.ok(commands.includes('ctrace.installDependencies'), 'Command ctrace.installDependencies is missing');
        assert.ok(commands.includes('ctrace.focusStackFunction'), 'Command ctrace.focusStackFunction is missing');
    });
});
