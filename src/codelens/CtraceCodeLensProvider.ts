import * as vscode from 'vscode';
import { cleanFunctionName } from '../utils/symbolExtractor';
import { StackManager } from '../ctrace/StackManager';

const FUNCTION_KINDS = new Set([
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
]);

/** Adds Audit Function and Stack Footprint actions above C/C++ function definitions. */
export class CtraceCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor() {
        StackManager.instance.onDidUpdateStackData(() => {
            this._onDidChangeCodeLenses.fire();
        });
    }

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
                const lensRange = new vscode.Range(range.start.line, 0, range.start.line, 0);

                // 1. Audit Function Action
                lenses.push(new vscode.CodeLens(
                    lensRange,
                    {
                        title: '🛡️ Audit Function',
                        command: 'ctrace.auditFunction',
                        arguments: [documentUri, cleanName],
                    }
                ));

                // 2. Stack Footprint & Recursion Action
                const stackInfo = StackManager.instance.getFunction(cleanName);
                if (stackInfo) {
                    const recursionText = (stackInfo.isRecursive || stackInfo.hasInfiniteSelfRecursion)
                        ? '⚠️ Recursion: Cycle detected'
                        : 'Recursion: Safe';
                    
                    const footprintTitle = `📊 Stack: ~${stackInfo.maxStack} bytes (local: ${stackInfo.localStack}B) | ${recursionText}`;

                    lenses.push(new vscode.CodeLens(
                        lensRange,
                        {
                            title: footprintTitle,
                            command: 'ctrace.focusStackFunction',
                            arguments: [cleanName],
                            tooltip: `Peak stack usage: ${stackInfo.maxStack} bytes. Click to view in Stack Visualizer.`,
                        }
                    ));
                }
            }
        }
        if ('children' in symbol && symbol.children.length > 0) {
            collectFunctionLenses(symbol.children, lenses, documentUri);
        }
    }
}
