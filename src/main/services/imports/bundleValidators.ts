/**
 * Layout validators for import bundles. Pure functions over the list of file names in
 * the archive (already checked by archivePolicy) and, for eval runs, the parsed
 * results.json. They decide which files to extract; nothing here touches the disk.
 *
 * Case names come from the sender. They are only compared as strings against archive
 * entry names and stored as display labels; they are never joined into a path.
 */

import { displayName, hasControlCharacters } from './archivePolicy';
import { formatEvalTraceId } from './importIds';

import type { EvalArm, ImportTraceRef } from '@shared/types/imports';

export const RESULTS_FILE = 'results.json';
const SUPPORTED_RESULTS_SCHEMA_VERSION = 1;

/** Produced by Claude Code next to results.json; not needed by the viewer, never extracted. */
const IGNORED_EVAL_FILES = new Set(['aggregate-result.json', 'report.html']);

const ARMS: readonly EvalArm[] = ['with', 'without'];
const MAX_CASE_NAME_LENGTH = 200;
const MAX_REPORTED_ERRORS = 50;
const SESSION_FILE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SUBAGENT_FILE_PATTERN = /^agent-[A-Za-z0-9._-]{1,120}\.jsonl$/;

export interface BundleValidation {
  /** Human-readable problems. Empty means the bundle is acceptable. */
  errors: string[];
  /** Archive entry names to extract, in a stable order. Empty when there are errors. */
  extract: string[];
  /** Archive entry names deliberately skipped (known, harmless, not needed). */
  ignored: string[];
  summary: string;
}

export interface EvalRunValidation extends BundleValidation {
  traces: ImportTraceRef[];
  schemaVersion?: number;
  claudeVersion?: string;
  partial: boolean;
  partialReason?: string;
}

export interface SessionValidation extends BundleValidation {
  sessionId?: string;
  subagentCount: number;
}

class ErrorList {
  readonly items: string[] = [];
  private omitted = 0;

  add(message: string): void {
    if (this.items.length < MAX_REPORTED_ERRORS) {
      this.items.push(message);
    } else {
      this.omitted++;
    }
  }

  finish(): string[] {
    return this.omitted > 0 ? [...this.items, `...and ${this.omitted} more problems`] : this.items;
  }

