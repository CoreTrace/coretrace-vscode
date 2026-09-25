export interface StackFunction {
    name: string;
    file?: string;
    line?: number;
    localStack: number;
    localStackLowerBound?: number | null;
    localStackUnknown?: boolean;
    maxStack: number;
    maxStackLowerBound?: number | null;
    maxStackUnknown?: boolean;
    hasDynamicAlloca?: boolean;
    isRecursive: boolean;
    hasInfiniteSelfRecursion?: boolean;
    exceedsLimit?: boolean;
    callees?: string[];
    callers?: string[];
}

export interface CallGraphNode {
    id: string;
    name: string;
    file?: string;
    line?: number;
    localStack: number;
    maxStack: number;
    isRecursive: boolean;
    hasInfiniteSelfRecursion?: boolean;
    exceedsLimit?: boolean;
}

export interface CallGraphEdge {
    from: string;
    to: string;
    isRecursiveCycle?: boolean;
}

export interface CallChainStep {
    name: string;
    localStack: number;
    cumulativeStack: number;
    isRecursive?: boolean;
}

export interface StackReport {
    inputFile?: string;
    stackLimit?: number;
    peakStack: number;
    recursiveCount: number;
    functions: StackFunction[];
    callGraph?: {
        nodes: CallGraphNode[];
        edges: CallGraphEdge[];
        chains: CallChainStep[][];
    };
    rawMeta?: Record<string, unknown>;
}
