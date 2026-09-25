import type { StackFunction, StackReport, CallGraphNode, CallGraphEdge, CallChainStep } from '../types/stack';

/**
 * Parses ctrace-stack-analyzer outputs from either JSON report content or plaintext IR mode.
 */
export function parseStackReport(reportContent: string, sourceCode?: string): StackReport | null {
    if (!reportContent || !reportContent.trim()) {
        return null;
    }

    const trimmed = reportContent.trim();
    let functions: StackFunction[] = [];
    let stackLimit = 8388608;
    let inputFile: string | undefined;

    // Strategy 1: JSON output
    if (trimmed.startsWith('{') || trimmed.includes('"functions"')) {
        try {
            // Find root JSON object
            const startIdx = trimmed.indexOf('{');
            const endIdx = trimmed.lastIndexOf('}');
            if (startIdx !== -1 && endIdx > startIdx) {
                const jsonStr = trimmed.substring(startIdx, endIdx + 1);
                const parsed = JSON.parse(jsonStr);

                if (parsed.meta) {
                    stackLimit = typeof parsed.meta.stackLimit === 'number' ? parsed.meta.stackLimit : stackLimit;
                    inputFile = parsed.meta.inputFile || parsed.meta.inputFiles?.[0];
                }

                if (Array.isArray(parsed.functions)) {
                    functions = parsed.functions.map((f: any) => ({
                        name: String(f.name || 'unknown'),
                        file: f.file || inputFile,
                        localStack: Number(f.localStack) || 0,
                        localStackLowerBound: f.localStackLowerBound,
                        localStackUnknown: Boolean(f.localStackUnknown),
                        maxStack: Number(f.maxStack) || 0,
                        maxStackLowerBound: f.maxStackLowerBound,
                        maxStackUnknown: Boolean(f.maxStackUnknown),
                        hasDynamicAlloca: Boolean(f.hasDynamicAlloca),
                        isRecursive: Boolean(f.isRecursive),
                        hasInfiniteSelfRecursion: Boolean(f.hasInfiniteSelfRecursion),
                        exceedsLimit: Boolean(f.exceedsLimit),
                        callees: Array.isArray(f.callees) ? f.callees.filter((name: unknown) => typeof name === 'string') : undefined,
                    }));
                }
            }
        } catch (e) {
            console.warn('[StackParser] Failed to parse stack report as JSON, falling back to IR text parser:', e);
        }
    }

    // Strategy 2: Plaintext IR report fallback
    if (functions.length === 0) {
        functions = parseIrReportText(trimmed);
    }

    if (functions.length === 0) {
        return null;
    }

    // Locate function lines in source code if available
    if (sourceCode) {
        attachSourceLines(functions, sourceCode);
    }

    // Infer call graph and call chains
    const { nodes, edges, chains } = buildCallGraph(functions, sourceCode);

    const peakStack = functions.reduce((max, f) => Math.max(max, f.maxStack, f.localStack), 0);
    const recursiveCount = functions.filter(f => f.isRecursive || f.hasInfiniteSelfRecursion).length;

    return {
        inputFile,
        stackLimit,
        peakStack,
        recursiveCount,
        functions,
        callGraph: {
            nodes,
            edges,
            chains,
        },
    };
}

/**
 * Parses plaintext IR format, e.g.:
 * Function: test_vulnerability_no_compdb 
 *   local stack: 16 bytes
 *   max stack (including callees): 16 bytes
 */
function parseIrReportText(text: string): StackFunction[] {
    const list: StackFunction[] = [];
    const functionRegex = /Function:\s*([a-zA-Z0-9_:$~]+)[^\n]*\n\s*local stack:\s*(\d+)\s*bytes\n\s*max stack[^:]*:\s*(\d+)\s*bytes/g;
    let match: RegExpExecArray | null;

    while ((match = functionRegex.exec(text)) !== null) {
        const name = match[1].trim();
        const localStack = parseInt(match[2], 10) || 0;
        const maxStack = parseInt(match[3], 10) || localStack;
        const isRecursive = text.includes(`recursive or mutually recursive function detected`) && text.includes(name);

        list.push({
            name,
            localStack,
            maxStack,
            isRecursive,
        });
    }

    return list;
}

/**
 * Searches the source file for function definition line numbers.
 */
function attachSourceLines(functions: StackFunction[], sourceCode: string): void {
    for (const fn of functions) {
        const definition = findFunctionDefinition(sourceCode, fn.name);
        if (definition) {
            fn.line = sourceCode.slice(0, definition.index).split('\n').length;
        }
    }
}

