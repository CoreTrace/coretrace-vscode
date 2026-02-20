import * as fs from 'fs';

/**
 * Attempts to extract a parsed SARIF object from the available sources:
 * 1. A report file written by ctrace (preferred)
 * 2. The SARIF JSON block embedded in stdout
 * 3. A raw "ctrace-stack-analyzer" JSON object in stdout (converted to SARIF)
 *
 * Returns the parsed SARIF object, or null if nothing could be extracted.
 */
export function parseSarifOutput(stdout: string, reportFilePath?: string): any | null {
    // Strip ANSI escape codes produced by ctrace's coloured output
    const cleanedStdout = stripAnsi(stdout);
    let sarif: any = null;

    // 1 ─ Report file (preferred)
    if (reportFilePath && fs.existsSync(reportFilePath)) {
        try {
            const content = fs.readFileSync(reportFilePath, 'utf-8').trim();
            if (content) {
                sarif = JSON.parse(content);
            }
        } catch (e) {
            console.error('[SarifParser] Failed to parse report file:', e);
        }
    }

    // 2 ─ Embedded SARIF block in stdout
    if (!sarif) {
        const sarifBlock = extractLastJsonBlock(cleanedStdout, '"$schema"');
        if (sarifBlock) {
            try {
                sarif = JSON.parse(sarifBlock);
            } catch (e) {
                console.error('[SarifParser] Failed to parse SARIF block from stdout:', e);
            }
        }
    }

    // 3 ─ Raw stack-analyzer JSON
    // Try even when a SARIF was found but has 0 results (ctrace outputs both).
    const hasResults = sarif?.runs?.some((r: any) => r.results?.length > 0);
    if (!hasResults) {
        const stackBlock = extractStackAnalyzerBlock(cleanedStdout);
        if (stackBlock) {
            try {
                const obj = JSON.parse(stackBlock);
                if (obj.diagnostics && Array.isArray(obj.diagnostics) && obj.diagnostics.length > 0) {
                    return convertStackAnalyzerToSarif(obj);
                }
            } catch (e) {
                console.error('[SarifParser] Failed to parse stack-analyzer JSON:', e);
            }
        }
    }

    return sarif ?? null;
}

/** Returns the total number of results across all SARIF runs. */
export function countResults(sarif: any): number {
    if (!sarif?.runs) { return 0; }
    return sarif.runs.reduce((sum: number, r: any) => sum + (r.results?.length ?? 0), 0);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Remove ANSI/VT escape sequences from text. */
function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

function extractLastJsonBlock(text: string, signature: string): string | null {
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
function extractStackAnalyzerBlock(text: string): string | null {
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

function matchBraces(text: string, startIndex: number): string | null {
    let balance = 0;
    for (let i = startIndex; i < text.length; i++) {
        if (text[i] === '{') { balance++; }
        else if (text[i] === '}') {
            balance--;
            if (balance === 0) { return text.substring(startIndex, i + 1); }
        }
    }
    return null;
}

function convertStackAnalyzerToSarif(stackObj: any): any {
    const results = (stackObj.diagnostics ?? []).map((d: any) => ({
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

function severityToSarifLevel(severity: string | undefined): string {
    switch ((severity ?? '').toUpperCase()) {
        case 'ERROR':   return 'error';
        case 'WARNING': return 'warning';
        case 'NOTE':    return 'note';
        default:        return 'warning';
    }
}
