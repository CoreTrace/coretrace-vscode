// Minimal but complete typings for SARIF 2.1.0
// https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html

export interface SarifLog {
    version: '2.1.0';
    $schema?: string;
    runs: SarifRun[];
}

export interface SarifRun {
    tool: SarifTool;
    results?: SarifResult[];
    artifacts?: SarifArtifact[];
    originalUriBaseIds?: Record<string, SarifArtifactLocation>;
}

export interface SarifTool {
    driver: SarifToolComponent;
    extensions?: SarifToolComponent[];
}

export interface SarifToolComponent {
    name: string;
    version?: string;
    rules?: SarifReportingDescriptor[];
}

export interface SarifReportingDescriptor {
    id: string;
    name?: string;
    shortDescription?: SarifMessage;
    fullDescription?: SarifMessage;
}

export interface SarifResult {
    ruleId?: string;
    level?: 'error' | 'warning' | 'note' | 'none';
    message: SarifMessage;
    locations?: SarifLocation[];
    relatedLocations?: SarifLocation[];
    fixes?: SarifFix[];
    partialFingerprints?: Record<string, string>;
    properties?: SarifResultProperties;
}

/**
 * Property bag of a result. `cwe` and `alsoReportedBy` come from ctrace; the
 * `ctrace*` keys are added by the extension when results are published.
 */
export interface SarifResultProperties {
    cwe?: string | number | (string | number)[];
    tags?: string[];
    alsoReportedBy?: { ruleId?: string; tool?: string }[];
    /** Name of the analyzer that produced the result (SARIF run driver). */
    ctraceTool?: string;
    /** Stable id used by the ignore list (see FindingIgnoreList). */
    ctraceFingerprint?: string;
    ctraceIgnored?: boolean;
    [key: string]: unknown;
}

export interface SarifMessage {
    text?: string;
    markdown?: string;
    id?: string;
    arguments?: string[];
}

export interface SarifLocation {
    id?: number;
    message?: SarifMessage;
    physicalLocation?: SarifPhysicalLocation;
    logicalLocations?: SarifLogicalLocation[];
}

export interface SarifPhysicalLocation {
    artifactLocation?: SarifArtifactLocation;
    region?: SarifRegion;
    contextRegion?: SarifRegion;
}

export interface SarifArtifactLocation {
    uri?: string;
    uriBaseId?: string;
    index?: number;
}

export interface SarifRegion {
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
    charOffset?: number;
    charLength?: number;
    snippet?: SarifArtifactContent;
}

export interface SarifArtifactContent {
    text?: string;
    binary?: string;
}

export interface SarifArtifact {
    location?: SarifArtifactLocation;
    length?: number;
    mimeType?: string;
    contents?: SarifArtifactContent;
}

export interface SarifLogicalLocation {
    name?: string;
    fullyQualifiedName?: string;
    kind?: string;
}

export interface SarifFix {
    description?: SarifMessage;
    artifactChanges?: SarifArtifactChange[];
}

export interface SarifArtifactChange {
    artifactLocation: SarifArtifactLocation;
    replacements: SarifReplacement[];
}

export interface SarifReplacement {
    deletedRegion: SarifRegion;
    insertedContent?: SarifArtifactContent;
}

/** Stack-analyzer raw format (ctrace-specific, converted to SARIF at runtime) */
export interface StackAnalyzerOutput {
    meta: {
        tool: 'ctrace-stack-analyzer';
        inputFile?: string;
        inputFiles?: string[];
        [key: string]: unknown;
    };
    diagnostics: StackAnalyzerDiagnostic[];
}

export interface StackAnalyzerDiagnostic {
    ruleId?: string;
    severity?: 'ERROR' | 'WARNING' | 'NOTE';
    details?: {
        message?: string;
    };
    location?: {
        file?: string;
        startLine?: number;
        startColumn?: number;
        endLine?: number;
        endColumn?: number;
    };
}
