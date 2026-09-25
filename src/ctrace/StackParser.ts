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
    const lines = sourceCode.split('\n');
    for (const fn of functions) {
        // Look for e.g. "int funcA(" or "void funcA(" or "funcA("
        const pattern = new RegExp(`\\b${escapeRegExp(fn.name)}\\s*\\(`, 'm');
        for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
                fn.line = i + 1;
                break;
            }
        }
    }
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

    // Fallback: If no edges found from source code, deduce from stack relationships
    if (edges.length === 0 && functions.length > 1) {
        // Sort descending by maxStack
        const sorted = [...functions].sort((a, b) => b.maxStack - a.maxStack);
        for (let i = 0; i < sorted.length - 1; i++) {
            const caller = sorted[i];
            const next = sorted[i + 1];
            // If caller's maxStack is greater than next's maxStack, and difference matches or exceeds caller.localStack
            if (caller.maxStack > next.maxStack) {
                addEdge(caller.name, next.name, false);
            }
        }
    }

    // Add self-recursion edges
    for (const f of functions) {
        if (f.isRecursive || f.hasInfiniteSelfRecursion) {
            addEdge(f.name, f.name, true);
        }
    }

    // Build chains (caller -> callee paths)
    const chains: CallChainStep[][] = [];
    const entryPoints = functions.filter(f => !f.callers || f.callers.length === 0);
    const startNodes = entryPoints.length > 0 ? entryPoints : functions.filter(f => f.name === 'main');
    const roots = startNodes.length > 0 ? startNodes : [functions[0]];

    for (const root of roots) {
        const visited = new Set<string>();
        const currentPath: CallChainStep[] = [];

        function traverse(fnName: string, cumulative: number) {
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

function extractFunctionSnippet(source: string, fnName: string, startLine?: number): string {
    const lines = source.split('\n');
    let idx = (startLine && startLine > 0) ? startLine - 1 : -1;

    if (idx === -1) {
        const regex = new RegExp(`\\b${escapeRegExp(fnName)}\\s*\\(`, 'm');
        for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
                idx = i;
                break;
            }
        }
    }

    if (idx === -1) { return ''; }

    // Read until matching braces
    let openBraces = 0;
    let started = false;
    const bodyLines: string[] = [];

    for (let i = idx; i < lines.length && i < idx + 200; i++) {
        const line = lines[i];
        bodyLines.push(line);
        for (const ch of line) {
            if (ch === '{') {
                openBraces++;
                started = true;
            } else if (ch === '}') {
                openBraces--;
            }
        }
        if (started && openBraces <= 0) {
            break;
        }
    }

    return bodyLines.join('\n');
}

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
