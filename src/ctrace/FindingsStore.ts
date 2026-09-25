import type * as vscode from 'vscode';
import type { SarifLog, SarifResult } from '../types/sarif';

const STORAGE_KEY = 'coretrace.latestFindings.v1';

export interface FindingsSnapshot {
    savedAt: number;
    report: SarifLog;
}

/** Keeps just the fields shown in the sidebar, scoped to the current workspace. */
export class FindingsStore {
    constructor(private readonly state: vscode.Memento) {}

    public get(): FindingsSnapshot | null {
        const value = this.state.get<FindingsSnapshot>(STORAGE_KEY);
        return value && Number.isFinite(value.savedAt) && Array.isArray(value.report?.runs)
            ? value : null;
    }

    public async save(report: SarifLog): Promise<void> {
        const results: SarifResult[] = (report.runs ?? []).flatMap(run => run.results ?? []).map(result => {
            const location = result.locations?.[0]?.physicalLocation;
            return {
                ruleId: result.ruleId,
                level: result.level,
                message: { text: result.message?.text ?? '' },
                locations: location ? [{ physicalLocation: {
                    artifactLocation: { uri: location.artifactLocation?.uri },
                    region: { startLine: location.region?.startLine },
                } }] : [],
            };
        });
        await this.state.update(STORAGE_KEY, {
            savedAt: Date.now(),
            report: {
                version: '2.1.0',
                runs: [{ tool: { driver: { name: 'CoreTrace' } }, results }],
            },
        } satisfies FindingsSnapshot);
    }

    public async clear(): Promise<void> {
        await this.state.update(STORAGE_KEY, undefined);
    }
}
