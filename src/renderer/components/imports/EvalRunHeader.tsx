/**
 * EvalRunHeader - grader summary shown on top of an imported eval trace's session tab.
 * Renders nothing for any other tab.
 */

import { useEffect, useState } from 'react';

import { importsApi } from '@renderer/api/imports';
import { useStore } from '@renderer/store';
import { getAllTabs } from '@renderer/store/utils/paneHelpers';
import {
  formatDuration,
  formatScore,
  formatUsd,
  locateRun,
  splitGraders,
} from '@renderer/utils/evalResults';
import { parseImportProjectId } from '@shared/utils/importProjectId';
import { useShallow } from 'zustand/react/shallow';

import type { EvalGraderView, EvalTraceMeta, ImportTraceRef } from '@shared/types/imports';

export const EvalRunHeader = ({ tabId }: { tabId?: string }): React.JSX.Element | null => {
  const { tab, results, manifestTraces, loadEvalResults, openImportTrace } = useStore(
    useShallow((s) => {
      const found = tabId ? getAllTabs(s.paneLayout).find((t) => t.id === tabId) : undefined;
      const id = parseImportProjectId(found?.projectId);
      const entry = id
        ? s.imports.find((i) => (i.valid ? i.manifest.id === id : false))
        : undefined;
      return {
        tab: found,
        results: id ? s.evalResultsByImportId[id] : undefined,
        manifestTraces: entry?.valid ? (entry.manifest.traces ?? []) : [],
        loadEvalResults: s.loadEvalResults,
        openImportTrace: s.openImportTrace,
      };
    })
  );
  const importId = parseImportProjectId(tab?.projectId);
  const trace = manifestTraces.find((t) => t.id === tab?.sessionId);
  const [loadedMeta, setMeta] = useState<{ key: string; meta: EvalTraceMeta } | null>(null);
  const metaKey = importId && trace ? `${importId}/${trace.id}` : '';
  const meta = loadedMeta?.key === metaKey ? loadedMeta.meta : null;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (importId && trace) void loadEvalResults(importId);
  }, [importId, trace, loadEvalResults]);

  useEffect(() => {
    if (!importId || !trace) return;
    let cancelled = false;
    importsApi
      .getTraceMeta(importId, trace.id)
      .then((m) => !cancelled && setMeta({ key: `${importId}/${trace.id}`, meta: m }))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [importId, trace]);

  if (!importId || !trace) return null;

  const located = results ? locateRun(results, trace) : null;
  const run = located?.run;
  const notices = traceNotices(meta);
  if (!run && notices.length === 0) return null;

  const siblings = located
    ? manifestTraces.filter((t) => t.caseName === trace.caseName && t.arm === trace.arm)
    : [];
  const { failed, passed } = run ? splitGraders(run) : { failed: [], passed: [] };

  return (
    <div
      className="border-b px-4 py-2 text-xs"
      style={{
        backgroundColor: 'var(--card-header-bg)',
        borderColor: 'var(--card-border)',
        color: 'var(--color-text-secondary)',
      }}
    >
      {run && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            className="rounded px-1.5 py-0.5 font-semibold"
            style={{
              backgroundColor: run.passed ? 'var(--badge-success-bg)' : 'var(--badge-error-bg)',
              color: 'var(--badge-success-text)',
            }}
          >
            {run.passed ? 'PASS' : 'FAIL'}
          </span>
          <span style={{ color: 'var(--color-text)' }}>{trace.caseName}</span>
          <span>
            {trace.arm} #{trace.run} of {located?.caseView.arms[trace.arm].length}
          </span>
          <span>score {formatScore(run.score)}</span>
          <span>
            {run.turns ?? '–'} turns · {formatDuration(run.durationSeconds)} · agent{' '}
            {formatUsd(run.costUsd)} · judge {formatUsd(run.judgeCostUsd)}
          </span>
          {run.graders.length > 0 && (
            <span>
              {failed.length} of {run.graders.length} graders failed
            </span>
          )}
          {siblings.length > 1 && (
            <span className="flex gap-1">
              {siblings.map((s) => (
                <SiblingChip
                  key={s.id}
                  trace={s}
                  current={s.id === trace.id}
                  onOpen={(): void => openImportTrace(importId, s)}
                />
              ))}
            </span>
          )}
          <button
            type="button"
            aria-expanded={open}
            onClick={(): void => setOpen((v) => !v)}
            className="underline"
          >
            {open ? 'Hide graders' : 'Show graders'}
          </button>
        </div>
      )}
      {run?.error && (
        <p role="alert" className="mt-1" style={{ color: 'var(--warning-text)' }}>
          Run error: {run.error}
        </p>
      )}
      {run?.aborted && (
        <p className="mt-1" style={{ color: 'var(--warning-text)' }}>
          Aborted by the mock: {run.aborted}
        </p>
      )}
      {run?.skippedPaidGraders && (
        <p className="mt-1" style={{ color: 'var(--warning-text)' }}>
          Judge graders were skipped by the cost ceiling; this score is not comparable.
        </p>
      )}
      {notices.map((n) => (
        <p key={n} className="mt-1" style={{ color: 'var(--warning-text)' }}>
          {n}
        </p>
      ))}
      {run && open && (
        <div className="mt-2 max-h-60 space-y-2 overflow-y-auto">
          <GraderGroup title="Failed" graders={failed} />
          <GraderGroup title="Passed" graders={passed} />
        </div>
      )}
    </div>
  );
};

