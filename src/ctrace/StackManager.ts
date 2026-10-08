import * as vscode from 'vscode';
import type { StackFunction, StackReport } from '../types/stack';

export class StackManager {
    private static _instance: StackManager;
    private _latestReport: StackReport | null = null;
    private _functionMap = new Map<string, StackFunction>();
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

        for (const fn of report.functions) {
            this._functionMap.set(fn.name, fn);
            // Also store without namespace or qualifiers if any
            const simpleName = fn.name.split('::').pop() ?? fn.name;
            if (simpleName !== fn.name) {
                this._functionMap.set(simpleName, fn);
            }
        }

        this._onDidUpdateStackData.fire();
    }

    public getFunction(name: string): StackFunction | undefined {
        return this._functionMap.get(name);
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
