import { describe, expect, it } from 'vitest';

import {
  averageCost,
  findTrace,
  formatDelta,
  formatDuration,
  runStatus,
  sortCases,
  splitGraders,
} from '../../../src/renderer/utils/evalResults';

import type { EvalCaseView, EvalRunView, ImportTraceRef } from '../../../src/shared/types/imports';

const run = (over: Partial<EvalRunView> = {}): EvalRunView => ({
  passed: true,
  skippedPaidGraders: false,
  graders: [],
  ...over,
});
const trace: ImportTraceRef = { id: 't001', file: 'f', caseName: 'a', arm: 'with', run: 2 };
const kase = (name: string, delta?: number): EvalCaseView => ({
  name,
  runsPerCase: 1,
  graderCount: 0,
  arms: { with: [], without: [] },
  delta,
});

describe('evalResults utils', () => {
  it('treats error as its own status, not a failure', () => {
    expect(runStatus(run(), trace)).toBe('pass');
    expect(runStatus(run({ passed: false }), trace)).toBe('fail');
    expect(runStatus(run({ error: 'limit' }), trace)).toBe('error');
    expect(runStatus(run({ aborted: 'x' }), trace)).toBe('error');
    expect(runStatus(run(), undefined)).toBe('missing');
  });

  it('matches traces by position (run N is index N-1)', () => {
    expect(findTrace([trace], 'a', 'with', 1)).toBe(trace);
    expect(findTrace([trace], 'a', 'with', 0)).toBeUndefined();
  });

  it('sorts worst delta first with single-arm cases last, or by name', () => {
    const cases = [kase('b', 0.2), kase('c'), kase('a', -0.5)];
    expect(sortCases(cases, 'delta').map((c) => c.name)).toEqual(['a', 'b', 'c']);
    expect(sortCases([kase('z'), kase('y')], 'name').map((c) => c.name)).toEqual(['y', 'z']);
  });

  it('formats and aggregates', () => {
    expect(formatDelta(0.05)).toBe('+5.0 pts');
    expect(formatDelta(undefined)).toBe('–');
    expect(formatDuration(30)).toBe('30s');
    expect(formatDuration(600)).toBe('10 min');
    expect(averageCost([run({ costUsd: 1 }), run({ costUsd: 3 }), run()])).toBe(2);
    expect(averageCost([run()])).toBeUndefined();
  });

  it('puts failed graders first', () => {
    const g = (name: string, passed: boolean) => ({
      name,
      passed,
      weight: 1,
      judgeVotes: [],
      scored: true,
    });
    const { failed, passed } = splitGraders(run({ graders: [g('a', true), g('b', false)] }));
    expect(failed.map((x) => x.name)).toEqual(['b']);
    expect(passed.map((x) => x.name)).toEqual(['a']);
  });
});
