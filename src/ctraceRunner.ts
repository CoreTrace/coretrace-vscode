import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type AnalysisProfile = 'fast' | 'full';
export type SmtBackend = 'interval' | 'z3' | 'cvc5';
export type SmtMode = 'single' | 'portfolio' | 'cross-check' | 'dual-consensus';

export interface CtraceUIState {
    scanMode?: 'file' | 'workspace';
    staticEnabled?: boolean;
    dynamicEnabled?: boolean;
    staticTools?: string[];
    dynamicTools?: string[];
    autoEntryPoints?: boolean;
    entryPoints?: string[];
    onlyFunction?: string;
    onlyDir?: string;
    excludeDir?: string;
    includeStl?: boolean;
    resourceCrossTu?: boolean;
    compileCommandsPath?: string;
    compdbFast?: boolean;
    includeCompdbDeps?: boolean;
    compilerExtraArgs?: string;
    extraIncludes?: string;
    macros?: string;
    quiet?: boolean;
    warningsOnly?: boolean;
    timing?: boolean;
    demangle?: boolean;
    dumpFilter?: boolean;
    invokedTools?: string[];
    smtEnabled?: boolean;
    smtBackend?: SmtBackend;
    smtSecondaryBackend?: SmtBackend;
    smtMode?: SmtMode;
    smtTimeoutMs?: number;
    smtRules?: string;
    analysisProfile?: AnalysisProfile;
    reportFile: string;
    configFile?: string;
}

const DEFAULT_PROFILE: AnalysisProfile = 'full';
const DEFAULT_SMT_BACKEND: SmtBackend = 'interval';
const DEFAULT_SMT_MODE: SmtMode = 'single';
const ALLOWED_INVOKE_TOOLS = new Set([
    'ctrace_stack_analyzer',
    'cppcheck',
    'flawfinder',
    'ikos',
    'tscancode',
]);
const STATIC_TOOLS = ['cppcheck', 'flawfinder', 'ikos', 'tscancode'];
const DYNAMIC_TOOLS = ['ctrace_stack_analyzer'];

/**
 * Converts Webview state and VS Code settings into safe ctrace CLI arguments.
 * The input file is added by CommandBuilder because it is different for each
 * file during a workspace scan.
 */
