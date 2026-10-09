import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ electron: false }));

vi.mock('../../../src/renderer/api/index', () => ({
  getHttpBaseUrl: () => 'http://server.test',
  isElectronMode: () => state.electron,
}));

import { ImportApiError, importsApi } from '../../../src/renderer/api/imports';

const reply = (status: number, body: unknown): Response =>
  new Response(body === null ? '' : JSON.stringify(body), { status });

describe('importsApi', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    state.electron = false;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports imports as disabled in Electron without any request', async () => {
    state.electron = true;
    expect(await importsApi.getCapabilities()).toEqual({ enabled: false, readonly: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a server without the routes as "feature absent"', async () => {
    fetchMock.mockResolvedValue(reply(404, { error: 'Not found' }));
    expect(await importsApi.getCapabilities()).toEqual({ enabled: false, readonly: true });
  });

  it('sends the cross-site guard header on rename and delete, not on reads', async () => {
    fetchMock.mockResolvedValue(reply(200, { id: 'x', name: 'n' }));
    await importsApi.rename('abc', 'New name');
    const rename = fetchMock.mock.calls[0];
    expect(rename[0]).toBe('http://server.test/api/imports/abc');
    expect(rename[1].method).toBe('PATCH');
    expect(rename[1].headers['x-claude-devtools']).toBe('1');
    expect(JSON.parse(rename[1].body)).toEqual({ name: 'New name' });

    fetchMock.mockResolvedValue(reply(204, null));
    await importsApi.remove('abc');
    expect(fetchMock.mock.calls[1][1].headers['x-claude-devtools']).toBe('1');

    fetchMock.mockResolvedValue(reply(200, []));
    await importsApi.list();
    expect(fetchMock.mock.calls[2][1]).toBeUndefined();
  });

  it('exposes every server error of a failed request', async () => {
    fetchMock.mockResolvedValue(reply(400, { errors: ['first problem', 'second problem'] }));
    const failure = await importsApi.list().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ImportApiError);
    expect((failure as ImportApiError).errors).toEqual(['first problem', 'second problem']);
    expect((failure as ImportApiError).status).toBe(400);
  });

  it('falls back to a generic message for a non-JSON error body', async () => {
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    const failure = (await importsApi.list().catch((error: unknown) => error)) as ImportApiError;
    expect(failure.errors).toEqual(['HTTP 502']);
  });

  it('rejects an upload that is already cancelled without sending anything', async () => {
    const controller = new AbortController();
    controller.abort();
    const file = new File(['x'], 'a.zip');
    await expect(
      importsApi.upload({ file, type: 'session', name: 'n' }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
