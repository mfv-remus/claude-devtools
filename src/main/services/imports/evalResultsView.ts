/**
 * Builds the viewer's read model of an eval run from the raw results.json.
 *
 * results.json is sender-controlled and "unknown fields are ignored" (schemaVersion 1), so
 * this copies only the fields the UI uses, coerces types defensively and caps text lengths.
 * It never throws: a malformed field is dropped, not fatal (the bundle was already
 * validated at import time).
 */

import type {
  EvalCaseView,
  EvalGraderView,
  EvalResultsView,
  EvalRunView,
} from '@shared/types/imports';

const MAX_TEXT = 2000;
const MAX_NAME = 200;
const MAX_CASES = 1000;
const MAX_RUNS = 100;
const MAX_GRADERS = 200;
const MAX_VOTES = 50;

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const text = (value: unknown, max = MAX_TEXT): string | undefined =>
  typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined;

function abortedText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const parts = [text(value.server, MAX_NAME), text(value.tool, MAX_NAME), text(value.reason)];
  const joined = parts.filter(Boolean).join(' · ');
  return joined || 'aborted';
}

function toGrader(raw: unknown): EvalGraderView | null {
  if (!isRecord(raw)) return null;
  const name = text(raw.name, MAX_NAME);
  if (!name) return null;
  return {
    name,
    passed: raw.passed === true,
    weight: num(raw.weight) ?? 1,
    explanation: text(raw.explanation),
    judgeVotes: Array.isArray(raw.judgeVotes)
      ? raw.judgeVotes.slice(0, MAX_VOTES).map((vote) => vote === true)
      : [],
    scored: raw.scored !== false,
  };
}

function toRun(raw: unknown): EvalRunView {
  const run = isRecord(raw) ? raw : {};
  return {
    score: num(run.score),
    passed: run.passed === true,
    turns: num(run.turns),
    costUsd: num(run.costUsd),
    judgeCostUsd: num(run.judgeCostUsd),
    durationSeconds: num(run.durationSeconds),
    error: run.error == null ? undefined : (text(run.error) ?? 'error'),
    aborted: run.aborted == null ? undefined : abortedText(run.aborted),
    skippedPaidGraders: run.skippedPaidGraders === true,
    graders: (Array.isArray(run.graders) ? run.graders : [])
      .slice(0, MAX_GRADERS)
      .map(toGrader)
      .filter((grader): grader is EvalGraderView => grader !== null),
  };
}

function toRuns(raw: unknown): EvalRunView[] {
  return Array.isArray(raw) ? raw.slice(0, MAX_RUNS).map(toRun) : [];
}

function toCase(raw: unknown): EvalCaseView | null {
  if (!isRecord(raw)) return null;
  const name = text(raw.name, MAX_NAME);
  if (!name) return null;
  const arms = isRecord(raw.arms) ? raw.arms : {};
  const aggregates = isRecord(raw.aggregates) ? raw.aggregates : {};
  return {
    name,
    runsPerCase: num(raw.runsPerCase) ?? 0,
    graderCount: Array.isArray(raw.graders) ? raw.graders.length : 0,
    arms: { with: toRuns(arms.with), without: toRuns(arms.without) },
    score: num(aggregates.score),
    passRate: num(aggregates.passRate),
    scoreWithout: num(aggregates.scoreWithout),
    passRateWithout: num(aggregates.passRateWithout),
    delta: num(aggregates.delta),
  };
}

export function buildEvalResultsView(raw: unknown): EvalResultsView {
  const results = isRecord(raw) ? raw : {};
  const aggregates = isRecord(results.aggregates) ? results.aggregates : {};
  return {
    claudeVersion: text(results.claudeVersion, MAX_NAME),
    partial: results.partial === true,
    partialReason: text(results.partialReason, MAX_NAME),
    costUsd: num(results.costUsd),
    durationSeconds: num(results.durationSeconds),
    startedAt: text(results.startedAt, MAX_NAME),
    aggregates: {
      casesTotal: num(aggregates.casesTotal),
      casesPassed: num(aggregates.casesPassed),
      overallScore: num(aggregates.overallScore),
      overallPassRate: num(aggregates.overallPassRate),
      meanDelta: num(aggregates.meanDelta),
    },
    cases: (Array.isArray(results.cases) ? results.cases : [])
      .slice(0, MAX_CASES)
      .map(toCase)
      .filter((item): item is EvalCaseView => item !== null),
  };
}