export function buildCtraceArgs(
    uiState: CtraceUIState,
    vscodeConfig: vscode.WorkspaceConfiguration
): string[] {
    const args: string[] = [];

    const entryPoints = (uiState.entryPoints ?? [])
        .filter((name, index, names): name is string =>
            typeof name === 'string' && cleanValue(name) !== undefined && names.indexOf(name) === index
        )
        .map(name => name.trim());
    if (entryPoints.length > 0) {
        args.push(`--entry-points=${entryPoints.join(',')}`);
    }

    const staticTools = normalizeTools(uiState.staticTools, STATIC_TOOLS);
    const dynamicTools = normalizeTools(uiState.dynamicTools, DYNAMIC_TOOLS);
    const partialTools: string[] = [];

    if (uiState.staticEnabled !== false && staticTools.length === STATIC_TOOLS.length) {
        args.push('--static');
    } else if (uiState.staticEnabled !== false) {
        partialTools.push(...staticTools);
    }

    if (uiState.dynamicEnabled !== false && dynamicTools.length === DYNAMIC_TOOLS.length) {
        args.push('--dyn');
    } else if (uiState.dynamicEnabled !== false) {
        partialTools.push(...dynamicTools);
    }

    args.push('--sarif-format');
    args.push(`--report-file=${requiredReportFile(uiState.reportFile)}`);

    const onlyDir = cleanValue(uiState.onlyDir);
    if (onlyDir) { args.push(`--only-dir=${onlyDir}`); }

    const excludeDir = cleanValue(uiState.excludeDir);
    if (excludeDir) { args.push(`--exclude-dir=${excludeDir}`); }
    if (uiState.includeStl === true) { args.push('--STL'); }

    const compileCommandsPath = cleanValue(uiState.compileCommandsPath)
        ?? configString(vscodeConfig, 'compileCommandsPath');
    if (compileCommandsPath) { args.push(`--compile-commands=${compileCommandsPath}`); }

    if (uiState.compdbFast === true || vscodeConfig.get<boolean>('performance.compdbFast', false)) {
        args.push('--compdb-fast');
    }

    if (uiState.includeCompdbDeps === true) { args.push('--include-compdb-deps'); }

    const configFile = cleanValue(uiState.configFile);
    if (configFile) { args.push(`--config=${configFile}`); }

    if (uiState.quiet === true) { args.push('--quiet'); }
    if (uiState.warningsOnly === true) { args.push('--warnings-only'); }
    if (uiState.timing === true) { args.push('--timing'); }
    if (uiState.demangle === true) { args.push('--demangle'); }
    if (uiState.dumpFilter === true) { args.push('--dump-filter'); }

    const invokedTools = [...partialTools, ...(uiState.invokedTools ?? [])]
        .filter((tool, index, tools): tool is string =>
            typeof tool === 'string' &&
            ALLOWED_INVOKE_TOOLS.has(tool) &&
            tools.indexOf(tool) === index
        );
    if (invokedTools.length > 0) {
        args.push(`--invoke=${invokedTools.join(',')}`);
    }

    if (uiState.smtEnabled === true) {
        args.push(`--smt=on`);
        args.push(`--smt-backend=${validSmtBackend(uiState.smtBackend)}`);
        args.push(`--smt-secondary-backend=${validSmtBackend(uiState.smtSecondaryBackend)}`);
        args.push(`--smt-mode=${validSmtMode(uiState.smtMode)}`);
        const timeout = validPositiveInteger(uiState.smtTimeoutMs);
        if (timeout !== undefined) { args.push(`--smt-timeout-ms=${timeout}`); }
        const rules = cleanValue(uiState.smtRules);
        if (rules) { args.push(`--smt-rules=${rules}`); }
    } else {
        // args.push('--smt=off');
    }

    const escapeModel = configString(vscodeConfig, 'models.escapeModel');
    if (escapeModel) { args.push(`--escape-model=${escapeModel}`); }

    const bufferModel = configString(vscodeConfig, 'models.bufferModel');
    if (bufferModel) { args.push(`--buffer-model=${bufferModel}`); }

    const jobs = validPositiveInteger(vscodeConfig.get<number>('performance.jobs'));
    // if (jobs !== undefined) { args.push(`--jobs=${jobs}`); }

    const compileIrCacheDir = configString(vscodeConfig, 'performance.compileIrCacheDir');
    if (compileIrCacheDir) { args.push(`--compile-ir-cache-dir=${compileIrCacheDir}`); }

    const resourceModel = configString(vscodeConfig, 'models.resourceModel');
    if (resourceModel) { args.push(`--resource-model=${resourceModel}`); }

    const resourceCrossTu = uiState.resourceCrossTu !== undefined
        ? uiState.resourceCrossTu
        : vscodeConfig.get<boolean | undefined>('analysis.resourceCrossTu');
    if (resourceCrossTu === true) {
        args.push('--resource-cross-tu');
    } else if (resourceCrossTu === false) {
        // args.push('--no-resource-cross-tu');
    }

    const stackLimit = configValue(vscodeConfig, 'analysis.stackLimit');
    if (stackLimit !== undefined) { args.push(`--stack-limit=${stackLimit}`); }

    const resourceSummaryDir = configString(vscodeConfig, 'cache.resourceSummaryDir');
    if (resourceSummaryDir) { args.push(`--resource-summary-cache-dir=${resourceSummaryDir}`); }

    if (vscodeConfig.get<boolean>('cache.memoryOnly', false)) {
        args.push('--resource-summary-cache-memory-only');
    }

    return args;
}

/** Quotes each argument for the shell command used by the existing runner. */
export function shellQuoteArgs(args: string[]): string {
    return args.map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function cleanValue(value: unknown): string | undefined {
    if (typeof value !== 'string') { return undefined; }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTools(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) { return [...fallback]; }
    return value.filter((tool): tool is string => typeof tool === 'string' && fallback.includes(tool));
}

function configString(config: vscode.WorkspaceConfiguration, key: string): string | undefined {
    return cleanValue(config.get<string>(key));
}

function configValue(config: vscode.WorkspaceConfiguration, key: string): string | number | undefined {
    const value = config.get<string | number>(key);
    if (typeof value === 'number') { return Number.isFinite(value) ? value : undefined; }
    return cleanValue(value);
}

function requiredReportFile(value: string): string {
    const reportFile = cleanValue(value);
    if (!reportFile) {
        throw new Error('Ctrace reportFile is required to build SARIF arguments.');
    }
    return reportFile;
}

function compileArgs(value: unknown, prefix?: '-I' | '-D'): string[] {
    if (typeof value !== 'string') { return []; }

    return value
        .split(/[\n,;]+/)
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => `--compile-arg=${prefix ?? ''}${item}`);
}