function findFunctionDefinition(source: string, name: string): { index: number; bodyStart: number } | null {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\([^;{}]*\\)\\s*(?:const\\s*)?\\{`, 'g');
    const match = pattern.exec(source);
    return match ? { index: match.index, bodyStart: match.index + match[0].lastIndexOf('{') } : null;
}

/**
 * Reconstructs call hierarchy and call chains.
 */
function buildCallGraph(
    functions: StackFunction[],
    sourceCode?: string
): { nodes: CallGraphNode[]; edges: CallGraphEdge[]; chains: CallChainStep[][] } {
    const fnMap = new Map<string, StackFunction>();
    functions.forEach(f => fnMap.set(f.name, f));

    const nodes: CallGraphNode[] = functions.map(f => ({
        id: f.name,
        name: f.name,
        file: f.file,
        line: f.line,
        localStack: f.localStack,
        maxStack: f.maxStack,
        isRecursive: f.isRecursive,
        hasInfiniteSelfRecursion: f.hasInfiniteSelfRecursion,
        exceedsLimit: f.exceedsLimit,
    }));

    const edges: CallGraphEdge[] = [];
    const edgeSet = new Set<string>();

    const addEdge = (from: string, to: string, isRecursiveCycle = false) => {
        const key = `${from}->${to}`;
        if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({ from, to, isRecursiveCycle });

            const caller = fnMap.get(from);
            if (caller) {
                caller.callees = caller.callees || [];
                if (!caller.callees.includes(to)) { caller.callees.push(to); }
            }
            const callee = fnMap.get(to);
            if (callee) {
                callee.callers = callee.callers || [];
                if (!callee.callers.includes(from)) { callee.callers.push(from); }
            }
        }
    };

    // Prefer call relationships supplied by the analyzer when available.
    for (const fn of functions) {
        for (const callee of fn.callees ?? []) {
            if (fnMap.has(callee)) { addEdge(fn.name, callee, fn.name === callee); }
        }
    }

    // If source code is present, detect direct calls between known functions
    if (sourceCode && functions.length > 0) {
        const functionNames = functions.map(f => f.name);
        for (const caller of functions) {
            // Find function body in source code if line is known
            const body = extractFunctionSnippet(sourceCode, caller.name, caller.line);
            if (body) {
                for (const targetName of functionNames) {
                    const callPattern = new RegExp(`\\b${escapeRegExp(targetName)}\\s*\\(`, 'g');
                    if (callPattern.test(body)) {
                        const isCycle = (caller.name === targetName) || (caller.isRecursive && targetName === caller.name);
                        addEdge(caller.name, targetName, isCycle);
                    }
                }
            }
        }
    }

    // Stack size alone does not prove a call. Leave unconnected functions separate.

    // Build chains (caller -> callee paths)
    const chains: CallChainStep[][] = [];
    const maxChains = 64;
    const entryPoints = functions.filter(f => !f.callers || f.callers.length === 0);
    const startNodes = entryPoints.length > 0 ? entryPoints : functions.filter(f => f.name === 'main');
    const roots = startNodes.length > 0 ? startNodes : [functions[0]];

    for (const root of roots) {
        if (chains.length >= maxChains) { break; }
        const visited = new Set<string>();
        const currentPath: CallChainStep[] = [];

        function traverse(fnName: string, cumulative: number) {
            if (chains.length >= maxChains) { return; }
            const fn = fnMap.get(fnName);
            const local = fn ? fn.localStack : 0;
            const newCumulative = cumulative + local;
            const isCycle = visited.has(fnName);

            currentPath.push({
                name: fnName,
                localStack: local,
                cumulativeStack: newCumulative,
                isRecursive: fn?.isRecursive || isCycle,
            });

            if (isCycle) {
                chains.push([...currentPath]);
                currentPath.pop();
                return;
            }

            visited.add(fnName);
            const callees = fn?.callees?.filter(c => c !== fnName) || [];

            if (callees.length === 0) {
                chains.push([...currentPath]);
            } else {
                for (const callee of callees) {
                    traverse(callee, newCumulative);
                }
            }

            visited.delete(fnName);
            currentPath.pop();
        }

        traverse(root.name, 0);
    }

    // If no chains were formed (e.g. disjoint functions), make a 1-step chain per function
    if (chains.length === 0) {
        for (const fn of functions) {
            chains.push([{
                name: fn.name,
                localStack: fn.localStack,
                cumulativeStack: fn.maxStack,
                isRecursive: fn.isRecursive,
            }]);
        }
    }

    return { nodes, edges, chains };
}

function extractFunctionSnippet(source: string, fnName: string, _startLine?: number): string {
    const definition = findFunctionDefinition(source, fnName);
    if (!definition) { return ''; }
    let depth = 0;
    for (let i = definition.bodyStart; i < source.length; i++) {
        if (source[i] === '{') { depth++; }
        if (source[i] === '}') {
            depth--;
            if (depth === 0) { return source.slice(definition.bodyStart + 1, i); }
        }
    }
    return '';
}

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
