import { describe, expect, it } from 'vitest';

import {
  validateEvalRunBundle,
  validateSessionBundle,
} from '../../../../src/main/services/imports/bundleValidators';

// All fixtures are fake: invented case names and values, no real eval data.

interface FakeRun {
  error?: string | null;
}

function fakeResults(overrides: Record<string, unknown> = {}, cases?: unknown[]) {
  const run = (): FakeRun => ({ error: null });
  return {
    schemaVersion: 1,
    claudeVersion: '9.9.9',
    partial: false,
    cases: cases ?? [
      {
        name: 'alpha',
        runsPerCase: 2,
        arms: { with: [run(), run()], without: [run(), run()] },
      },
      {
        name: 'beta',
        runsPerCase: 2,
        arms: { with: [run(), run()], without: [run(), run()] },
      },
    ],
    ...overrides,
  };
}

function allTraces(names: string[], runs = 2): string[] {
  return names.flatMap((name) =>
    (['with', 'without'] as const).flatMap((arm) =>
      Array.from({ length: runs }, (_, i) => `traces/${name}/${arm}-${i + 1}.jsonl`)
    )
  );
}

const FULL_FILES = ['results.json', ...allTraces(['alpha', 'beta'])];

describe('validateEvalRunBundle', () => {
  it('accepts a complete bundle and assigns opaque trace ids in order', () => {
    const result = validateEvalRunBundle(FULL_FILES, fakeResults());
    expect(result.errors).toEqual([]);
    expect(result.summary).toBe('2 cases × 2 arms × 2 runs');
    expect(result.claudeVersion).toBe('9.9.9');
    expect(result.partial).toBe(false);
    expect(result.traces).toHaveLength(8);
    expect(result.traces[0]).toEqual({
      id: 't001',
      file: 'traces/alpha/with-1.jsonl',
      caseName: 'alpha',
      arm: 'with',
      run: 1,
    });
    expect(result.traces[7].id).toBe('t008');
    expect(result.extract).toEqual(['results.json', ...result.traces.map((t) => t.file)]);
  });

  it('skips aggregate-result.json and report.html without error', () => {
    const files = [...FULL_FILES, 'aggregate-result.json', 'report.html'];
    const result = validateEvalRunBundle(files, fakeResults());
    expect(result.errors).toEqual([]);
    expect(result.ignored).toEqual(['aggregate-result.json', 'report.html']);
    expect(result.extract).not.toContain('report.html');
  });

  it('rejects when results.json is missing', () => {
    const result = validateEvalRunBundle(['traces/alpha/with-1.jsonl'], undefined);
    expect(result.errors[0]).toContain('results.json is missing');
    expect(result.extract).toEqual([]);
  });

  it('rejects results.json that is not an object', () => {
    const result = validateEvalRunBundle(['results.json'], [1, 2]);
    expect(result.errors).toEqual(['results.json is not a valid JSON object']);
  });

  it.each([[2], [undefined], ['1'], [0]])('rejects schemaVersion %j', (version) => {
    const result = validateEvalRunBundle(FULL_FILES, fakeResults({ schemaVersion: version }));
    expect(result.errors[0]).toContain('Unsupported results.json schemaVersion');
  });

  it('ignores unknown fields', () => {
    const result = validateEvalRunBundle(
      FULL_FILES,
      fakeResults({ somethingNew: { a: 1 }, suite: { x: 1 } })
    );
    expect(result.errors).toEqual([]);
  });

  it('rejects an empty case list', () => {
    expect(validateEvalRunBundle(['results.json'], fakeResults({}, [])).errors).toEqual([
      'results.json has no cases',
    ]);
  });

  it('reports every missing trace', () => {
    const files = FULL_FILES.filter(
      (f) => f !== 'traces/alpha/with-2.jsonl' && f !== 'traces/beta/without-1.jsonl'
    );
    const result = validateEvalRunBundle(files, fakeResults());
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('"alpha", "with" run 2');
    expect(result.errors[1]).toContain('"beta", "without" run 1');
    expect(result.extract).toEqual([]);
  });

  it('tolerates a missing trace for a run that ended with an error', () => {
    const results = fakeResults({}, [
      {
        name: 'alpha',
        runsPerCase: 2,
        arms: { with: [{ error: null }, { error: 'timed out after 300s' }], without: [{}, {}] },
      },
    ]);
    const files = [
      'results.json',
      ...allTraces(['alpha']).filter((f) => f !== 'traces/alpha/with-2.jsonl'),
    ];
    const result = validateEvalRunBundle(files, results);
    expect(result.errors).toEqual([]);
    expect(result.traces).toHaveLength(3);
  });

  it('tolerates missing traces for a partial suite, and labels it', () => {
    const results = fakeResults({ partial: true, partialReason: 'cost_ceiling' });
    const result = validateEvalRunBundle(['results.json', 'traces/alpha/with-1.jsonl'], results);
    expect(result.errors).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe('cost_ceiling');
    expect(result.summary).toContain('(partial)');
  });

  it('stays strict when partial is false', () => {
    const result = validateEvalRunBundle(
      ['results.json', 'traces/alpha/with-1.jsonl'],
      fakeResults()
    );
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects unexpected files, including extra trace numbers', () => {
    const files = [
      ...FULL_FILES,
      'traces/alpha/with-3.jsonl',
      'notes.txt',
      'traces/ghost/with-1.jsonl',
    ];
    const result = validateEvalRunBundle(files, fakeResults());
    expect(result.errors).toEqual([
      'Unexpected file "traces/alpha/with-3.jsonl"',
      'Unexpected file "notes.txt"',
      'Unexpected file "traces/ghost/with-1.jsonl"',
    ]);
  });

  it('rejects a run count that disagrees with runsPerCase unless partial', () => {
    const results = fakeResults({}, [
      { name: 'alpha', runsPerCase: 3, arms: { with: [{}, {}], without: [{}, {}] } },
    ]);
    const files = ['results.json', ...allTraces(['alpha'])];
    expect(validateEvalRunBundle(files, results).errors[0]).toContain('expected runsPerCase=3');
    expect(validateEvalRunBundle(files, { ...results, partial: true }).errors).toEqual([]);
  });

  it('supports single-arm cases (no without runs)', () => {
    const results = fakeResults({}, [{ name: 'solo', runsPerCase: 2, arms: { with: [{}, {}] } }]);
    const files = ['results.json', 'traces/solo/with-1.jsonl', 'traces/solo/with-2.jsonl'];
    const result = validateEvalRunBundle(files, results);
    expect(result.errors).toEqual([]);
    expect(result.summary).toBe('1 case × 1 arm × 2 runs');
  });

  it('rejects duplicate case names', () => {
    const results = fakeResults({}, [
      { name: 'dup', arms: { with: [] } },
      { name: 'dup', arms: { with: [] } },
    ]);
    expect(validateEvalRunBundle(['results.json'], results).errors).toEqual([
      'Duplicate case name "dup"',
    ]);
  });

  it.each([
    ['../escape'],
    ['a/b'],
    ['a\\b'],
    ['..'],
    ['.'],
    [''],
    ['x'.repeat(201)],
    ['bad\u0000name'],
  ])('rejects case name %j: names are labels, never path parts', (name) => {
    const results = fakeResults({}, [{ name, arms: { with: [] } }]);
    const result = validateEvalRunBundle(['results.json'], results);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.extract).toEqual([]);
  });

  it('rejects a case without with-runs or with malformed arms', () => {
    const results = fakeResults({}, [
      { name: 'a', arms: {} },
      { name: 'b', arms: { with: 'nope' } },
      { name: 'c', arms: { with: [], without: 5 } },
      'not-an-object',
    ]);
    const { errors } = validateEvalRunBundle(['results.json'], results);
    expect(errors).toHaveLength(4);
  });

  it('never echoes control characters from file names', () => {
    const result = validateEvalRunBundle([...FULL_FILES, 'bad\u0000.txt'], fakeResults());
    // eslint-disable-next-line no-control-regex -- asserting their absence
    expect(result.errors.join('')).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('validateSessionBundle', () => {
  const ID = '0c28b55a-823d-41df-90ea-3ac39db23ce7';

  it('accepts a session with subagents', () => {
    const files = [`${ID}.jsonl`, `${ID}/subagents/agent-b.jsonl`, `${ID}/subagents/agent-a.jsonl`];
    const result = validateSessionBundle(files);
    expect(result.errors).toEqual([]);
    expect(result.sessionId).toBe(ID);
    expect(result.subagentCount).toBe(2);
    expect(result.summary).toBe('1 session + 2 subagents');
    expect(result.extract).toEqual([
      `${ID}.jsonl`,
      `${ID}/subagents/agent-a.jsonl`,
      `${ID}/subagents/agent-b.jsonl`,
    ]);
  });

  it('accepts a session without subagents', () => {
    const result = validateSessionBundle([`${ID}.jsonl`]);
    expect(result.errors).toEqual([]);
    expect(result.summary).toBe('1 session + 0 subagents');
  });

  it('skips tool-results instead of rejecting the bundle', () => {
    const files = [`${ID}.jsonl`, `${ID}/tool-results/toolu_1.txt`];
    const result = validateSessionBundle(files);
    expect(result.errors).toEqual([]);
    expect(result.ignored).toEqual([`${ID}/tool-results/toolu_1.txt`]);
    expect(result.extract).toEqual([`${ID}.jsonl`]);
  });

  it('rejects a missing session file', () => {
    expect(validateSessionBundle(['notes.txt']).errors[0]).toContain('No <sessionId>.jsonl');
  });

  it('rejects a session file whose name is not a UUID', () => {
    expect(validateSessionBundle(['my-session.jsonl']).errors[0]).toContain('No <sessionId>.jsonl');
  });

  it('rejects more than one session file', () => {
    const other = '11111111-2222-3333-4444-555555555555';
    const result = validateSessionBundle([`${ID}.jsonl`, `${other}.jsonl`]);
    expect(result.errors[0]).toContain('exactly one');
  });

  it("rejects files outside the layout, including another session's subagents", () => {
    const other = '11111111-2222-3333-4444-555555555555';
    const result = validateSessionBundle([
      `${ID}.jsonl`,
      `${other}/subagents/agent-x.jsonl`,
      `${ID}/subagents/not-an-agent.jsonl`,
      `${ID}/subagents/agent-x.txt`,
      'readme.md',
    ]);
    expect(result.errors).toHaveLength(4);
    expect(result.extract).toEqual([]);
  });
});
