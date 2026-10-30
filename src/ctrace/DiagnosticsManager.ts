import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SarifLog, SarifResultProperties } from '../types/sarif';
import { computeFingerprint, relativeFindingPath } from './FindingIgnoreList';

/** What the "Ignore finding" quick fix needs to know about a published diagnostic. */
export interface FindingRef {
    fingerprint: string;
    ruleId?: string;
    /** Absolute path of the file the diagnostic is shown in. */
    file: string;
    /** 1-based line. */
    line: number;
    message?: string;
}

export interface UpdateDiagnosticsOptions {
    /** Results whose fingerprint is ignored are not published. */
    isIgnored?: (fingerprint: string) => boolean;
}

// Diagnostics shown in the editor → finding they come from. Looked up by
// value (uri, position, message) because VS Code hands code-action providers
// copies of the diagnostics, not the published instances.
const findingsByDiagnostic = new Map<string, FindingRef>();

/** Clears the collection and the finding lookup used by code actions. */
export function clearDiagnostics(collection: vscode.DiagnosticCollection): void {
    collection.clear();
    findingsByDiagnostic.clear();
}

export function getFindingForDiagnostic(uri: vscode.Uri, diagnostic: vscode.Diagnostic): FindingRef | undefined {
    return findingsByDiagnostic.get(lookupKey(uri, diagnostic));
}

/**
 * Translates a SARIF result set into VS Code Diagnostics and updates the
 * provided DiagnosticCollection.
 *
 * Each result is mapped to its actual file path as declared in the SARIF
 * artifactLocation.uri field (resolved relative to workspace root or analysedFilePath).
 * Falls back to analysedFilePath when no URI is present.
 *
 * Every result is annotated in place with `properties.ctraceTool`,
 * `properties.ctraceFingerprint` and `properties.ctraceIgnored`, which the
 * sidebar uses to show and hide findings.
 *
 * @param clearFirst  Set to false when calling inside a workspace scan loop
 *                    to avoid wiping earlier results. Caller must clear once
 *                    before the loop instead.
 */
export function updateDiagnostics(
    sarifData: SarifLog | any,
    collection: vscode.DiagnosticCollection,
    analysedFilePath: string,
    clearFirst = true,
    options: UpdateDiagnosticsOptions = {}
): void {
    if (clearFirst) { clearDiagnostics(collection); }

    if (!sarifData?.runs?.length) { return; }

    // Group diagnostics by resolved absolute file path
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const findingsByFile = new Map<string, Map<vscode.Diagnostic, FindingRef>>();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const lineReader = createLineReader();

    for (const run of sarifData.runs) {
        const toolName: string | undefined = run?.tool?.driver?.name;
        for (const result of run?.results ?? []) {
            const physLoc = result.locations?.[0]?.physicalLocation;
            const region  = physLoc?.region;
            if (!region) { continue; }

            const targetFile = resolveResultFile(physLoc?.artifactLocation?.uri, analysedFilePath, workspaceRoot);

            // ── Build range (SARIF lines are 1-based) ────────────────────────────
            const startLine = Math.max(0, (region.startLine ?? 1) - 1);
            const startCol  = Math.max(0, (region.startColumn ?? 1) - 1);
            const endLine   = Math.max(startLine, ((region.endLine   || region.startLine   || 1) - 1));
            const endCol    = Math.max(startCol + 1, ((region.endColumn || region.startColumn || 1) - 1));

            const rawMessage: string = result.message?.text ?? 'Unknown issue';
            const fingerprint = computeFingerprint(
                result.ruleId,
                relativeFindingPath(targetFile, workspaceRoot),
                rawMessage,
                lineReader(targetFile, startLine)
            );
            const ignored = options.isIgnored?.(fingerprint) === true;
            result.properties = {
                ...(result.properties ?? {}),
                ...(toolName ? { ctraceTool: toolName } : {}),
                ctraceFingerprint: fingerprint,
                ctraceIgnored: ignored,
            };
            if (ignored) { continue; }

            const range      = new vscode.Range(startLine, startCol, endLine, endCol);
            const severity   = sarifLevelToVsCode(result.level);
            const diagnostic = new vscode.Diagnostic(range, buildMessage(rawMessage, result.properties), severity);
            diagnostic.source = toolName ? `CoreTrace (${toolName})` : 'CoreTrace';
            diagnostic.code   = buildCode(result.ruleId, cweIds(result.properties));

            if (!byFile.has(targetFile)) { byFile.set(targetFile, []); }
            byFile.get(targetFile)!.push(diagnostic);
            if (!findingsByFile.has(targetFile)) { findingsByFile.set(targetFile, new Map()); }
            findingsByFile.get(targetFile)!.set(diagnostic, {
                fingerprint,
                ruleId: result.ruleId,
                file: targetFile,
                line: startLine + 1,
                message: rawMessage,
            });
        }
    }

    byFile.forEach((diagnostics, fp) => {
        const uri = vscode.Uri.file(fp);
        // In a workspace scan several translation units can report into the
        // same header: append to what earlier files published instead of
        // replacing it.
        const existing = clearFirst ? [] : (collection.get(uri) ?? []);
        const seen = new Set(existing.map(diagnosticKey));
        const merged = [...existing];
        for (const d of diagnostics) {
            const key = diagnosticKey(d);
            if (!seen.has(key)) {
                seen.add(key);
                merged.push(d);
                const finding = findingsByFile.get(fp)?.get(d);
                if (finding) { findingsByDiagnostic.set(lookupKey(uri, d), finding); }
            }
        }
        collection.set(uri, merged);
    });
}

