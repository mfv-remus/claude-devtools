/**
 * EvalRunView - overview tab of an imported eval run: summary tiles and the
 * case x arm matrix. Each run dot opens that run's trace as a normal session tab.
 */

import { useEffect, useState } from 'react';

import { useStore } from '@renderer/store';
import {
  averageCost,
  findTrace,
  formatDelta,
  formatDuration,
  formatPercent,
  formatScore,
  formatUsd,
  runStatus,
  sortCases,
} from '@renderer/utils/evalResults';
import { useShallow } from 'zustand/react/shallow';

import type { RunStatus } from '@renderer/utils/evalResults';
import type {
  EvalArm,
  EvalCaseView,
  EvalResultsView,
  EvalRunView as EvalRunData,
  ImportTraceRef,
} from '@shared/types/imports';

interface EvalRunViewProps {
  importId: string;
}

const DOT_COLOR: Record<RunStatus, string> = {
  pass: 'var(--diff-added-text)',
  fail: 'var(--diff-removed-text)',
  error: 'var(--warning-text)',
  missing: 'transparent',
};

const STATUS_LABEL: Record<RunStatus, string> = {
  pass: 'passed',
  fail: 'failed',
  error: 'errored',
  missing: 'no trace',
};

export const EvalRunView = ({ importId }: EvalRunViewProps): React.JSX.Element => {
  const { entry, loaded, results, resultsError, fetchImports, loadEvalResults, openImportTrace } =
    useStore(
      useShallow((s) => ({
        entry: s.imports.find((item) =>
          item.valid ? item.manifest.id === importId : item.id === importId
        ),
        loaded: s.importsLoaded,
        results: s.evalResultsByImportId[importId],
        resultsError: s.evalResultsErrorByImportId[importId],
        fetchImports: s.fetchImports,
        loadEvalResults: s.loadEvalResults,
        openImportTrace: s.openImportTrace,
      }))
    );
  const [sort, setSort] = useState<'delta' | 'name'>('delta');

  useEffect(() => {
    if (!loaded) void fetchImports();
  }, [loaded, fetchImports]);

  const valid = entry?.valid === true;
  useEffect(() => {
    if (valid) void loadEvalResults(importId);
  }, [valid, importId, loadEvalResults]);

  if (!loaded) {
    return <Centered>Loading…</Centered>;
  }
  if (!entry) {
    return (
      <Centered>
        <p className="text-sm" style={{ color: 'var(--color-text)' }}>
          This import no longer exists.
        </p>
        <p className="mt-1 text-xs">It was deleted, or the link is out of date.</p>
      </Centered>
    );
  }
  if (!entry.valid) {
    return (
      <Centered>
        <p className="text-sm" style={{ color: 'var(--color-text)' }}>
          This import is invalid
        </p>
        <p className="mt-1 text-xs">{entry.error}. Delete it from the sidebar.</p>
      </Centered>
    );
  }

  const { manifest } = entry;
  const partialReason = results?.partialReason ?? manifest.partialReason;
  const traces = manifest.traces ?? [];

  return (
    <div className="flex-1 overflow-y-auto p-6" style={{ backgroundColor: 'var(--color-surface)' }}>
      <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
        {manifest.name}
        {(results?.partial ?? manifest.partial) && (
          <span
            className="ml-2 rounded px-1.5 py-0.5 align-middle text-xs"
            style={{
              backgroundColor: 'var(--badge-warning-bg)',
              color: 'var(--badge-warning-text)',
            }}
          >
            partial
            {partialReason ? `: ${partialReason}` : ''}
          </span>
        )}
      </h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        {manifest.summary}
        {manifest.claudeVersion ? ` · Claude Code ${manifest.claudeVersion}` : ''}
      </p>

      {resultsError && (
        <p role="alert" className="mt-4 text-sm" style={{ color: 'var(--warning-text)' }}>
          Could not load results: {resultsError}
        </p>
      )}
      {!results && !resultsError && (
        <p className="mt-4 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Loading results…
        </p>
      )}

      {results && (
        <>
          <Tiles results={results} />
          <div className="mb-2 mt-6 flex items-center justify-between">
            <h2 className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              Cases
            </h2>
            <label className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              Sort{' '}
              <select
                value={sort}
                onChange={(e): void => setSort(e.target.value === 'name' ? 'name' : 'delta')}
                className="rounded border px-1 py-0.5"
                style={{
                  backgroundColor: 'var(--color-surface)',
                  borderColor: 'var(--color-border-emphasis)',
                  color: 'var(--color-text)',
                }}
              >
                <option value="delta">Worst delta first</option>
                <option value="name">Name</option>
              </select>
            </label>
          </div>
          <Matrix
            cases={sortCases(results.cases, sort)}
            traces={traces}
            onOpen={(trace): void => openImportTrace(importId, trace)}
          />
        </>
      )}
    </div>
  );
};

