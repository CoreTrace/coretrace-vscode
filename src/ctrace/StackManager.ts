import * as vscode from 'vscode';
import type { StackFunction, StackReport } from '../types/stack';

export class StackManager {
    private static _instance: StackManager;
    private _latestReport: StackReport | null = null;
    // name → every definition with that name: two files can each define one.
    private _functionMap = new Map<string, StackFunction[]>();
    private _onDidUpdateStackData = new vscode.EventEmitter<void>();

    public readonly onDidUpdateStackData = this._onDidUpdateStackData.event;

    public static get instance(): StackManager {
        if (!this._instance) {
            this._instance = new StackManager();
        }
        return this._instance;
    }

    public updateStackData(report: StackReport): void {
        this._latestReport = report;
        this._functionMap.clear();

        const index = (name: string, fn: StackFunction) => {
            const list = this._functionMap.get(name) ?? [];
            list.push(fn);
            this._functionMap.set(name, list);
        };
        for (const fn of report.functions) {
            index(fn.name, fn);
            // Also store without namespace or qualifiers if any
            const simpleName = fn.name.split('::').pop() ?? fn.name;
            if (simpleName !== fn.name) {
                index(simpleName, fn);
            }
        }

        this._onDidUpdateStackData.fire();
    }

    /**
     * The definition of `name` in `file`. Without a match in that file, only
     * a definition whose file is unknown is returned: another file's function
     * of the same name is a different function.
     */
    public getFunction(name: string, file?: string): StackFunction | undefined {
        const candidates = this._functionMap.get(name) ?? [];
        if (file) {
            const inFile = candidates.find(fn => fn.file === file);
            if (inFile) { return inFile; }
            const unknownFile = candidates.filter(fn => !fn.file);
            return unknownFile.length === 1 ? unknownFile[0] : undefined;
        }
        return candidates.length === 1 ? candidates[0] : undefined;
    }

    public getLatestReport(): StackReport | null {
        return this._latestReport;
    }

    public clear(): void {
        this._latestReport = null;
        this._functionMap.clear();
        this._onDidUpdateStackData.fire();
    }
}