/** Resolves a SARIF artifact URI to an absolute host path, defaulting to the analysed file. */
export function resolveResultFile(
    uriStr: string | undefined,
    analysedFilePath: string,
    workspaceRoot: string | undefined
): string {
    if (!uriStr) { return analysedFilePath; }
    const normalised = normaliseMountPath(uriStr);
    if (normalised.startsWith('file://')) {
        return vscode.Uri.parse(normalised).fsPath;
    }
    if (fs.existsSync(normalised)) {
        // normaliseMountPath yields forward slashes on Windows: restore the
        // native form so one file never ends up under two different keys.
        return path.normalize(normalised);
    }
    if (workspaceRoot && fs.existsSync(path.resolve(workspaceRoot, normalised))) {
        return path.resolve(workspaceRoot, normalised);
    }
    const fileDir = path.dirname(analysedFilePath);
    if (fs.existsSync(path.resolve(fileDir, normalised))) {
        return path.resolve(fileDir, normalised);
    }
    return analysedFilePath;
}

/** Normalised CWE ids ("CWE-415") from ctrace's `cwe` property or GitHub-style tags. */
export function cweIds(properties: SarifResultProperties | undefined): string[] {
    if (!properties) { return []; }
    const raw: unknown[] = [
        ...(Array.isArray(properties.cwe) ? properties.cwe : [properties.cwe]),
        ...(Array.isArray(properties.tags) ? properties.tags : []),
    ];
    const ids: string[] = [];
    for (const value of raw) {
        const match = typeof value === 'number'
            ? [String(value), String(value)]
            : typeof value === 'string' ? value.match(/^(?:external\/cwe\/)?cwe[-/]?0*(\d{1,5})$/i) ?? value.match(/^0*(\d{1,5})$/) : null;
        if (match) {
            const id = `CWE-${Number(match[1])}`;
            if (!ids.includes(id)) { ids.push(id); }
        }
    }
    return ids;
}

export function cweUrl(cweId: string): vscode.Uri {
    return vscode.Uri.parse(`https://cwe.mitre.org/data/definitions/${cweId.replace(/^CWE-/i, '')}.html`);
}

function buildCode(ruleId: string | undefined, cwes: string[]): vscode.Diagnostic['code'] {
    if (cwes.length === 0) { return ruleId; }
    return {
        value: ruleId ? `${ruleId} · ${cwes.join(', ')}` : cwes.join(', '),
        target: cweUrl(cwes[0]),
    };
}

function buildMessage(message: string, properties: SarifResultProperties | undefined): string {
    const others = (properties?.alsoReportedBy ?? [])
        .filter(r => r && (r.tool || r.ruleId))
        .map(r => r.tool && r.ruleId ? `${r.tool} (${r.ruleId})` : (r.tool || r.ruleId));
    return others.length > 0 ? `${message}\nAlso reported by: ${others.join(', ')}` : message;
}

function createLineReader(): (file: string, zeroBasedLine: number) => string {
    const cache = new Map<string, string[]>();
    return (file, line) => {
        let lines = cache.get(file);
        if (!lines) {
            try {
                lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
            } catch {
                lines = [];
            }
            cache.set(file, lines);
        }
        return lines[line] ?? '';
    };
}

function lookupKey(uri: vscode.Uri, d: vscode.Diagnostic): string {
    return `${uri.toString()}|${d.range.start.line}:${d.range.start.character}|${d.message}`;
}

/**
 * Converts a WSL mount path (produced by ctrace running inside WSL on Windows)
 * to a Windows-style absolute path so `vscode.Uri.file()` resolves it correctly.
 *
 * Handles both POSIX-separator form   /mnt/c/Users/...
 * and backslash-escaped form          \\mnt\\c\\Users\\...
 *
 * On non-Windows hosts the path is returned unchanged because `/mnt/...` is a
 * legitimate native mount point there.
 */
export function normaliseMountPath(p: string): string {
    if (process.platform !== 'win32') { return p; }
    // Normalise backslash variants to forward slashes first.
    const forward = p.replace(/\\/g, '/');
    // /mnt/<drive>/rest  →  <DRIVE>:/rest
    return forward.replace(
        /^\/{1,2}mnt\/([a-zA-Z])\//,
        (_, drive: string) => `${drive.toUpperCase()}:/`
    );
}

function diagnosticKey(d: vscode.Diagnostic): string {
    return `${String(d.code ?? '')}|${d.range.start.line}|${d.range.start.character}|${d.message}`;
}

function sarifLevelToVsCode(level: 'error' | 'warning' | 'note' | 'none' | string | undefined): vscode.DiagnosticSeverity {
    switch ((level ?? '').toLowerCase()) {
        case 'error':   return vscode.DiagnosticSeverity.Error;
        case 'warning': return vscode.DiagnosticSeverity.Warning;
        case 'note':    return vscode.DiagnosticSeverity.Information;
        case 'none':    return vscode.DiagnosticSeverity.Hint;
        default:        return vscode.DiagnosticSeverity.Warning;
    }
}

