import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EvalResultsView, ImportTraceRef } from '../../../src/shared/types/imports';

const ID = '11111111-1111-4111-8111-111111111111';
const traces: ImportTraceRef[] = [
  { id: 't001', file: 'a', caseName: 'alpha', arm: 'with', run: 1 },
  { id: 't002', file: 'b', caseName: 'alpha', arm: 'with', run: 2 },
];
const run = (over = {}) => ({ passed: true, skippedPaidGraders: false, graders: [], ...over });
const results: EvalResultsView = {
  partial: false,
  costUsd: 1.5,
  durationSeconds: 30,
  aggregates: { casesTotal: 2, casesPassed: 1, overallScore: 0.75, meanDelta: -0.1 },
  cases: [
    {
      name: 'alpha',
      runsPerCase: 2,
      graderCount: 0,
      arms: { with: [run(), run({ passed: false, error: 'limit' })], without: [] },
      score: 0.5,
      passRate: 0.5,
    },
  ],
};

const storeState = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

import { EvalRunView } from '../../../src/renderer/components/imports/EvalRunView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('EvalRunView', () => {
  let container: HTMLDivElement;
  let root: Root;
  const openImportTrace = vi.fn();

  beforeEach(() => {
    openImportTrace.mockReset();
    Object.assign(storeState, {
      imports: [
        {
          valid: true,
          manifest: { id: ID, name: 'Nightly', type: 'eval-run', summary: '2 cases', traces },
        },
      ],
      importsLoaded: true,
      evalResultsByImportId: { [ID]: results },
      evalResultsErrorByImportId: {},
      fetchImports: vi.fn(),
      loadEvalResults: vi.fn(),
      openImportTrace,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(EvalRunView, { importId: ID })));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the tiles and a matrix with a dot per run', () => {
    expect(container.textContent).toContain('Suite score');
    expect(container.textContent).toContain('1/2');
    expect(container.textContent).toContain('not run');
    const dots = container.querySelectorAll('button[aria-label^="alpha with"]');
    expect([...dots].map((d) => d.getAttribute('aria-label'))).toEqual([
      'alpha with #1: passed',
      'alpha with #2: errored',
    ]);
  });

  it('opens the trace of the clicked run', () => {
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="alpha with #2: errored"]')!
        .click();
    });
    expect(openImportTrace).toHaveBeenCalledWith(ID, traces[1]);
  });

  it('explains an import that no longer exists', () => {
    storeState.imports = [];
    act(() => root.render(createElement(EvalRunView, { importId: ID })));
    expect(container.textContent).toContain('no longer exists');
  });
});