  get count(): number {
    return this.items.length + this.omitted;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quote(value: string): string {
  return `"${displayName(value)}"`;
}

function checkCaseName(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'name is missing';
  if (name.length > MAX_CASE_NAME_LENGTH) return `name longer than ${MAX_CASE_NAME_LENGTH}`;
  if (hasControlCharacters(name)) return 'name contains control characters';
  if (name.includes('/') || name.includes('\\')) return 'name contains a path separator';
  if (name === '.' || name === '..') return 'name is not a valid directory name';
  return null;
}

function failedEval(errors: string[]): EvalRunValidation {
  return { errors, extract: [], ignored: [], summary: '', traces: [], partial: false };
}

/**
 * Validates an eval-run bundle.
 * Layout: results.json + traces/<case>/<with|without>-<N>.jsonl
 *
 * @param files  file entry names in the archive (no directories)
 * @param results parsed results.json, or undefined when it was missing/unparseable
 */
export function validateEvalRunBundle(
  files: readonly string[],
  results: unknown
): EvalRunValidation {
  const errors = new ErrorList();

  if (!files.includes(RESULTS_FILE)) {
    errors.add(`${RESULTS_FILE} is missing at the root of the archive`);
  }
  if (!isRecord(results)) {
    if (files.includes(RESULTS_FILE)) errors.add(`${RESULTS_FILE} is not a valid JSON object`);
    return failedEval(errors.finish());
  }

  const schemaVersion = results.schemaVersion;
  if (schemaVersion !== SUPPORTED_RESULTS_SCHEMA_VERSION) {
    errors.add(
      `Unsupported ${RESULTS_FILE} schemaVersion ${JSON.stringify(schemaVersion)} ` +
        `(supported: ${SUPPORTED_RESULTS_SCHEMA_VERSION})`
    );
    return failedEval(errors.finish());
  }

  const partial = results.partial === true;
  const partialReason =
    typeof results.partialReason === 'string' ? results.partialReason : undefined;
  const claudeVersion =
    typeof results.claudeVersion === 'string' ? results.claudeVersion : undefined;

  if (!Array.isArray(results.cases) || results.cases.length === 0) {
    errors.add(`${RESULTS_FILE} has no cases`);
    return failedEval(errors.finish());
  }

  const fileSet = new Set(files);
  const expected = new Set<string>();
  const traces: ImportTraceRef[] = [];
  const seenCases = new Set<string>();
  let maxRuns = 0;
  let anyWithout = false;

  results.cases.forEach((rawCase: unknown, caseIndex: number) => {
    const where = `cases[${caseIndex}]`;
    if (!isRecord(rawCase)) {
      errors.add(`${where} is not an object`);
      return;
    }
    const nameProblem = checkCaseName(rawCase.name);
    if (nameProblem) {
      errors.add(`${where}: ${nameProblem}`);
      return;
    }
    const caseName = rawCase.name as string;
    if (seenCases.has(caseName)) {
      errors.add(`Duplicate case name ${quote(caseName)}`);
      return;
    }
    seenCases.add(caseName);

    if (!isRecord(rawCase.arms) || !Array.isArray(rawCase.arms.with)) {
      errors.add(`Case ${quote(caseName)} has no "with" runs`);
      return;
    }

    for (const arm of ARMS) {
      const runs: unknown = rawCase.arms[arm];
      if (runs === undefined) continue; // single-arm case: no baseline runs
      if (!Array.isArray(runs)) {
        errors.add(`Case ${quote(caseName)}: "${arm}" is not a list of runs`);
        continue;
      }
      if (arm === 'without' && runs.length > 0) anyWithout = true;
      maxRuns = Math.max(maxRuns, runs.length);

      const runsPerCase = rawCase.runsPerCase;
      if (!partial && typeof runsPerCase === 'number' && runs.length !== runsPerCase) {
        errors.add(
          `Case ${quote(caseName)}: ${runs.length} "${arm}" runs, expected runsPerCase=${runsPerCase}`
        );
      }

      runs.forEach((run: unknown, runIndex: number) => {
        const file = `traces/${caseName}/${arm}-${runIndex + 1}.jsonl`;
        expected.add(file);
        if (fileSet.has(file)) {
          traces.push({
            id: formatEvalTraceId(traces.length),
            file,
            caseName,
            arm,
            run: runIndex + 1,
          });
          return;
        }
        // A run that ended with an error may legitimately have no trace; so may any run of
        // a partial suite. Anything else is a missing file.
        const runError = isRecord(run) ? run.error : undefined;
        const tolerated = partial || (runError !== null && runError !== undefined);
        if (!tolerated) {
          errors.add(
            `Missing trace for case ${quote(caseName)}, "${arm}" run ${runIndex + 1}: ` +
              `expected ${quote(file)}`
          );
        }
      });
    }
  });

  const ignored: string[] = [];
  for (const file of files) {
    if (file === RESULTS_FILE || expected.has(file)) continue;
    if (IGNORED_EVAL_FILES.has(file)) {
      ignored.push(file);
      continue;
    }
    errors.add(`Unexpected file ${quote(file)}`);
  }

  if (errors.count > 0) {
    return { ...failedEval(errors.finish()), schemaVersion, claudeVersion, partial, partialReason };
  }

  const arms = anyWithout ? 2 : 1;
  const summary =
    `${seenCases.size} ${seenCases.size === 1 ? 'case' : 'cases'} × ${arms} ` +
    `${arms === 1 ? 'arm' : 'arms'} × ${maxRuns} ${maxRuns === 1 ? 'run' : 'runs'}` +
    (partial ? ' (partial)' : '');

  return {
    errors: [],
    extract: [RESULTS_FILE, ...traces.map((trace) => trace.file)],
    ignored,
    summary,
    traces,
    schemaVersion,
    claudeVersion,
    partial,
    partialReason,
  };
}

/**
 * Validates a session bundle.
 * Layout: <sessionId>.jsonl + optional <sessionId>/subagents/agent-*.jsonl
 * (the layout under ~/.claude/projects/<project>/).
 * <sessionId>/tool-results/ is skipped, not rejected: Claude Code keeps persisted tool
 * output there and it appears whenever a session folder is zipped as-is.
 */
export function validateSessionBundle(files: readonly string[]): SessionValidation {
  const errors = new ErrorList();
  const fail = (): SessionValidation => ({
    errors: errors.finish(),
    extract: [],
    ignored: [],
    summary: '',
    subagentCount: 0,
  });

  const rootSessions = files
    .map((file) => ({ file, match: SESSION_FILE_PATTERN.exec(file) }))
    .filter((item): item is { file: string; match: RegExpExecArray } => item.match !== null);

  if (rootSessions.length === 0) {
    errors.add('No <sessionId>.jsonl found at the root of the archive (session id must be a UUID)');
    return fail();
  }
  if (rootSessions.length > 1) {
    errors.add(
      `Found ${rootSessions.length} session files at the root; a session import holds exactly one`
    );
    return fail();
  }

  const sessionFile = rootSessions[0].file;
  const sessionId = rootSessions[0].match[1];
  const subagentPrefix = `${sessionId}/subagents/`;
  const ignoredPrefix = `${sessionId}/tool-results/`;
  const subagents: string[] = [];
  const ignored: string[] = [];

  for (const file of files) {
    if (file === sessionFile) continue;
    if (
      file.startsWith(subagentPrefix) &&
      SUBAGENT_FILE_PATTERN.test(file.slice(subagentPrefix.length))
    ) {
      subagents.push(file);
    } else if (file.startsWith(ignoredPrefix)) {
      ignored.push(file);
    } else {
      errors.add(`Unexpected file ${quote(file)}`);
    }
  }

  if (errors.count > 0) return fail();

  subagents.sort((a, b) => a.localeCompare(b));
  return {
    errors: [],
    extract: [sessionFile, ...subagents],
    ignored,
    summary: `1 session + ${subagents.length} ${subagents.length === 1 ? 'subagent' : 'subagents'}`,
    sessionId,
    subagentCount: subagents.length,
  };
}
