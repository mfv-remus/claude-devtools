/**
 * Client for the imports HTTP routes (standalone/Docker server only).
 *
 * Imports are not part of the ElectronAPI contract: Electron v1 has no imports, so the
 * capability check short-circuits there without any request. Write requests carry the
 * `x-claude-devtools` header the server requires against cross-site requests.
 */

import { getHttpBaseUrl, isElectronMode } from './index';

import type {
  EvalResultsView,
  EvalTraceMeta,
  ImportCapabilities,
  ImportListEntry,
  ImportManifest,
  ImportType,
} from '@shared/types/imports';

const WRITE_HEADERS = { 'x-claude-devtools': '1' };

export class ImportApiError extends Error {
  /** All validation problems reported by the server (upload), or a single message */
  readonly errors: string[];

  constructor(
    errors: string[],
    readonly status: number
  ) {
    super(errors[0] ?? `HTTP ${status}`);
    this.errors = errors.length > 0 ? errors : [`HTTP ${status}`];
  }
}

function errorsFrom(body: unknown, status: number): string[] {
  const parsed = (body ?? {}) as { errors?: unknown; error?: unknown };
  if (Array.isArray(parsed.errors)) return parsed.errors.map(String);
  if (typeof parsed.error === 'string') return [parsed.error];
  return [`HTTP ${status}`];
}

function parseBody(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getHttpBaseUrl()}${path}`, init);
  const body = parseBody(await res.text());
  if (!res.ok) throw new ImportApiError(errorsFrom(body, res.status), res.status);
  return body as T;
}

export const importsApi = {
  async getCapabilities(): Promise<ImportCapabilities> {
    if (isElectronMode()) return { enabled: false, readonly: true };
    try {
      return await request<ImportCapabilities>('/api/imports/capabilities');
    } catch {
      // Older server without the routes: behave as "feature absent".
      return { enabled: false, readonly: true };
    }
  },

  list: (): Promise<ImportListEntry[]> => request<ImportListEntry[]>('/api/imports'),

  getResults: (id: string): Promise<EvalResultsView> =>
    request<EvalResultsView>(`/api/imports/${encodeURIComponent(id)}/results`),

  getTraceMeta: (id: string, sessionId: string): Promise<EvalTraceMeta> =>
    request<EvalTraceMeta>(
      `/api/imports/${encodeURIComponent(id)}/traces/${encodeURIComponent(sessionId)}/meta`
    ),

  rename: (id: string, name: string): Promise<ImportManifest> =>
    request<ImportManifest>(`/api/imports/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...WRITE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  async remove(id: string): Promise<void> {
    await request<null>(`/api/imports/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: WRITE_HEADERS,
    });
  },

  /**
   * Uploads a zip. XMLHttpRequest (not fetch) because it reports upload progress and can be
   * cancelled by aborting `signal`. Rejects with ImportApiError (all server errors) or an
   * AbortError-named Error when cancelled.
   */
  upload(
    params: { file: File; type: ImportType; name: string },
    options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
  ): Promise<{ manifest: ImportManifest; ignored: string[] }> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }));
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${getHttpBaseUrl()}/api/imports`);
      for (const [key, value] of Object.entries(WRITE_HEADERS)) xhr.setRequestHeader(key, value);

      xhr.upload.onprogress = (event): void => {
        if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
      };
      xhr.onload = (): void => {
        const body = parseBody(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body as { manifest: ImportManifest; ignored: string[] });
        } else {
          reject(new ImportApiError(errorsFrom(body, xhr.status), xhr.status));
        }
      };
      xhr.onerror = (): void =>
        reject(new ImportApiError(['Could not reach the server. Check your connection.'], 0));
      xhr.onabort = (): void => {
        const error = new Error('Upload cancelled');
        error.name = 'AbortError';
        reject(error);
      };

      options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });

      const form = new FormData();
      // Fields first: the server reads them as they stream in before the file.
      form.append('type', params.type);
      form.append('name', params.name);
      form.append('file', params.file, 'upload.zip');
      xhr.send(form);
    });
  },
};
