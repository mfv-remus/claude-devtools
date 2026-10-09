import Fastify, { type FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerImportRoutes } from '../../../src/main/http/imports';
import { ImportService } from '../../../src/main/services/imports/ImportService';
import { ImportSessionSource } from '../../../src/main/services/imports/ImportSessionSource';
import { buildZip } from '../services/imports/zipFixture';

// All content is invented.
const SESSION_ID = '0c28b55a-823d-41df-90ea-3ac39db23ce7';
const WRITE_HEADERS = { 'x-claude-devtools': '1' };

function sessionZip(): Buffer {
  const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } });
  return buildZip([{ name: `${SESSION_ID}.jsonl`, data: `${line}\n` }]);
}

function multipart(
  fields: Record<string, string>,
  file?: { name: string; data: Buffer }
): { body: Buffer; headers: Record<string, string> } {
  const boundary = '----test-boundary';
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      )
    );
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/zip\r\n\r\n`
      ),
      file.data,
      Buffer.from('\r\n')
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...WRITE_HEADERS },
  };
}

describe('import routes', () => {
  let root: string;
  let app: FastifyInstance;

  async function setup(opts: { readonly?: boolean; enabled?: boolean } = {}): Promise<void> {
    app = Fastify();
    registerImportRoutes(app, {
      service: opts.enabled === false ? undefined : new ImportService(root),
      readonly: opts.readonly ?? false,
    });
    await app.ready();
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-routes-'));
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function upload(extraHeaders: Record<string, string> = {}, name = 'My session') {
    const form = multipart(
      { type: 'session', name },
      { name: '../../evil.zip', data: sessionZip() }
    );
    return app.inject({
      method: 'POST',
      url: '/api/imports',
      payload: form.body,
      headers: { ...form.headers, ...extraHeaders },
    });
  }

  it('reports capabilities', async () => {
    await setup();
    expect((await app.inject('/api/imports/capabilities')).json()).toEqual({
      enabled: true,
      readonly: false,
    });
  });

  it('is disabled without a service and registers no import routes', async () => {
    await setup({ enabled: false });
    expect((await app.inject('/api/imports/capabilities')).json()).toEqual({
      enabled: false,
      readonly: false,
    });
    expect((await app.inject('/api/imports')).statusCode).toBe(404);
  });

  it('uploads, lists, renames and deletes an import', async () => {
    await setup();
    const created = await upload();
    expect(created.statusCode).toBe(201);
    const { manifest } = created.json();
    expect(manifest.name).toBe('My session');

    const list = (await app.inject('/api/imports')).json();
    expect(list).toHaveLength(1);
    expect(list[0].manifest.id).toBe(manifest.id);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/imports/${manifest.id}`,
      payload: { name: 'Renamed' },
      headers: WRITE_HEADERS,
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe('Renamed');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/imports/${manifest.id}`,
      headers: WRITE_HEADERS,
    });
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject('/api/imports')).json()).toEqual([]);
  });

  it('leaves no upload leftovers and ignores the client filename', async () => {
    await setup();
    await upload();
    const entries = fs.readdirSync(root);
    expect(entries.filter((e) => e.startsWith('.'))).toEqual([]);
    expect(fs.existsSync(path.join(root, '..', '..', 'evil.zip'))).toBe(false);
  });

  it('returns all validation errors for a bad archive and stores nothing', async () => {
    await setup();
    const form = multipart(
      { type: 'eval-run', name: 'bad' },
      { name: 'x.zip', data: sessionZip() }
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports',
      payload: form.body,
      headers: form.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.length).toBeGreaterThan(0);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('rejects a missing file and an invalid name', async () => {
    await setup();
    const noFile = multipart({ type: 'session', name: 'x' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports',
      payload: noFile.body,
      headers: noFile.headers,
    });
    expect(res.statusCode).toBe(400);
    expect((await upload({}, '   ')).statusCode).toBe(400);
  });

  it('rejects write requests without the custom header', async () => {
    await setup();
    const form = multipart({ type: 'session', name: 'x' }, { name: 'a.zip', data: sessionZip() });
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports',
      payload: form.body,
      headers: { 'content-type': form.headers['content-type'] },
    });
    expect(res.statusCode).toBe(403);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('rejects a cross-origin write even with the header', async () => {
    await setup();
    const res = await upload({ origin: 'https://evil.example', host: 'localhost:3456' });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a same-origin write', async () => {
    await setup();
    const res = await upload({ origin: 'http://localhost:3456', host: 'localhost:3456' });
    expect(res.statusCode).toBe(201);
  });

  it('refuses all writes when read-only but still lists', async () => {
    await setup({ readonly: true });
    expect((await upload()).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/imports/${'0'.repeat(8)}-0000-4000-8000-000000000000`,
          headers: WRITE_HEADERS,
        })
      ).statusCode
    ).toBe(403);
    expect((await app.inject('/api/imports')).statusCode).toBe(200);
    expect((await app.inject('/api/imports/capabilities')).json().readonly).toBe(true);
  });

  it('rejects malformed ids and unknown ids', async () => {
    await setup();
    const bad = await app.inject({
      method: 'DELETE',
      url: '/api/imports/not-an-id',
      headers: WRITE_HEADERS,
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/imports/00000000-0000-4000-8000-000000000000',
      headers: WRITE_HEADERS,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('serves the results read model and trace meta of an eval import', async () => {
    const trace = [
      { type: 'system', subtype: 'init', cwd: '/fake' },
      { type: 'assistant', uuid: 'a1', message: { id: 'm', role: 'assistant', content: [] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    const results = {
      schemaVersion: 1,
      partial: false,
      cases: [
        {
          name: 'alpha',
          runsPerCase: 1,
          promptMarkdown: 'Fake prompt',
          arms: { with: [{ error: null, score: 1 }] },
        },
      ],
    };
    const zip = buildZip([
      { name: 'results.json', data: JSON.stringify(results) },
      { name: 'traces/alpha/with-1.jsonl', data: `${trace}\n` },
    ]);
    const service = new ImportService(root);
    app = Fastify();
    registerImportRoutes(app, {
      service,
      source: new ImportSessionSource(service),
      readonly: false,
    });
    await app.ready();
    const { body, headers } = multipart(
      { type: 'eval-run', name: 'Run' },
      { name: 'run.zip', data: zip }
    );
    const created = await app.inject({
      method: 'POST',
      url: '/api/imports',
      payload: body,
      headers,
    });
    const id = created.json().manifest.id as string;

    const view = await app.inject(`/api/imports/${id}/results`);
    expect(view.statusCode).toBe(200);
    expect(view.json().cases[0]).toMatchObject({ name: 'alpha', arms: { with: [{ score: 1 }] } });

    const meta = await app.inject(`/api/imports/${id}/traces/t001/meta`);
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toMatchObject({ hasInit: true, hasResult: false });

    expect((await app.inject(`/api/imports/${id}/traces/t999/meta`)).statusCode).toBe(404);
    expect((await app.inject(`/api/imports/${id}/traces/..%2Fx/meta`)).statusCode).toBe(400);
    expect((await app.inject('/api/imports/not-an-id/results')).statusCode).toBe(400);
  });
});