const Tiles = ({ results }: { results: EvalResultsView }): React.JSX.Element => {
  const { aggregates: a } = results;
  const items: { label: string; value: string }[] = [
    { label: 'Suite score', value: formatScore(a.overallScore) },
    {
      label: 'Cases passed',
      value:
        a.casesPassed != null && a.casesTotal != null ? `${a.casesPassed}/${a.casesTotal}` : '–',
    },
    { label: 'Mean Δ', value: formatDelta(a.meanDelta) },
    { label: 'Cost', value: formatUsd(results.costUsd) },
    { label: 'Duration', value: formatDuration(results.durationSeconds) },
  ];
  return (
    <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded border p-3"
          style={{ backgroundColor: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
        >
          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {item.label}
          </div>
          <div className="mt-1 text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
};

interface MatrixProps {
  cases: EvalCaseView[];
  traces: ImportTraceRef[];
  onOpen: (trace: ImportTraceRef) => void;
}

const Matrix = ({ cases, traces, onOpen }: MatrixProps): React.JSX.Element => (
  <div className="overflow-x-auto rounded border" style={{ borderColor: 'var(--card-border)' }}>
    <table className="w-full text-left text-xs" style={{ color: 'var(--color-text-secondary)' }}>
      <thead style={{ backgroundColor: 'var(--card-header-bg)', color: 'var(--color-text-muted)' }}>
        <tr>
          <th className="px-3 py-2 font-medium">Case</th>
          <th className="px-3 py-2 font-medium">With</th>
          <th className="px-3 py-2 font-medium">Without</th>
          <th className="px-3 py-2 font-medium">Δ</th>
        </tr>
      </thead>
      <tbody>
        {cases.map((c) => (
          <tr key={c.name} className="border-t" style={{ borderColor: 'var(--card-border)' }}>
            <td className="px-3 py-2" style={{ color: 'var(--color-text)' }}>
              {c.name}
            </td>
            <ArmCell caseView={c} arm="with" traces={traces} onOpen={onOpen} />
            <ArmCell caseView={c} arm="without" traces={traces} onOpen={onOpen} />
            <td className="px-3 py-2">{formatDelta(c.delta)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

interface ArmCellProps {
  caseView: EvalCaseView;
  arm: EvalArm;
  traces: ImportTraceRef[];
  onOpen: (trace: ImportTraceRef) => void;
}

const ArmCell = ({ caseView, arm, traces, onOpen }: ArmCellProps): React.JSX.Element => {
  const runs: EvalRunData[] = caseView.arms[arm];
  if (runs.length === 0) {
    return (
      <td className="px-3 py-2" style={{ color: 'var(--color-text-muted)' }}>
        not run
      </td>
    );
  }
  const score = arm === 'with' ? caseView.score : caseView.scoreWithout;
  const passRate = arm === 'with' ? caseView.passRate : caseView.passRateWithout;
  return (
    <td className="px-3 py-2">
      <div style={{ color: 'var(--color-text)' }}>
        {formatScore(score)} · {formatPercent(passRate)} · {formatUsd(averageCost(runs))}
      </div>
      <div className="mt-1 flex gap-1">
        {runs.map((run, index) => {
          const trace = findTrace(traces, caseView.name, arm, index);
          const status = runStatus(run, trace);
          const label = `${caseView.name} ${arm} #${index + 1}: ${STATUS_LABEL[status]}`;
          return (
            <button
              key={index}
              type="button"
              disabled={!trace}
              aria-label={label}
              title={label}
              onClick={(): void => trace && onOpen(trace)}
              className="size-3 rounded-full border disabled:cursor-default"
              style={{
                backgroundColor: DOT_COLOR[status],
                borderColor: status === 'missing' ? 'var(--color-text-muted)' : DOT_COLOR[status],
                borderStyle: status === 'missing' ? 'dashed' : 'solid',
              }}
            />
          );
        })}
      </div>
    </td>
  );
};

const Centered = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <div
    className="flex flex-1 flex-col items-center justify-center p-8 text-center"
    style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text-muted)' }}
  >
    {children}
  </div>
);
