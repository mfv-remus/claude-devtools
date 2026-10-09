import { describe, expect, it } from 'vitest';

import { buildEvalResultsView } from '../../../../src/main/services/imports/evalResultsView';

// All content is invented.
describe('buildEvalResultsView', () => {
  it('never throws on garbage and returns an empty view', () => {
    for (const raw of [null, 5, 'x', [], { cases: 'nope' }]) {
      expect(buildEvalResultsView(raw)).toMatchObject({ partial: false, cases: [] });
    }
  });

  it('copies only known fields and keeps a single-arm case without delta', () => {
    const view = buildEvalResultsView({
      partial: true,
      partialReason: 'rate limit',
      secret: 'ignored',
      aggregates: { casesTotal: 2, casesPassed: 1, meanDelta: -0.25 },
      cases: [
        {
          name: 'alpha',
          graders: [{}, {}],
          aggregates: { score: 0.5, passRate: 0.5 },
          arms: {
            with: [
              {
                score: 0.5,
                passed: false,
                error: null,
                graders: [
                  { name: 'g1', passed: false, weight: 2, judgeVotes: [true, false, 'x'] },
                  { passed: true },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(view).not.toHaveProperty('secret');
    expect(view.partialReason).toBe('rate limit');
    const [alpha] = view.cases;
    expect(alpha.delta).toBeUndefined();
    expect(alpha.arms.without).toEqual([]);
    expect(alpha.graderCount).toBe(2);
    // The grader without a name is dropped; votes are coerced to booleans.
    expect(alpha.arms.with[0].graders).toEqual([
      expect.objectContaining({ name: 'g1', weight: 2, judgeVotes: [true, false, false] }),
    ]);
    expect(alpha.arms.with[0].error).toBeUndefined();
  });

  it('keeps an error distinct from a zero score, and describes an abort', () => {
    const [c] = buildEvalResultsView({
      cases: [
        {
          name: 'alpha',
          arms: {
            with: [
              { score: 0.9, passed: true, error: 'rate limited' },
              { score: 0, passed: false, error: null, aborted: { server: 's', tool: 't' } },
            ],
          },
        },
      ],
    }).cases;
    expect(c.arms.with[0]).toMatchObject({ error: 'rate limited', score: 0.9 });
    expect(c.arms.with[1].error).toBeUndefined();
    expect(c.arms.with[1].aborted).toBe('s · t');
  });

  it('caps long text', () => {
    const [c] = buildEvalResultsView({
      cases: [{ name: 'a', arms: { with: [{ error: 'x'.repeat(5000) }] } }],
    }).cases;
    expect(c.arms.with[0].error).toHaveLength(2000);
  });
});
