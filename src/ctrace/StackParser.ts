import type { StackFunction, StackReport, CallGraphNode, CallGraphEdge, CallChainStep } from '../types/stack';
import { cleanFunctionName } from '../utils/functionCleaner';

/**
 * Parses ctrace-stack-analyzer outputs from either JSON report content or plaintext IR mode.
 */
/**
 * @param sourceFile Path of the analysed file. Functions defined in
 *                   `sourceCode` that the report gives no file for get it,
 *                   so the Stack Tree can jump to them.
 */
export function parseStackReport(reportContent: string, sourceCode?: string, sourceFile?: string): StackReport | null {
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
                        name: cleanFunctionName(String(f.name || 'unknown')) || String(f.name || 'unknown'),
                        file: f.file || inputFile,
                        localStack: Number(f.localStack) || 0,
                        localStackLowerBound: f.localStackLowerBound,
                        localStackUnknown: Boolean(f.localStackUnknown),
                        maxStack: Number(f.maxStack) || (typeof f.maxStackLowerBound === 'number' ? f.maxStackLowerBound : (Number(f.localStack) || 0)),
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
        attachSourceLines(functions, sourceCode, sourceFile);
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
    const functionRegex = /Function:\s*([^\n\r]+?)(?:\s*\r?\n)\s*local stack:\s*(\d+)\s*bytes\r?\n\s*max stack[^:]*:\s*(?:unknown\s*(?:\(>=\s*)?)?(\d+)\s*bytes/g;
    let match: RegExpExecArray | null;

    while ((match = functionRegex.exec(text)) !== null) {
        const rawName = match[1].trim();
        const parts = rawName.split(/\s+/);
        const nameToClean = parts.length > 1 && parts[0].startsWith('_Z') ? parts.slice(1).join(' ') : rawName;
        const name = cleanFunctionName(nameToClean) || rawName;
        const localStack = parseInt(match[2], 10) || 0;
        const maxStack = parseInt(match[3], 10) || localStack;

        const nextFunction = text.indexOf('Function:', functionRegex.lastIndex);
        const block = text.slice(match.index, nextFunction < 0 ? undefined : nextFunction);
        const isRecursive = block.includes('recursive or mutually recursive function detected');

        list.push({
            name,
            localStack,
            maxStack,
            isRecursive,
            exceedsLimit: /exceeds limit of \d+ bytes/.test(block),
        });
    }

    return list;
}

/**
 * Searches the source file for function definition line numbers.
 */
function attachSourceLines(functions: StackFunction[], sourceCode: string, sourceFile?: string): void {
    for (const fn of functions) {
        const definition = findFunctionDefinition(sourceCode, fn.name);
        if (definition) {
            fn.line = sourceCode.slice(0, definition.index).split('\n').length;
            if (!fn.file && sourceFile) { fn.file = sourceFile; }
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
    // Callees are ids: names in a single-file report, see StackFunction.id.
    const idOf = (f: StackFunction) => f.id ?? f.name;
    const fnMap = new Map<string, StackFunction>();
    functions.forEach(f => fnMap.set(idOf(f), f));

    const nodes: CallGraphNode[] = functions.map(f => ({
        id: idOf(f),
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
            if (fnMap.has(callee)) { addEdge(idOf(fn), callee, idOf(fn) === callee); }
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
                name: fn?.name ?? fnName,
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

        traverse(idOf(root), 0);
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

/**
 * Merges multiple stack reports (from individual files) into a unified workspace stack report.
 */
export function mergeStackReports(reports: StackReport[]): StackReport | null {
    if (!reports || reports.length === 0) { return null; }
    if (reports.length === 1) { return reports[0]; }

    // A function is identified by its name and the file defining it: two
    // translation units can each have their own `static int helper()`.
    // Functions without a known file (e.g. inline ones from a header) are
    // merged by name, as the same definition seen from several files.
    const identityOf = (fn: StackFunction) => fn.file ? `${fn.name}\u0000${fn.file}` : fn.name;
    const merged = new Map<string, StackFunction>();
    const identitiesByName = new Map<string, Set<string>>();
    let peakStack = 0;
    let recursiveCount = 0;
    let stackLimit = 8388608;

    for (const report of reports) {
        if (!report) { continue; }
        if (report.peakStack > peakStack) {
            peakStack = report.peakStack;
        }
        if (typeof report.stackLimit === 'number') {
            stackLimit = report.stackLimit;
        }
        recursiveCount += report.recursiveCount || 0;

        for (const fn of report.functions || []) {
            const identity = identityOf(fn);
            if (!identitiesByName.has(fn.name)) { identitiesByName.set(fn.name, new Set()); }
            identitiesByName.get(fn.name)!.add(identity);
            const existing = merged.get(identity);
            if (!existing) {
                merged.set(identity, { ...fn, callees: [], callers: [] });
            } else {
                existing.localStack = Math.max(existing.localStack, fn.localStack);
                existing.maxStack = Math.max(existing.maxStack, fn.maxStack);
                existing.isRecursive = existing.isRecursive || fn.isRecursive;
                existing.hasInfiniteSelfRecursion = existing.hasInfiniteSelfRecursion || fn.hasInfiniteSelfRecursion;
                existing.hasDynamicAlloca = existing.hasDynamicAlloca || fn.hasDynamicAlloca;
                existing.exceedsLimit = existing.exceedsLimit || fn.exceedsLimit;
                if (!existing.file && fn.file) { existing.file = fn.file; }
                if (!existing.line && fn.line) { existing.line = fn.line; }
            }
        }
    }

    // Ids stay plain names unless a name has several definitions.
    for (const fn of merged.values()) {
        fn.id = identitiesByName.get(fn.name)!.size > 1 && fn.file ? `${fn.name}@${fn.file}` : fn.name;
    }

    // Calls are resolved within the report that saw them: a call to `helper`
    // from a.c goes to a.c's helper. A name defined elsewhere only once is an
    // external function; a name defined in several other files is ambiguous
    // and left unlinked rather than guessed.
    for (const report of reports) {
        if (!report) { continue; }
        const local = new Map((report.functions || []).map(fn => [fn.name, merged.get(identityOf(fn))!]));
        for (const fn of report.functions || []) {
            const caller = merged.get(identityOf(fn))!;
            for (const calleeName of fn.callees ?? []) {
                const callee = local.get(calleeName) ?? uniqueByName(calleeName);
                if (callee && !caller.callees!.includes(callee.id!)) { caller.callees!.push(callee.id!); }
            }
        }
    }

    function uniqueByName(name: string): StackFunction | undefined {
        const identities = identitiesByName.get(name);
        return identities && identities.size === 1 ? merged.get([...identities][0]) : undefined;
    }

    const functions = Array.from(merged.values());
    if (functions.length === 0) { return null; }

    const { nodes, edges, chains } = buildCallGraph(functions);

    return {
        inputFile: 'workspace',
        stackLimit,
        peakStack,
        recursiveCount,
        functions,
        callGraph: { nodes, edges, chains },
    };
}
