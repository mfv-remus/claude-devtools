/**
 * Import slice - imported eval runs and sessions (standalone/Docker server only).
 *
 * Holds the capability flags, the import list and the actions behind the sidebar
 * section and import dialog. Imports are immutable copies stored on the server; this
 * slice only mirrors the server list and opens tabs for it.
 */

import { ImportApiError, importsApi } from '@renderer/api/imports';
import { createLogger } from '@shared/utils/logger';

import type { AppState } from '../types';
import type {
  EvalResultsView,
  ImportCapabilities,
  ImportListEntry,
  ImportManifest,
  ImportTraceRef,
  ImportType,
} from '@shared/types/imports';
import type { StateCreator } from 'zustand';

const logger = createLogger('Store:imports');

export interface ImportSlice {
  /** null until the first capability check finishes */
  importCapabilities: ImportCapabilities | null;
  imports: ImportListEntry[];
  importsLoading: boolean;
  importsLoaded: boolean;
  importsError: string | null;

  /** Eval results by import id (immutable per import, so cached until deleted) */
  evalResultsByImportId: Record<string, EvalResultsView | undefined>;
  evalResultsErrorByImportId: Record<string, string | undefined>;
  loadEvalResults: (importId: string) => Promise<void>;

  loadImportCapabilities: () => Promise<void>;
  fetchImports: () => Promise<void>;
  /** Resolves with the new manifest; rejects with ImportApiError (all server errors) */
  uploadImport: (
    params: { file: File; type: ImportType; name: string },
    options?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }
  ) => Promise<ImportManifest>;
  renameImport: (id: string, name: string) => Promise<void>;
  deleteImport: (id: string) => Promise<void>;
  /** Eval-run: overview tab. Session: opens the session directly. */
  openImport: (importId: string) => Promise<void>;
  /** Opens one trace (or the session) of an import in a normal session tab */
  openImportTrace: (importId: string, trace: ImportTraceRef) => void;
}

const importProjectId = (importId: string): string => `import:${importId}`;

export const createImportSlice: StateCreator<AppState, [], [], ImportSlice> = (set, get) => ({
  importCapabilities: null,
  imports: [],
  importsLoading: false,
  importsLoaded: false,
  importsError: null,
  evalResultsByImportId: {},
  evalResultsErrorByImportId: {},

  loadEvalResults: async (importId): Promise<void> => {
    if (get().evalResultsByImportId[importId]) return;
    try {
      const results = await importsApi.getResults(importId);
      set((state) => ({
        evalResultsByImportId: { ...state.evalResultsByImportId, [importId]: results },
        evalResultsErrorByImportId: { ...state.evalResultsErrorByImportId, [importId]: undefined },
      }));
    } catch (error) {
      logger.error('Failed to load eval results:', error);
      set((state) => ({
        evalResultsErrorByImportId: {
          ...state.evalResultsErrorByImportId,
          [importId]: error instanceof Error ? error.message : 'Failed to load results',
        },
      }));
    }
  },

  loadImportCapabilities: async (): Promise<void> => {
    if (get().importCapabilities) return;
    const capabilities = await importsApi.getCapabilities();
    set({ importCapabilities: capabilities });
    if (capabilities.enabled) await get().fetchImports();
  },

  fetchImports: async (): Promise<void> => {
    set({ importsLoading: true, importsError: null });
    try {
      const imports = await importsApi.list();
      set({ imports, importsLoading: false, importsLoaded: true });
    } catch (error) {
      logger.error('Failed to load imports:', error);
      set({
        importsLoading: false,
        importsLoaded: true,
        importsError: error instanceof Error ? error.message : 'Failed to load imports',
      });
    }
  },

  uploadImport: async (params, options): Promise<ImportManifest> => {
    const { manifest } = await importsApi.upload(params, options);
    await get().fetchImports();
    return manifest;
  },

  renameImport: async (id, name): Promise<void> => {
    const updated = await importsApi.rename(id, name);
    set((state) => ({
      imports: state.imports.map((entry) =>
        entry.valid && entry.manifest.id === id ? { valid: true, manifest: updated } : entry
      ),
    }));
  },

  deleteImport: async (id): Promise<void> => {
    try {
      await importsApi.remove(id);
    } catch (error) {
      // Already gone (deleted elsewhere): the list below is refreshed either way.
      if (!(error instanceof ImportApiError && error.status === 404)) throw error;
    }
    set((state) => {
      const { [id]: _removed, ...rest } = state.evalResultsByImportId;
      return { evalResultsByImportId: rest };
    });
    await get().fetchImports();
  },

  openImport: async (importId): Promise<void> => {
    if (!get().importsLoaded) await get().fetchImports();
    const entry = get().imports.find((item) =>
      item.valid ? item.manifest.id === importId : item.id === importId
    );

    if (entry?.valid && entry.manifest.type === 'session' && entry.manifest.sessionId) {
      get().openImportTrace(importId, {
        id: entry.manifest.sessionId,
        file: '',
        caseName: entry.manifest.name,
        arm: 'with',
        run: 1,
      });
      return;
    }

    // Eval-run overview. An unknown id still opens a tab, which explains that the import
    // no longer exists (deleted, or a stale link).
    const state = get();
    for (const pane of state.paneLayout.panes) {
      const existing = pane.tabs.find((t) => t.type === 'eval-run' && t.importId === importId);
      if (existing) {
        state.setActiveTab(existing.id);
        return;
      }
    }
    state.openTab({
      type: 'eval-run',
      importId,
      label: entry?.valid ? entry.manifest.name : 'Import',
    });
  },

  openImportTrace: (importId, trace): void => {
    const label =
      trace.file === '' ? trace.caseName : `${trace.caseName} · ${trace.arm}-${trace.run}`;
    get().navigateToSession(importProjectId(importId), trace.id);
    // navigateToSession labels new tabs "Loading..."; name it by case/run instead.
    const tab = get().openTabs.find(
      (t) =>
        t.type === 'session' &&
        t.projectId === importProjectId(importId) &&
        t.sessionId === trace.id
    );
    if (tab) get().updateTabLabel(tab.id, label);
  },
});
