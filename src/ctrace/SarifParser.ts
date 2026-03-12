import * as fs from 'fs';
import type { SarifLog, StackAnalyzerOutput, StackAnalyzerDiagnostic } from '../types/sarif';

/**
 * Attempts to extract a parsed SARIF object from the available sources:
 * 1. A report file written by ctrace (preferred)
 * 2. The SARIF JSON block embedded in stdout
 * 3. A raw "ctrace-stack-analyzer" JSON object in stdout (converted to SARIF)
 *
 * Returns the parsed SARIF object, or null if nothing could be extracted.
 */
export async function parseSarifOutput(stdout: string, reportFilePath?: string): Promise<SarifLog | null> {
    // Strip ANSI escape codes produced by ctrace's coloured output
    const cleanedStdout = stripAnsi(stdout);
    let sarif: SarifLog | null = null;

    // 1 ─ Report file (preferred)
    if (reportFilePath) {
        try {
            const content = (await fs.promises.readFile(reportFilePath, 'utf-8')).trim();
            if (content) {
                sarif = JSON.parse(content) as SarifLog;
            }
        } catch (e: unknown) {
            // ENOENT is normal when ctrace didn’t write a report — suppress it.
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.error('[SarifParser] Failed to parse report file:', e);
            }
        }
    }

    // 2 ─ Embedded SARIF block in stdout
    if (!sarif) {
        const sarifBlock = extractLastJsonBlock(cleanedStdout, '"$schema"');
        if (sarifBlock) {
            sarif = sarifBlock as SarifLog;
        }
    }

    // 3 ─ Raw stack-analyzer JSON
    // Try even when a SARIF was found but has 0 results (ctrace outputs both).
    const hasResults = sarif?.runs?.some(r => (r.results?.length ?? 0) > 0);
    if (!hasResults) {
        const stackBlock = extractStackAnalyzerBlock(cleanedStdout);
        if (stackBlock) {
            const obj = stackBlock as StackAnalyzerOutput;
            if (obj.diagnostics && Array.isArray(obj.diagnostics) && obj.diagnostics.length > 0) {
                return convertStackAnalyzerToSarif(obj);
            }
        }
    }

    return sarif ?? null;
}

/** Returns the total number of results across all SARIF runs. */
export function countResults(sarif: SarifLog | null): number {
    if (!sarif?.runs) { return 0; }
    return sarif.runs.reduce((sum, r) => sum + (r.results?.length ?? 0), 0);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Remove ANSI/VT escape sequences from text. */
function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

function extractLastJsonBlock(text: string, signature: string): unknown {
    const sigIdx = text.lastIndexOf(signature);
    if (sigIdx === -1) { return null; }
    const openBrace = text.lastIndexOf('{', sigIdx);
    if (openBrace === -1) { return null; }
    return matchBraces(text, openBrace);
}

/**
 * Extracts the root JSON object of the ctrace-stack-analyzer output.
 * The signature "tool": "ctrace-stack-analyzer" lives inside a nested "meta"
 * object, so we must walk back to the *outer* opening brace.
 */
function extractStackAnalyzerBlock(text: string): unknown {
    const toolSig = '"tool": "ctrace-stack-analyzer"';
    const toolIdx = text.lastIndexOf(toolSig);
    if (toolIdx === -1) { return null; }

    // "meta" key precedes the tool key in the same object
    const metaIdx = text.lastIndexOf('"meta"', toolIdx);
    if (metaIdx === -1) { return null; }

    // The root { is before "meta"
    const rootBrace = text.lastIndexOf('{', metaIdx);
    if (rootBrace === -1) { return null; }

    return matchBraces(text, rootBrace);
}

/**
 * Finds the closing brace of a JSON object that starts at `startIndex`,
 * correctly skipping brace characters that appear inside JSON string literals
 * (e.g. `"value": "}"` must not decrement the balance counter).
 * Parses and returns the extracted object, or null if the slice is not valid
 * JSON.  Parsing happens here so callers can use the result directly without
 * a second JSON.parse call.
 */
function matchBraces(text: string, startIndex: number): unknown {
    let i = startIndex;
    let balance = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            // Skip over the entire string literal so braces inside it are ignored.
            i++;
            while (i < text.length) {
                if (text[i] === '\\') { i += 2; continue; } // escaped character
                if (text[i] === '"') { i++; break; }         // end of string
                i++;
            }
            continue;
        }
        if (ch === '{') { balance++; }
        else if (ch === '}') {
            balance--;
            if (balance === 0) {
                try {
                    return JSON.parse(text.substring(startIndex, i + 1));
                } catch {
                    // Extracted slice is not valid JSON — give up.
                    return null;
                }
            }
        }
        i++;
    }
    return null;
}

function convertStackAnalyzerToSarif(stackObj: StackAnalyzerOutput): SarifLog {
    const results = (stackObj.diagnostics ?? []).map((d: StackAnalyzerDiagnostic) => ({
        ruleId: d.ruleId ?? 'StackIssue',
        level: severityToSarifLevel(d.severity),
        message: { text: (d.details?.message ?? 'Unknown stack issue').trim() },
        locations: [{
            physicalLocation: {
                artifactLocation: { uri: stackObj.meta?.inputFile },
                region: {
                    startLine: d.location?.startLine ?? 1,
                    startColumn: d.location?.startColumn ?? 1,
                    endLine: d.location?.endLine || d.location?.startLine || 1,
                    endColumn: d.location?.endColumn || 2,
                },
            },
        }],
    }));

    return {
        version: '2.1.0',
        runs: [{ tool: { driver: { name: 'ctrace-stack-analyzer' } }, results }],
    };
}

function severityToSarifLevel(severity: string | undefined): 'error' | 'warning' | 'note' | 'none' {
    switch ((severity ?? '').toUpperCase()) {
        case 'ERROR':   return 'error';
        case 'WARNING': return 'warning';
        case 'NOTE':    return 'note';
        default:        return 'warning';
    }
}
