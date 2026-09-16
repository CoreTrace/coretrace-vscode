import * as vscode from 'vscode';

const FUNCTION_KINDS = new Set([
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
]);

/** Extracts function and method names from a document symbol tree. */
export async function getFunctionSymbols(document: vscode.TextDocument): Promise<string[]> {
    const symbols = await vscode.commands.executeCommand<readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
    );

    if (!symbols) { return []; }

    const names: string[] = [];
    collectFunctionNames(symbols, names);
    return [...new Set(names)].filter(Boolean);
}

function collectFunctionNames(
    symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
    names: string[]
): void {
    for (const symbol of symbols) {
        if (FUNCTION_KINDS.has(symbol.kind)) {
            names.push(symbol.name);
        }
        if ('children' in symbol && symbol.children.length > 0) {
            collectFunctionNames(symbol.children, names);
        }
    }
}
