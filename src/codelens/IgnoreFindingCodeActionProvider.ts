import * as vscode from 'vscode';
import { getFindingForDiagnostic } from '../ctrace/DiagnosticsManager';

/** Offers "Ignore this finding" on CoreTrace diagnostics. */
export class IgnoreFindingCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        for (const diagnostic of context.diagnostics) {
            if (!diagnostic.source?.startsWith('CoreTrace')) { continue; }
            const finding = getFindingForDiagnostic(document.uri, diagnostic);
            if (!finding) { continue; }
            const label = finding.ruleId ? ` (${finding.ruleId})` : '';
            const action = new vscode.CodeAction(`CoreTrace: Ignore this finding${label}`, vscode.CodeActionKind.QuickFix);
            action.diagnostics = [diagnostic];
            action.command = {
                command: 'ctrace.ignoreFinding',
                title: 'Ignore this finding',
                arguments: [finding],
            };
            actions.push(action);
        }
        return actions;
    }
}
