import * as path from 'path';
import * as vscode from 'vscode';

export type AnalysisProfile = 'fast' | 'full';
export type SmtBackend = 'interval' | 'z3' | 'cvc5';
export type SmtMode = 'single' | 'portfolio' | 'cross-check' | 'dual-consensus';

export interface CtraceUIState {
    scanMode?: 'file' | 'workspace';
    staticEnabled?: boolean;
    dynamicEnabled?: boolean;
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

/**
 * Converts Webview state and VS Code settings into safe ctrace CLI arguments.
 * The input file is added by CommandBuilder because it is different for each
 * file during a workspace scan.
 */
export function buildCtraceArgs(
    uiState: CtraceUIState,
    vscodeConfig: vscode.WorkspaceConfiguration
): string[] {
    const args: string[] = [
        '--entry-points=main',
        // `--analysis-profile=${validProfile(uiState.analysisProfile)}`,
        '--sarif-format',
        `--report-file=${requiredReportFile(uiState.reportFile)}`,
        // '--async',
    ];

    const entryPoints = (uiState.entryPoints ?? [])
        .filter((name, index, names): name is string =>
            typeof name === 'string' && cleanValue(name) !== undefined && names.indexOf(name) === index
        )
        .map(name => name.trim());
    const entryPointFlag = entryPoints.length > 0
        ? `--entry-points=${entryPoints.join(',')}`
        : '--entry-points=main';
    args[0] = entryPointFlag;

    if (uiState.staticEnabled !== false) { args.splice(1, 0, '--static'); }
    if (uiState.dynamicEnabled !== false) { args.splice(uiState.staticEnabled !== false ? 2 : 1, 0, '--dyn'); }

    const onlyFunction = cleanValue(uiState.onlyFunction);
    if (onlyFunction) { args.push(`--only-function=${onlyFunction}`); }

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

    args.push(...compileArgs(uiState.compilerExtraArgs));
    args.push(...compileArgs(uiState.extraIncludes, '-I'));
    args.push(...compileArgs(uiState.macros, '-D'));

    if (uiState.quiet === true) { args.push('--quiet'); }
    if (uiState.warningsOnly === true) { args.push('--warnings-only'); }
    if (uiState.timing === true) { args.push('--timing'); }
    if (uiState.demangle === true) { args.push('--demangle'); }
    if (uiState.dumpFilter === true) { args.push('--dump-filter'); }

    const invokedTools = (uiState.invokedTools ?? [])
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
