import * as vscode from 'vscode';
import { cleanFunctionName } from '../utils/symbolExtractor';

const FUNCTION_KINDS = new Set([
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
]);

/** Adds an Audit Function action above C/C++ function definitions. */
export class CtraceCodeLensProvider implements vscode.CodeLensProvider {
    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        const symbols = await vscode.commands.executeCommand<readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>(
            'vscode.executeDocumentSymbolProvider',
            document.uri
        );
        if (!symbols) { return []; }

        const lenses: vscode.CodeLens[] = [];
        collectFunctionLenses(symbols, lenses, document.uri);
        return lenses;
    }
}

function collectFunctionLenses(
    symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
    lenses: vscode.CodeLens[],
    documentUri: vscode.Uri
): void {
    for (const symbol of symbols) {
        if (FUNCTION_KINDS.has(symbol.kind)) {
            const cleanName = cleanFunctionName(symbol.name);
            if (cleanName) {
                const range = 'range' in symbol ? symbol.range : symbol.location.range;
                lenses.push(new vscode.CodeLens(
                    new vscode.Range(range.start.line, 0, range.start.line, 0),
                    {
                        title: '🛡️ Audit Function',
                        command: 'ctrace.auditFunction',
                        arguments: [documentUri, cleanName],
                    }
                ));
            }
        }
        if ('children' in symbol && symbol.children.length > 0) {
            collectFunctionLenses(symbol.children, lenses, documentUri);
        }
    }
}