function traceNotices(meta: EvalTraceMeta | null): string[] {
  if (!meta) return [];
  const out: string[] = [];
  if (!meta.hasInit) out.push('This trace has no init line; model and version are unknown.');
  if (!meta.hasResult) out.push('This trace has no result line; it may be truncated.');
  if (meta.hiddenSubagentLines > 0) {
    out.push(`${meta.hiddenSubagentLines} inline subagent lines are not shown.`);
  }
  for (const d of meta.permissionDenials) {
    const tool = d.toolName ? ` for ${d.toolName}` : '';
    const reason = d.message ? `: ${d.message}` : '';
    out.push(`Permission denied${tool}${reason}`);
  }
  return out;
}

const SiblingChip = ({
  trace,
  current,
  onOpen,
}: {
  trace: ImportTraceRef;
  current: boolean;
  onOpen: () => void;
}): React.JSX.Element => (
  <button
    type="button"
    onClick={onOpen}
    aria-current={current}
    className="rounded border px-1.5"
    style={{
      borderColor: 'var(--color-border-emphasis)',
      color: current ? 'var(--color-text)' : 'var(--color-text-muted)',
    }}
  >
    #{trace.run}
  </button>
);

const GraderGroup = ({
  title,
  graders,
}: {
  title: string;
  graders: EvalGraderView[];
}): React.JSX.Element | null =>
  graders.length === 0 ? null : (
    <section>
      <h3 className="mb-1 font-medium" style={{ color: 'var(--color-text)' }}>
        {title} ({graders.length})
      </h3>
      <ul className="space-y-1">
        {graders.map((g, index) => (
          <li key={`${index}-${g.name}`}>
            <span
              style={{ color: g.passed ? 'var(--diff-added-text)' : 'var(--diff-removed-text)' }}
            >
              {g.passed ? '✓' : '✗'}
            </span>{' '}
            {g.name} <span style={{ color: 'var(--color-text-muted)' }}>w{g.weight}</span>
            {!g.scored && <span style={{ color: 'var(--color-text-muted)' }}> (not scored)</span>}
            {g.judgeVotes.length > 0 && (
              <span className="ml-1">{g.judgeVotes.map((v) => (v ? '✓' : '✗')).join(' ')}</span>
            )}
            {g.explanation && (
              <div style={{ color: 'var(--color-text-muted)' }}>{g.explanation}</div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
