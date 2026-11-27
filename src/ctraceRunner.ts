import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { cleanFunctionName } from './utils/symbolExtractor';

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
    reportFile?: string;
    configFile?: string;
    /** Set when the runtime analyzer cannot be found: the run's config must not ask for it either. */
    skipRuntimeAnalyzer?: boolean;
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
    'coretrace-python-analyzer',
]);
const STATIC_TOOLS = ['cppcheck', 'flawfinder', 'ikos', 'tscancode', 'ctrace_stack_analyzer', 'coretrace-python-analyzer'];
const DYNAMIC_TOOLS = ['coretrace-runtime-analyzer'];

export type SourceLanguage = 'c' | 'python';

export const PYTHON_ANALYZER = 'coretrace-python-analyzer';

/**
 * The tools that analyse each language. Only these are passed to ctrace for a
 * file: a ctrace older than 0.85 rejects the whole run when --invoke names the
 * Python analyzer, so C and C++ runs must never name it.
 */
const TOOLS_BY_LANGUAGE: Record<SourceLanguage, { static: string[]; dynamic: string[] }> = {
    c: { static: ['cppcheck', 'flawfinder', 'ikos', 'tscancode', 'ctrace_stack_analyzer'], dynamic: DYNAMIC_TOOLS },
    // The runtime analyzer builds and runs C and C++ programs only.
    python: { static: [PYTHON_ANALYZER], dynamic: [] },
};

const SOURCE_EXTENSIONS: Record<SourceLanguage, string[]> = {
    c: ['.c', '.cpp', '.cc', '.cxx'],
    python: ['.py'],
};
/** Headers can be analysed on their own when opened, but are not scanned in a workspace. */
const C_HEADER_EXTENSIONS = ['.h', '.hpp', '.hh'];

/** The language ctrace analyses a file as, or undefined when it cannot analyse it. */
export function sourceLanguage(filePath: string): SourceLanguage | undefined {
    const ext = path.extname(filePath).toLowerCase();
    if (SOURCE_EXTENSIONS.c.includes(ext) || C_HEADER_EXTENSIONS.includes(ext)) { return 'c'; }
    if (SOURCE_EXTENSIONS.python.includes(ext)) { return 'python'; }
    return undefined;
}

/** Brace list of the extensions a workspace scan looks for, e.g. "{c,cpp,py}". */
export function workspaceSourceExtensions(languages: SourceLanguage[]): string {
    return `{${languages.flatMap(language => SOURCE_EXTENSIONS[language]).map(ext => ext.slice(1)).join(',')}}`;
}

/** Python environments and caches: third-party code, not the user's. */
export const PYTHON_EXCLUDED_DIRS = ['.venv', 'venv', '__pycache__', 'site-packages', '.tox', '.nox', '.mypy_cache', '.pytest_cache'];

/**
 * Whether a run with these settings analyses files of `language`. C and C++
 * files are always sent, as before; Python files need the Python analyzer.
 */
export function analysesLanguage(uiState: CtraceUIState, language: SourceLanguage): boolean {
    if (language === 'c') { return true; }
    return uiState.staticEnabled !== false
        && (uiState.staticTools === undefined || uiState.staticTools.includes(PYTHON_ANALYZER));
}

/**
 * Converts Webview state and VS Code settings into safe ctrace CLI arguments.
 * The input file is added by CommandBuilder because it is different for each
 * file during a workspace scan.
 */