function validProfile(value: unknown): AnalysisProfile {
    return value === 'fast' || value === 'full' ? value : DEFAULT_PROFILE;
}

function validSmtBackend(value: unknown): SmtBackend {
    return value === 'z3' || value === 'cvc5' || value === 'interval'
        ? value
        : DEFAULT_SMT_BACKEND;
}

function validSmtMode(value: unknown): SmtMode {
    return value === 'portfolio' || value === 'cross-check' || value === 'dual-consensus' || value === 'single'
        ? value
        : DEFAULT_SMT_MODE;
}

function validPositiveInteger(value: unknown): number | undefined {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(number) && number > 0 ? number : undefined;
}

export function createReportPath(extensionPath: string): string {
    return path.join(extensionPath, `.ctrace-report-${Date.now()}-${process.pid}.txt`);
}

export function createConfigPath(extensionPath: string): string {
    return path.join(extensionPath, `.ctrace-config-${Date.now()}-${process.pid}.json`);
}

function toInternalPath(p: string): string {
    let normalized = p.replace(/\\/g, '/');
    const uncMatch = normalized.match(/^\/{2,}[^\/]+\/([^\/]+)\/(.+)$/i);
    if (uncMatch) {
        return '/' + uncMatch[2];
    }
    const distroMatch = normalized.match(/^\/([^\/]+)\/(home|mnt|etc|usr|var|opt|tmp)\/(.+)$/i);
    if (distroMatch) {
        return '/' + distroMatch[2] + '/' + distroMatch[3];
    }
    return normalized;
}

export function generateConfigFileIfNeeded(
    configPath: string,
    uiState: CtraceUIState,
    workspaceRoot?: string
): boolean {
    const parseList = (val?: string) => {
        if (!val || typeof val !== 'string') { return []; }
        return val.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    };

    const internalRoot = workspaceRoot ? toInternalPath(workspaceRoot) : undefined;
    const rawIncludes = parseList(uiState.extraIncludes).map(s => s.replace(/^-I/, '').trim()).filter(Boolean);
    
    const includeDirs: string[] = [];
    const extraArgs: string[] = [];

    for (const item of rawIncludes) {
        const isAbsolute = path.isAbsolute(item) || item.startsWith('/') || item.startsWith('\\') || /^[a-zA-Z]:/.test(item);
        let resolved = item;
        if (internalRoot && !isAbsolute) {
            resolved = path.posix.join(internalRoot, item.replace(/\\/g, '/'));
        }
        const internal = toInternalPath(resolved);
        if (!includeDirs.includes(internal)) {
            includeDirs.push(internal);
            extraArgs.push(`-I${internal}`);
        }
        if (!isAbsolute && !includeDirs.includes(item)) {
            includeDirs.push(item);
            extraArgs.push(`-I${item}`);
        }
    }

    const defines = parseList(uiState.macros).map(s => s.replace(/^-D/, '').trim()).filter(Boolean);
    const compileArgs = parseList(uiState.compilerExtraArgs);
    const onlyFunctions = parseList(uiState.onlyFunction)
        .map(s => s.replace(/^--only-functions?=/, '').replace(/^--only-func=/, '').trim())
        .filter(Boolean);

    if (includeDirs.length === 0 && defines.length === 0 && compileArgs.length === 0 && onlyFunctions.length === 0) {
        return false;
    }

    const configData: Record<string, any> = {
        stack_analyzer: {}
    };
    if (includeDirs.length > 0) {
        configData.stack_analyzer.include_dirs = includeDirs;
        configData.stack_analyzer.extra_args = extraArgs;
    }
    if (defines.length > 0) {
        configData.stack_analyzer.defines = defines;
    }
    if (compileArgs.length > 0) {
        configData.stack_analyzer.compile_args = compileArgs;
    }
    if (onlyFunctions.length > 0) {
        configData.stack_analyzer.only_functions = onlyFunctions;
    }

    try {
        fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8');
        return true;
    } catch {
        return false;
    }
}
