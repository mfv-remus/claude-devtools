/**
 * Pure helpers for the eval-run views: formatting, run status and the mapping between
 * results.json runs and the traces stored in the import manifest.
 */

import type {
  EvalArm,
  EvalCaseView,
  EvalResultsView,
  EvalRunView,
  ImportTraceRef,
} from '@shared/types/imports';

export type RunStatus = 'pass' | 'fail' | 'error' | 'missing';

/** `error` wins over pass/fail: an errored run is not a plain failure (see the eval docs). */
export function runStatus(
  run: EvalRunView | undefined,
  trace: ImportTraceRef | undefined
): RunStatus {
  if (!run || !trace) return run?.error ? 'error' : 'missing';
  if (run.error || run.aborted) return 'error';
  return run.passed ? 'pass' : 'fail';
}

/** Trace of run `index` (0-based) of an arm. Matching is by position, never by tracePath. */
export function findTrace(
  traces: readonly ImportTraceRef[],
  caseName: string,
  arm: EvalArm,
  index: number
): ImportTraceRef | undefined {
  return traces.find((t) => t.caseName === caseName && t.arm === arm && t.run === index + 1);
}

export interface LocatedRun {
  caseView: EvalCaseView;
  arm: EvalArm;
  index: number;
  run: EvalRunView | undefined;
}

export function locateRun(results: EvalResultsView, trace: ImportTraceRef): LocatedRun | null {
  const caseView = results.cases.find((c) => c.name === trace.caseName);
  if (!caseView) return null;
  const index = trace.run - 1;
  return { caseView, arm: trace.arm, index, run: caseView.arms[trace.arm][index] };
}

/** Cases ordered worst delta first; single-arm cases (no delta) go last. */
export function sortCases(cases: readonly EvalCaseView[], sort: 'delta' | 'name'): EvalCaseView[] {
  const copy = [...cases];
  if (sort === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name));
  return copy.sort(
    (a, b) => (a.delta ?? Number.POSITIVE_INFINITY) - (b.delta ?? Number.POSITIVE_INFINITY)
  );
}

export const formatScore = (n: number | undefined): string => (n == null ? '–' : n.toFixed(2));
export const formatPercent = (n: number | undefined): string =>
  n == null ? '–' : `${Math.round(n * 100)}%`;
export const formatUsd = (n: number | undefined): string => (n == null ? '–' : `$${n.toFixed(2)}`);

export function formatDelta(n: number | undefined): string {
  if (n == null) return '–';
  return `${n > 0 ? '+' : ''}${(n * 100).toFixed(1)} pts`;
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds == null) return '–';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  return `${Math.round(seconds / 60)} min`;
}

export function averageCost(runs: readonly EvalRunView[]): number | undefined {
  const costs = runs.map((r) => r.costUsd).filter((c): c is number => c != null);
  return costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : undefined;
}

/** Failed graders first, each group keeping the order of results.json. */
export function splitGraders(run: EvalRunView): {
  failed: EvalRunView['graders'];
  passed: EvalRunView['graders'];
} {
  return {
    failed: run.graders.filter((g) => !g.passed),
    passed: run.graders.filter((g) => g.passed),
  };
}
