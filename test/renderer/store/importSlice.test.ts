import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installMockElectronAPI } from '../../mocks/electronAPI';

import type { ImportListEntry, ImportManifest } from '../../../src/shared/types/imports';

const apiMock = vi.hoisted(() => ({
  getCapabilities: vi.fn(),
  list: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
  getResults: vi.fn(),
}));

vi.mock('../../../src/renderer/api/imports', () => {
  class ImportApiError extends Error {
    errors: string[];
    constructor(
      errors: string[],
      readonly status: number
    ) {
      super(errors[0]);
      this.errors = errors;
    }
  }
  return { importsApi: apiMock, ImportApiError };
});

import { createTestStore } from './storeTestUtils';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function manifest(id: string, overrides: Partial<ImportManifest> = {}): ImportManifest {
  return {
    id,
    name: `import ${id.slice(0, 4)}`,
    type: 'eval-run',
    createdAt: '2026-01-01T00:00:00.000Z',
    summary: '1 case',
    traces: [
      { id: 't001', file: 'traces/alpha/with-1.jsonl', caseName: 'alpha', arm: 'with', run: 1 },
    ],
    ...overrides,
  };
}

const valid = (m: ImportManifest): ImportListEntry => ({ valid: true, manifest: m });

describe('importSlice', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    installMockElectronAPI();
  });

  it('does not list imports when the server has the feature disabled', async () => {
    apiMock.getCapabilities.mockResolvedValue({ enabled: false, readonly: true });
    const store = createTestStore();
    await store.getState().loadImportCapabilities();
    expect(store.getState().importCapabilities).toEqual({ enabled: false, readonly: true });
    expect(apiMock.list).not.toHaveBeenCalled();
  });

  it('loads the list when enabled, and keeps an error from breaking the app', async () => {
    apiMock.getCapabilities.mockResolvedValue({ enabled: true, readonly: false });
    apiMock.list.mockResolvedValue([valid(manifest(ID_A))]);
    const store = createTestStore();
    await store.getState().loadImportCapabilities();
    expect(store.getState().imports).toHaveLength(1);

    apiMock.list.mockRejectedValue(new Error('boom'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await store.getState().fetchImports();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    expect(store.getState().importsError).toBe('boom');
    expect(store.getState().importsLoading).toBe(false);
  });

  it('opens an eval-run overview tab once and focuses it on the second open', async () => {
    apiMock.list.mockResolvedValue([valid(manifest(ID_A, { name: 'Run A' }))]);
    const store = createTestStore();
    await store.getState().openImport(ID_A);
    await store.getState().openImport(ID_A);
    const tabs = store.getState().openTabs.filter((t) => t.type === 'eval-run');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ importId: ID_A, label: 'Run A' });
  });

  it('opens an overview tab for an unknown import so the view can explain it', async () => {
    apiMock.list.mockResolvedValue([]);
    const store = createTestStore();
    await store.getState().openImport(ID_B);
    expect(store.getState().openTabs[0]).toMatchObject({ type: 'eval-run', importId: ID_B });
  });

  it('opens a session import directly as a session tab', async () => {
    const sessionId = '0c28b55a-823d-41df-90ea-3ac39db23ce7';
    apiMock.list.mockResolvedValue([
      valid(manifest(ID_A, { type: 'session', sessionId, name: 'My session', traces: undefined })),
    ]);
    const store = createTestStore();
    await store.getState().openImport(ID_A);
    expect(store.getState().openTabs[0]).toMatchObject({
      type: 'session',
      projectId: `import:${ID_A}`,
      sessionId,
      label: 'My session',
    });
  });

  it('keeps traces with the same id in different imports in separate tabs', () => {
    const store = createTestStore();
    const trace = manifest(ID_A).traces![0];
    store.getState().openImportTrace(ID_A, trace);
    store.getState().openImportTrace(ID_B, trace);
    store.getState().openImportTrace(ID_A, trace);
    const sessions = store.getState().openTabs.filter((t) => t.type === 'session');
    expect(sessions.map((t) => t.projectId)).toEqual([`import:${ID_A}`, `import:${ID_B}`]);
    expect(sessions[0].label).toBe('alpha · with-1');
  });

  it('refreshes the list after an upload and returns the manifest', async () => {
    const created = manifest(ID_A);
    apiMock.upload.mockResolvedValue({ manifest: created, ignored: [] });
    apiMock.list.mockResolvedValue([valid(created)]);
    const store = createTestStore();
    const file = new File(['x'], 'a.zip');
    expect(await store.getState().uploadImport({ file, type: 'eval-run', name: 'n' })).toEqual(
      created
    );
    expect(store.getState().imports).toHaveLength(1);
  });

  it('propagates upload errors untouched so the dialog can list all of them', async () => {
    const failure = Object.assign(new Error('x'), { errors: ['a', 'b'] });
    apiMock.upload.mockRejectedValue(failure);
    const store = createTestStore();
    const file = new File(['x'], 'a.zip');
    await expect(store.getState().uploadImport({ file, type: 'session', name: 'n' })).rejects.toBe(
      failure
    );
  });

  it('renames in place and treats a delete of an already-deleted import as success', async () => {
    apiMock.list.mockResolvedValue([valid(manifest(ID_A))]);
    const store = createTestStore();
    await store.getState().fetchImports();

    apiMock.rename.mockResolvedValue(manifest(ID_A, { name: 'Renamed' }));
    await store.getState().renameImport(ID_A, 'Renamed');
    const entry = store.getState().imports[0];
    expect(entry.valid && entry.manifest.name).toBe('Renamed');

    const { ImportApiError } = await import('../../../src/renderer/api/imports');
    apiMock.remove.mockRejectedValue(new ImportApiError(['Import not found'], 404));
    apiMock.list.mockResolvedValue([]);
    await store.getState().deleteImport(ID_A);
    expect(store.getState().imports).toEqual([]);
  });

  it('caches eval results per import and records a load error', async () => {
    const results = { partial: false, aggregates: {}, cases: [] };
    apiMock.getResults.mockResolvedValue(results);
    const store = createTestStore();
    await store.getState().loadEvalResults(ID_A);
    await store.getState().loadEvalResults(ID_A);
    expect(apiMock.getResults).toHaveBeenCalledTimes(1);
    expect(store.getState().evalResultsByImportId[ID_A]).toBe(results);

    apiMock.getResults.mockRejectedValue(new Error('gone'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await store.getState().loadEvalResults(ID_B);
    logged.mockRestore();
    expect(store.getState().evalResultsErrorByImportId[ID_B]).toBe('gone');
  });
});
