/**
 * Shared types for imported eval runs and sessions.
 *
 * An import is a user-named, immutable copy of a bundle (see docs in README "Imports")
 * stored under IMPORTS_ROOT/<id>/ with a manifest.json describing it.
 */

export type ImportType = 'eval-run' | 'session';

export type EvalArm = 'with' | 'without';

/**
 * One eval trace inside an eval-run import.
 * `id` is an opaque server-generated session id (t001, t002, ...). `caseName` is the
 * sender's label and is display-only: it is never used to build a filesystem path.
 */
export interface ImportTraceRef {
  id: string;
  /** Path of the trace inside the import directory (a validated archive entry name) */
  file: string;
  caseName: string;
  arm: EvalArm;
  /** 1-based run number */
  run: number;
}

export interface ImportManifest {
  /** Lowercase UUID v4, server-generated */
  id: string;
  /** User-chosen display name (not unique) */
  name: string;
  type: ImportType;
  /** ISO 8601 timestamp */
  createdAt: string;
  /** One-line description, e.g. "3 cases × 2 arms × 3 runs" */
  summary: string;
  /** eval-run: Claude Code version recorded in results.json */
  claudeVersion?: string;
  /** eval-run: results.json schemaVersion */
  schemaVersion?: number;
  /** eval-run: true when the suite did not finish */
  partial?: boolean;
  partialReason?: string;
  /** eval-run: trace id map */
  traces?: ImportTraceRef[];
  /** session: the session id (file name without .jsonl) */
  sessionId?: string;
  /** session: number of subagent files */
  subagentCount?: number;
}

/**
 * What the EvalTraceAdapter learned about one trace while converting it for the viewer.
 * `hasInit`/`hasResult` false means the run was probably killed; the UI shows a banner.
 */
export interface EvalTraceMeta {
  claudeVersion?: string;
  model?: string;
  cwd?: string;
  hasInit: boolean;
  hasResult: boolean;
  /** Totals from the trace's final `result` line (not re-derived from usage) */
  result?: {
    isError: boolean;
    numTurns?: number;
    durationMs?: number;
    totalCostUsd?: number;
    stopReason?: string;
    terminalReason?: string;
  };
  /** `system/permission_denied` lines, keyed to the tool call they refer to */
  permissionDenials: { toolUseId: string; toolName?: string; message?: string }[];
  /** Lines that belong to inline subagents (parent_tool_use_id set); hidden in v1 */
  hiddenSubagentLines: number;
  /** Lines that were not valid JSON or had an unknown type */
  ignoredLines: number;
  warnings: string[];
}

/** One row of GET /api/imports. Directories that cannot be read are listed as invalid. */
export type ImportListEntry =
  | { valid: true; manifest: ImportManifest }
  | { valid: false; id: string; error: string };

/** GET /api/imports/capabilities */
export interface ImportCapabilities {
  enabled: boolean;
  readonly: boolean;
}

/** Limits shown in the import dialog (the server is the source of truth). */
export const IMPORT_MAX_ZIP_BYTES = 200 * 1024 * 1024;
export const IMPORT_MAX_NAME_LENGTH = 80;

// =============================================================================
// Eval results view (GET /api/imports/:id/results)
// =============================================================================

/** One grader outcome of one run. Free-text fields are length-capped by the server. */
export interface EvalGraderView {
  name: string;
  passed: boolean;
  weight: number;
  explanation?: string;
  /** One vote per judge sample, when the grader is an LLM judge */
  judgeVotes: boolean[];
  /** The grader was not scored (e.g. skipped by the cost ceiling) */
  scored: boolean;
}

export interface EvalRunView {
  score?: number;
  passed: boolean;
  turns?: number;
  costUsd?: number;
  judgeCostUsd?: number;
  durationSeconds?: number;
  /** Non-null does not imply score 0 (rate/plan limits show up here, not as `partial`) */
  error?: string;
  /** The mock stopped the run; the run scores 0 and `error` stays empty */
  aborted?: string;
  /** Judge graders were skipped by the cost ceiling; the score is not comparable */
  skippedPaidGraders: boolean;
  graders: EvalGraderView[];
}

export interface EvalCaseView {
  name: string;
  runsPerCase: number;
  graderCount: number;
  /** Runs by arm, in run order. `without` is empty for single-arm cases. */
  arms: { with: EvalRunView[]; without: EvalRunView[] };
  score?: number;
  passRate?: number;
  scoreWithout?: number;
  passRateWithout?: number;
  /** Omitted by the eval tool when only one arm ran */
  delta?: number;
}

export interface EvalResultsView {
  claudeVersion?: string;
  partial: boolean;
  partialReason?: string;
  costUsd?: number;
  durationSeconds?: number;
  startedAt?: string;
  aggregates: {
    casesTotal?: number;
    casesPassed?: number;
    overallScore?: number;
    overallPassRate?: number;
    meanDelta?: number;
  };
  cases: EvalCaseView[];
}