export function buildCtraceArgs(
    uiState: CtraceUIState,
    vscodeConfig: vscode.WorkspaceConfiguration,
    language: SourceLanguage = 'c'
): string[] {
    const args: string[] = [];

    const rawEntryPoints = (uiState.entryPoints ?? [])
        .flatMap(name => typeof name === 'string' ? name.split(',') : []);
    const entryPoints = rawEntryPoints
        .map(name => cleanFunctionName(name.trim()))
        .filter((name, index, names): name is string =>
            Boolean(name) && names.indexOf(name) === index
        );
    if (entryPoints.length > 0) {
        args.push(`--entry-points=${entryPoints.join(',')}`);
    }

    // Only the tools of this file's language count: a C run with every C
    // tool selected is a full --static run, whatever the Python analyzer says.
    const languageTools = TOOLS_BY_LANGUAGE[language];
    const staticTools = normalizeTools(uiState.staticTools, STATIC_TOOLS).filter(tool => languageTools.static.includes(tool));
    const dynamicTools = normalizeTools(uiState.dynamicTools, DYNAMIC_TOOLS).filter(tool => languageTools.dynamic.includes(tool));
    const partialTools: string[] = [];

    if (uiState.staticEnabled !== false && languageTools.static.length > 0 && staticTools.length === languageTools.static.length) {
        args.push('--static');
    } else if (uiState.staticEnabled !== false) {
        partialTools.push(...staticTools);
    }

    if (uiState.dynamicEnabled !== false && languageTools.dynamic.length > 0 && dynamicTools.length === languageTools.dynamic.length) {
        args.push('--dyn');
    } else if (uiState.dynamicEnabled !== false) {
        partialTools.push(...dynamicTools);
    }

    args.push('--sarif-format');
    args.push(`--report-file=${requiredReportFile(uiState.reportFile)}`);
    args.push(...profileArgs(uiState));

    const compileCommandsPath = cleanValue(uiState.compileCommandsPath)
        ?? configString(vscodeConfig, 'compileCommandsPath');
    if (compileCommandsPath) { args.push(`--compile-commands=${compileCommandsPath}`); }

    if (uiState.includeCompdbDeps === true) { args.push('--include-compdb-deps'); }

    const configFile = cleanValue(uiState.configFile);
    if (configFile) { args.push(`--config=${configFile}`); }

    if (uiState.quiet === true) { args.push('--quiet'); }
    if (uiState.timing === true) { args.push('--timing'); }
    if (uiState.demangle === true) { args.push('--demangle'); }

    const invokedTools = [...partialTools, ...(uiState.invokedTools ?? [])]
        .filter((tool, index, tools): tool is string =>
            typeof tool === 'string' &&
            ALLOWED_INVOKE_TOOLS.has(tool) &&
            (languageTools.static.includes(tool) || languageTools.dynamic.includes(tool)) &&
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

    const resourceModel = configString(vscodeConfig, 'models.resourceModel');
    if (resourceModel) { args.push(`--resource-model=${resourceModel}`); }

    const stackLimit = configValue(vscodeConfig, 'analysis.stackLimit');
    if (stackLimit !== undefined) { args.push(`--stack-limit=${stackLimit}`); }

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

function configString(config: vscode.WorkspaceConfiguration | undefined, key: string): string | undefined {
    return cleanValue(config?.get<string>(key));
}

/** Reads a boolean setting that may also be "on"/"off"/"default"; "default" means unset. */
function configTriState(config: vscode.WorkspaceConfiguration | undefined, key: string): boolean | undefined {
    const value = config?.get<unknown>(key);
    if (typeof value === 'boolean') { return value; }
    if (value === 'on') { return true; }
    if (value === 'off') { return false; }
    return undefined;
}

function configValue(config: vscode.WorkspaceConfiguration, key: string): string | number | undefined {
    const value = config.get<string | number>(key);
    if (typeof value === 'number') { return Number.isFinite(value) ? value : undefined; }
    return cleanValue(value);
}

function requiredReportFile(value?: string): string {
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

function profileArgs(uiState: CtraceUIState): string[] {
    return uiState.analysisProfile === undefined
        ? []
        : [`--analysis-profile=${validProfile(uiState.analysisProfile)}`];
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

export function createReportPath(scanDir: string): string {
    return path.join(scanDir, `.ctrace-report-${Date.now()}-${process.pid}.txt`);
}

export function createConfigPath(scanDir: string): string {
    return path.join(scanDir, `.ctrace-config-${Date.now()}-${process.pid}.json`);
}

/** The scan files could not be created: the analysis must not start without them. */
export class ScanSetupError extends Error {}

let scanDirOverride: string | undefined;
let tempScanDir: string | undefined;

export function setScanDirectoryForTesting(dir: string | undefined): void {
    scanDirOverride = dir;
}

/**
 * Returns a writable folder for the report and config files of a run.
 * The extension's install folder can be read-only, so they go to the
 * extension's storage, or to a private temporary folder as a fallback.
 * Both are host paths that CommandBuilder converts for WSL.
 */
export function prepareScanDirectory(storageDir: string | undefined): string {
    const tried: string[] = [];
    const usable = (dir: string): boolean => {
        tried.push(dir);
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.accessSync(dir, fs.constants.W_OK);
            return true;
        } catch {
            return false;
        }
    };

    if (scanDirOverride !== undefined) {
        if (usable(scanDirOverride)) { return scanDirOverride; }
    } else {
        const preferred = storageDir ? path.join(storageDir, 'scan') : undefined;
        if (preferred && usable(preferred)) { return preferred; }
        if (tempScanDir && usable(tempScanDir)) { return tempScanDir; }
        try {
            // mkdtemp: a fixed name in a shared /tmp could be planted by another user.
            tempScanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coretrace-scan-'));
            return tempScanDir;
        } catch {
            tried.push(path.join(os.tmpdir(), 'coretrace-scan-*'));
        }
    }
    throw new ScanSetupError(
        `CoreTrace found no writable folder for its scan files (tried: ${tried.join(', ')}). ` +
        'The analysis was not started. Check the permissions of these folders.'
    );
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
    // ctrace reads the config file inside WSL, where C:\x is /mnt/c/x.
    return normalized.replace(/^([a-zA-Z]):(?=\/|$)/, (_match, drive: string) => `/mnt/${drive.toLowerCase()}`);
}

/**
 * Writes the JSON config that carries the settings ctrace has no CLI flag
 * for (include directories, macros, filters…).
 *
 * @returns false when no setting needs a config file, true once it is written.
 * @throws ScanSetupError when it cannot be written: running without it would
 *         silently drop the requested settings.
 */
/** Turns the runtime analyzer off in a ctrace config; returns whether it was on. */
function removeRuntimeAnalyzer(configData: Record<string, any>): boolean {
    const analysis = configData.analysis;
    if (typeof analysis !== 'object' || analysis === null) { return false; }
    const invoke: unknown[] = typeof analysis.invoke === 'string' ? [analysis.invoke] : Array.isArray(analysis.invoke) ? analysis.invoke : [];
    const invoked = invoke.filter(tool => !DYNAMIC_TOOLS.includes(tool as string));
    if (analysis.dynamic !== true && invoked.length === invoke.length) { return false; }
    analysis.dynamic = false;
    if (analysis.invoke !== undefined) { analysis.invoke = invoked; }
    return true;
}

export function generateConfigFileIfNeeded(
    configPath: string,
    uiState: CtraceUIState,
    workspaceRoot?: string,
    vscodeConfig?: vscode.WorkspaceConfiguration
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

    // ctrace does not run from the workspace, so a relative directory would
    // match nothing: only_dirs would hide every function and exclude_dirs no file.
    const resolveDir = (dir: string): string => {
        const isAbsolute = path.isAbsolute(dir) || dir.startsWith('/') || /^[a-zA-Z]:/.test(dir);
        const resolved = internalRoot && !isAbsolute ? path.posix.join(internalRoot, dir.replace(/\\/g, '/')) : dir;
        return toInternalPath(resolved).replace(/(?<=.)\/+$/, '');
    };
    const onlyDirs = parseList(uiState.onlyDir).map(resolveDir);
    const excludeDirs = parseList(uiState.excludeDir).map(resolveDir);
    const includeStl = uiState.includeStl === true;
    const compdbFast = uiState.compdbFast === true || (vscodeConfig?.get<boolean>('performance.compdbFast', false) ?? false);
    const dumpFilter = uiState.dumpFilter === true;
    const warningsOnly = uiState.warningsOnly === true;
    const compileIrCacheDir = configString(vscodeConfig, 'performance.compileIrCacheDir');
    const resourceCrossTu = uiState.resourceCrossTu !== undefined
        ? uiState.resourceCrossTu
        : configTriState(vscodeConfig, 'analysis.resourceCrossTu');
    const resourceSummaryDir = configString(vscodeConfig, 'cache.resourceSummaryDir');
    const resourceSummaryMemoryOnly = vscodeConfig?.get<boolean>('cache.memoryOnly', false);

    const hasAnyConfig = (
        includeDirs.length > 0 ||
        defines.length > 0 ||
        compileArgs.length > 0 ||
        onlyFunctions.length > 0 ||
        onlyDirs.length > 0 ||
        excludeDirs.length > 0 ||
        includeStl ||
        compdbFast ||
        dumpFilter ||
        warningsOnly ||
        Boolean(compileIrCacheDir) ||
        resourceCrossTu !== undefined ||
        Boolean(resourceSummaryDir) ||
        Boolean(resourceSummaryMemoryOnly)
    );

    let configData: Record<string, any> = {};
    if (uiState.configFile && fs.existsSync(uiState.configFile)) {
        try {
            configData = JSON.parse(fs.readFileSync(uiState.configFile, 'utf8'));
        } catch {
            configData = {};
        }
    }
    // The user's file can enable dynamic analysis on its own: ctrace would
    // still start the missing analyzer, so the run gets a copy without it.
    const dropsRuntimeAnalyzer = uiState.skipRuntimeAnalyzer === true && removeRuntimeAnalyzer(configData);

    if (!hasAnyConfig && !dropsRuntimeAnalyzer) {
        return false;
    }
    if (!configData.stack_analyzer) {
        configData.stack_analyzer = {};
    }

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
    if (onlyDirs.length > 0) {
        configData.stack_analyzer.only_dirs = onlyDirs;
    }
    if (excludeDirs.length > 0) {
        configData.stack_analyzer.exclude_dirs = excludeDirs;
    }
    if (includeStl) {
        configData.stack_analyzer.include_stl = true;
    }
    if (compdbFast) {
        configData.stack_analyzer.compdb_fast = true;
    }
    if (dumpFilter) {
        configData.stack_analyzer.dump_filter = true;
    }
    if (warningsOnly) {
        configData.stack_analyzer.warnings_only = true;
    }
    if (compileIrCacheDir) {
        configData.stack_analyzer.compile_ir_cache_dir = compileIrCacheDir;
    }
    if (resourceCrossTu !== undefined) {
        configData.stack_analyzer.resource_cross_tu = resourceCrossTu;
    }
    if (resourceSummaryDir) {
        configData.stack_analyzer.resource_summary_cache_dir = resourceSummaryDir;
    }
    if (resourceSummaryMemoryOnly) {
        configData.stack_analyzer.resource_summary_cache_memory_only = true;
    }

    try {
        fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8');
        return true;
    } catch (e) {
        const requested = [
            [includeDirs.length > 0, 'include directories'],
            [defines.length > 0, 'macros'],
            [compileArgs.length > 0, 'compiler arguments'],
            [onlyFunctions.length > 0, 'function filter'],
            [onlyDirs.length > 0 || excludeDirs.length > 0, 'directory filters'],
            [includeStl || compdbFast || dumpFilter || warningsOnly, 'analysis options'],
            [Boolean(compileIrCacheDir || resourceSummaryDir || resourceSummaryMemoryOnly) || resourceCrossTu !== undefined, 'cache and cross-file settings'],
        ].filter(([wanted]) => wanted).map(([, label]) => label);
        throw new ScanSetupError(
            `CoreTrace could not write its analysis configuration to ${configPath} (${(e as Error).message}). ` +
            `The analysis was not started, because it would have ignored these settings: ${requested.join(', ')}. ` +
            'Check that this folder is writable.'
        );
    }
}

/**
 * Builds arguments to invoke only ctrace_stack_analyzer without --sarif-format.
 * This guarantees that ctrace outputs the full call graph and function stack sizes
 * to stdout, even when the primary analysis is executed in SARIF mode.
 */
export function buildStackAnalyzerArgs(
    uiState: CtraceUIState,
    vscodeConfig?: vscode.WorkspaceConfiguration
): string[] {
    const args: string[] = ['--invoke=ctrace_stack_analyzer', ...profileArgs(uiState)];

    const rawEntryPoints = (uiState.entryPoints ?? [])
        .flatMap(name => typeof name === 'string' ? name.split(',') : []);
    const entryPoints = rawEntryPoints
        .map(name => cleanFunctionName(name.trim()))
        .filter((name, index, names): name is string =>
            Boolean(name) && names.indexOf(name) === index
        );
    if (entryPoints.length > 0) {
        args.push(`--entry-points=${entryPoints.join(',')}`);
    }

    const compileCommandsPath = cleanValue(uiState.compileCommandsPath)
        ?? configString(vscodeConfig, 'compileCommandsPath');
    if (compileCommandsPath) { args.push(`--compile-commands=${compileCommandsPath}`); }

    if (uiState.includeCompdbDeps === true) { args.push('--include-compdb-deps'); }

    const configFile = cleanValue(uiState.configFile);
    if (configFile) { args.push(`--config=${configFile}`); }

    if (uiState.timing === true) { args.push('--timing'); }
    if (uiState.demangle === true) { args.push('--demangle'); }

    if (uiState.smtEnabled === true) {
        args.push(`--smt=on`);
        args.push(`--smt-backend=${validSmtBackend(uiState.smtBackend)}`);
        args.push(`--smt-secondary-backend=${validSmtBackend(uiState.smtSecondaryBackend)}`);
        args.push(`--smt-mode=${validSmtMode(uiState.smtMode)}`);
        const timeout = validPositiveInteger(uiState.smtTimeoutMs);
        if (timeout !== undefined) { args.push(`--smt-timeout-ms=${timeout}`); }
        const rules = cleanValue(uiState.smtRules);
        if (rules) { args.push(`--smt-rules=${rules}`); }
    }

    // The Stack Tree flags the functions over this limit.
    if (vscodeConfig) {
        const stackLimit = configValue(vscodeConfig, 'analysis.stackLimit');
        if (stackLimit !== undefined) { args.push(`--stack-limit=${stackLimit}`); }
    }

    return args;
}
