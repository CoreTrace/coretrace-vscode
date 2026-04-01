import * as fs from 'fs';
import type { SarifLog, SarifResult, StackAnalyzerOutput, StackAnalyzerDiagnostic } from '../types/sarif';

/**
 * Attempts to extract a parsed SARIF object from the available sources:
 * 1. A report file written by ctrace (preferred)
 * 2. The SARIF JSON blocks embedded in stdout
 * 3. Raw "ctrace-stack-analyzer" JSON objects in stdout (converted to SARIF)
 * 4. Plain-text compiler warnings in stdout (e.g. clang diag)
 *
 * Returns the merged SARIF object, or null if nothing could be extracted.
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

    const mergeSarif = (source: SarifLog) => {
        if (!source || !source.runs) {
            return;
        }
        if (!sarif) {
            sarif = source;
        } else {
            if (!sarif.runs) {
                sarif.runs = [];
            }
            sarif.runs.push(...source.runs);
        }
    };

    // 2 ─ Embedded SARIF blocks in stdout
    const sarifBlocks = extractAllJsonBlocks(cleanedStdout, '"$schema"');
    for (const block of sarifBlocks) {
        const b = block as SarifLog;
        if (b.runs) {
            mergeSarif(b);
        }
    }

    // 3 ─ Raw stack-analyzer JSON objects
    const stackBlocks = extractAllStackAnalyzerBlocks(cleanedStdout);
    for (const block of stackBlocks) {
        const obj = block as StackAnalyzerOutput;
        if (Array.isArray(obj.diagnostics) && obj.diagnostics.length > 0) {
            mergeSarif(convertStackAnalyzerToSarif(obj));
        }
    }

    // 4 ─ Plaintext Clang/GCC warnings in stdout/stderr
    const textWarnings = extractClangWarnings(cleanedStdout);
    if (textWarnings) {
        mergeSarif(textWarnings);
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

/**
 * Extracts multiple JSON blocks containing a specific signature.
 */
function extractAllJsonBlocks(text: string, signature: string): unknown[] {
    const blocks: unknown[] = [];
    let searchStart = text.length;

    while (searchStart > 0) {
        const sigIdx = text.lastIndexOf(signature, searchStart - 1);
        if (sigIdx === -1) { break; }

        const openBrace = text.lastIndexOf('{', sigIdx);
        if (openBrace === -1) {
            searchStart = sigIdx;
            continue;
        }

        const block = matchBraces(text, openBrace);
        if (block) {
            blocks.unshift(block);
        }

        searchStart = openBrace;
    }
    return blocks;
}

/**
 * Extracts root JSON objects representing ctrace-stack-analyzer outputs.
 */
function extractAllStackAnalyzerBlocks(text: string): unknown[] {
    const blocks: unknown[] = [];
    const signature = '"tool": "ctrace-stack-analyzer"';
    let searchStart = text.length;

    while (searchStart > 0) {
        const toolIdx = text.lastIndexOf(signature, searchStart - 1);
        if (toolIdx === -1) { break; }

        // "meta" key precedes the tool key in the same object block
        const metaIdx = text.lastIndexOf('"meta"', toolIdx);
        if (metaIdx === -1) {
            searchStart = toolIdx;
            continue;
        }

        // The root '{' is before the "meta" key
        const rootBrace = text.lastIndexOf('{', metaIdx);
        if (rootBrace === -1) {
            searchStart = metaIdx;
            continue;
        }

        const block = matchBraces(text, rootBrace);
        if (block) {
            blocks.unshift(block);
        }

        searchStart = rootBrace;
    }
    return blocks;
}

/**
 * Uses a regex to scrape standard Clang/GCC diagnostic formatted text from raw logs
 * and structures them as SARIF runs so they can display directly in VS Code.
 */
function extractClangWarnings(text: string): SarifLog | null {
    const results: SarifResult[] = [];
    // Matches patterns like "path/file.c:10:5: warning: message here"
    // Also correctly accounts for spaces in paths, or paths wrapped in specific delimiters
    const regex = /(?:\]\s+|^|\s)((?:[A-Za-z]:[\\/]|[~/.]|[a-zA-Z0-9_-])[^\n:\]]*?(?:\.[a-zA-Z0-9]+)?):(\d+):(\d+):\s+(warning|error|note):\s+(.*)$/gm;
    let match;

    while ((match = regex.exec(text)) !== null) {
        const [, file, line, col, level, message] = match;
        results.push({
            ruleId: 'CompilerWarning',
            level: severityToSarifLevel(level),
            message: { text: message.trim() },
            locations: [{
                physicalLocation: {
                    artifactLocation: { uri: file },
                    region: {
                        startLine: parseInt(line, 10) || 1,
                        startColumn: parseInt(col, 10) || 1,
                    }
                }
            }]
        });
    }

    if (results.length === 0) { return null; }

    return {
        version: '2.1.0',
        runs: [{ tool: { driver: { name: 'clang-compiler' } }, results }]
    };
}

/**
 * Finds the closing brace of a JSON object that starts at `startIndex`,
 * skipping brace characters that appear inside string literals.
 * Returns the parsed object or null if invalid.
 */
function matchBraces(text: string, startIndex: number): unknown {
    let i = startIndex;
    let balance = 0;

    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            i++;
            // Consume until closing quote
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
                    return null; // Invalid schema payload
                }
            }
        }
        i++;
    }
    return null;
}

/**
 * Maps properties from a ctrace stack analyzer payload to equivalent SARIF fields.
 */
function convertStackAnalyzerToSarif(stackObj: StackAnalyzerOutput): SarifLog {
    const defaultUri = stackObj.meta?.inputFile || stackObj.meta?.inputFiles?.[0];

    const results: SarifResult[] = (stackObj.diagnostics ?? []).map((d: StackAnalyzerDiagnostic) => ({
        ruleId: d.ruleId ?? 'StackIssue',
        level: severityToSarifLevel(d.severity),
        message: { text: (d.details?.message ?? 'Unknown stack issue').trim() },
        locations: [{
            physicalLocation: {
                artifactLocation: { uri: d.location?.file || defaultUri },
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

/**
 * Converts text-based severity levels to correct SARIF types.
 */
function severityToSarifLevel(severity: string | undefined): 'error' | 'warning' | 'note' | 'none' {
    switch ((severity ?? '').toUpperCase()) {
        case 'ERROR':   return 'error';
        case 'WARNING': return 'warning';
        case 'NOTE':    return 'note';
        default:        return 'warning';
    }
}
