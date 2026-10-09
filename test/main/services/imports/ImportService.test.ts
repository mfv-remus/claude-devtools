import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImportService } from '../../../../src/main/services/imports/ImportService';
import {
  parseManifest,
  validateImportName,
} from '../../../../src/main/services/imports/ImportManifest';

import type { ImportFields } from '../../../../src/main/services/imports/ImportService';

// All data is fake. Session id below is an invented UUID.
const SESSION_ID = '0c28b55a-823d-41df-90ea-3ac39db23ce7';

const SESSION_FIELDS: ImportFields = {
  name: 'Colleague session',
  type: 'session',
  summary: '1 session + 1 subagent',
  sessionId: SESSION_ID,
  subagentCount: 1,
};

const EVAL_FIELDS: ImportFields = {
  name: 'Eval run',
  type: 'eval-run',
  summary: '1 case × 2 arms × 1 run',
  claudeVersion: '9.9.9',
  schemaVersion: 1,
  traces: [
    { id: 't001', file: 'traces/alpha/with-1.jsonl', caseName: 'alpha', arm: 'with', run: 1 },
    { id: 't002', file: 'traces/alpha/without-1.jsonl', caseName: 'alpha', arm: 'without', run: 1 },
  ],
};

describe('ImportService', () => {
  let tmp: string;
  let root: string;
  let service: ImportService;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imports-test-'));
    root = path.join(tmp, 'imports');
    service = new ImportService(root);
    await service.init();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function createSession(fields: ImportFields = SESSION_FIELDS) {
    const staged = await service.createStaging();
    fs.writeFileSync(path.join(staged.dir, `${SESSION_ID}.jsonl`), '{"type":"user"}\n');
    fs.mkdirSync(path.join(staged.dir, SESSION_ID, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(staged.dir, SESSION_ID, 'subagents', 'agent-a.jsonl'), '{}\n');
    const result = await service.commit(staged, fields);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  async function createEval() {
    const staged = await service.createStaging();
    fs.mkdirSync(path.join(staged.dir, 'traces', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(staged.dir, 'results.json'), '{}');
    fs.writeFileSync(path.join(staged.dir, 'traces', 'alpha', 'with-1.jsonl'), '{}\n');
    fs.writeFileSync(path.join(staged.dir, 'traces', 'alpha', 'without-1.jsonl'), '{}\n');
    const result = await service.commit(staged, EVAL_FIELDS);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  describe('create', () => {
    it('keeps staging invisible until commit, then lists the import', async () => {
      const staged = await service.createStaging();
      expect(await service.list()).toEqual([]);

      const result = await service.commit(staged, SESSION_FIELDS);
      expect(result.ok).toBe(true);
      const list = await service.list();
      expect(list).toHaveLength(1);
      expect(list[0].valid && list[0].manifest.name).toBe('Colleague session');
      expect(fs.existsSync(staged.dir)).toBe(false);
    });

    it('assigns a server-side id and timestamp, ignoring any supplied ones', async () => {
      const staged = await service.createStaging();
      const sneaky = { ...SESSION_FIELDS, id: '../../x', createdAt: 'yesterday' } as ImportFields;
      const result = await service.commit(staged, sneaky);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe(staged.id);
      expect(Number.isNaN(Date.parse(result.value.createdAt))).toBe(false);
      expect(fs.existsSync(path.join(root, staged.id, 'manifest.json'))).toBe(true);
    });

    it('trims the name and rejects an invalid one, discarding staging', async () => {
      const ok = await service.commit(await service.createStaging(), {
        ...SESSION_FIELDS,
        name: '  padded  ',
      });
      expect(ok.ok && ok.value.name).toBe('padded');

      const staged = await service.createStaging();
      const bad = await service.commit(staged, { ...SESSION_FIELDS, name: '   ' });
      expect(bad.ok).toBe(false);
      expect(!bad.ok && bad.code).toBe('invalid-name');
      expect(fs.existsSync(staged.dir)).toBe(false);
    });

    it('refuses to commit or discard a directory outside the staging area', async () => {
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(outside);
      const forged = { id: '3f2b8c1e-5a4d-4e6f-8b7a-9c0d1e2f3a4b', dir: outside };
      const result = await service.commit(forged, SESSION_FIELDS);
      expect(result.ok).toBe(false);
      await service.discardStaging(forged);
      expect(fs.existsSync(outside)).toBe(true);

      // The refusal is logged on purpose; test/setup.ts fails on unexpected console.error.
      const errorSpy = vi.mocked(console.error);
      expect(errorSpy).toHaveBeenCalledWith(
        '[Imports:ImportService]',
        'discardStaging refused a path outside the staging area'
      );
      errorSpy.mockClear();
    });

    it('rejects a manifest that fails validation (eval-run without traces)', async () => {
      const staged = await service.createStaging();
      const result = await service.commit(staged, { ...EVAL_FIELDS, traces: undefined });
      expect(result.ok).toBe(false);
      expect(fs.existsSync(staged.dir)).toBe(false);
    });
  });

  describe('list / get', () => {
    it('lists newest first', async () => {
      const first = await createSession();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await createEval();
      const list = await service.list();
      expect(list.map((e) => e.valid && e.manifest.id)).toEqual([second.id, first.id]);
    });

    it('returns an empty list when the root does not exist', async () => {
      const missing = new ImportService(path.join(tmp, 'nope'));
      expect(await missing.list()).toEqual([]);
    });

    it('ignores strays: dotfiles, staging, non-id directories, files, symlinks', async () => {
      await createSession();
      await service.createStaging();
      fs.mkdirSync(path.join(root, 'random-dir'));
      fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
      const target = path.join(tmp, 'elsewhere');
      fs.mkdirSync(target);
      fs.symlinkSync(target, path.join(root, '3f2b8c1e-5a4d-4e6f-8b7a-9c0d1e2f3a4b'));
      const list = await service.list();
      expect(list).toHaveLength(1);
    });

    it('reports a directory with a missing or corrupt manifest as invalid', async () => {
      const noManifest = '11111111-2222-4333-8444-555555555555';
      const corrupt = '66666666-7777-4888-9999-000000000000';
      fs.mkdirSync(path.join(root, noManifest));
      fs.mkdirSync(path.join(root, corrupt));
      fs.writeFileSync(path.join(root, corrupt, 'manifest.json'), '{not json');

      const list = await service.list();
      const byId = new Map(list.map((e) => [e.valid ? e.manifest.id : e.id, e]));
      expect(byId.get(noManifest)).toMatchObject({
        valid: false,
        error: 'manifest.json is missing',
      });
      expect(byId.get(corrupt)).toMatchObject({
        valid: false,
        error: 'manifest.json is unreadable',
      });
    });

    it('treats a manifest whose id differs from its directory as invalid', async () => {
      const created = await createSession();
      const copy = '99999999-8888-4777-8666-555555555555';
      fs.cpSync(path.join(root, created.id), path.join(root, copy), { recursive: true });
      expect(await service.get(copy)).toBeNull();
      const entry = (await service.list()).find((e) => !e.valid);
      expect(entry).toMatchObject({ valid: false, id: copy, error: 'manifest id does not match' });
    });

    it('refuses a manifest that is a symlink or oversized', async () => {
      const created = await createSession();
      const manifestPath = path.join(root, created.id, 'manifest.json');
      const real = path.join(tmp, 'real-manifest.json');
      fs.copyFileSync(manifestPath, real);
      fs.rmSync(manifestPath);
      fs.symlinkSync(real, manifestPath);
      expect(await service.get(created.id)).toBeNull();
    });

    it('get() returns null for bad ids without touching the disk', async () => {
      expect(await service.get('../etc')).toBeNull();
      expect(await service.get('')).toBeNull();
    });
  });

  describe('rename', () => {
    it('updates only the name and persists it', async () => {
      const created = await createEval();
      const result = await service.rename(created.id, '  New name ');
      expect(result.ok && result.value.name).toBe('New name');
      const again = await service.get(created.id);
      expect(again).toMatchObject({
        name: 'New name',
        createdAt: created.createdAt,
        type: 'eval-run',
      });
      expect(fs.readdirSync(path.join(root, created.id)).filter((f) => f.endsWith('.tmp'))).toEqual(
        []
      );
    });

    it('rejects invalid ids, names and unknown imports', async () => {
      const created = await createSession();
      expect(await service.rename('../x', 'a')).toMatchObject({ ok: false, code: 'invalid-id' });
      expect(await service.rename(created.id, '')).toMatchObject({
        ok: false,
        code: 'invalid-name',
      });
      expect(await service.rename(created.id, 'x'.repeat(81))).toMatchObject({
        ok: false,
        code: 'invalid-name',
      });
      expect(await service.rename(created.id, 'a\u0000b')).toMatchObject({
        ok: false,
        code: 'invalid-name',
      });
      expect(await service.rename('3f2b8c1e-5a4d-4e6f-8b7a-9c0d1e2f3a4b', 'ok')).toMatchObject({
        ok: false,
        code: 'not-found',
      });
    });
  });

  describe('delete', () => {
    it('removes the import entirely', async () => {
      const created = await createSession();
      const result = await service.delete(created.id);
      expect(result.ok).toBe(true);
      expect(await service.list()).toEqual([]);
      expect(fs.readdirSync(root)).toEqual([]);
    });

    it('can delete an invalid import', async () => {
      const id = '11111111-2222-4333-8444-555555555555';
      fs.mkdirSync(path.join(root, id));
      expect((await service.delete(id)).ok).toBe(true);
      expect(fs.existsSync(path.join(root, id))).toBe(false);
    });

    it('reports unknown and malformed ids; never follows a symlink', async () => {
      expect(await service.delete('../x')).toMatchObject({ ok: false, code: 'invalid-id' });
      expect(await service.delete('3f2b8c1e-5a4d-4e6f-8b7a-9c0d1e2f3a4b')).toMatchObject({
        ok: false,
        code: 'not-found',
      });

      const victim = path.join(tmp, 'victim');
      fs.mkdirSync(victim);
      fs.writeFileSync(path.join(victim, 'keep.txt'), 'x');
      const id = '3f2b8c1e-5a4d-4e6f-8b7a-9c0d1e2f3a4b';
      fs.symlinkSync(victim, path.join(root, id));
      expect(await service.delete(id)).toMatchObject({ ok: false, code: 'not-found' });
      expect(fs.existsSync(path.join(victim, 'keep.txt'))).toBe(true);
    });
  });

  describe('cleanupLeftovers', () => {
    it('removes staging and trash directories only', async () => {
      const created = await createSession();
      await service.createStaging();
      fs.mkdirSync(path.join(root, '.trash-abc'));
      fs.mkdirSync(path.join(root, 'unrelated'));
      expect(await service.cleanupLeftovers()).toBe(2);
      expect(fs.readdirSync(root).sort()).toEqual([created.id, 'unrelated'].sort());
    });
  });

  describe('path resolution', () => {
    it('resolves a session file and its subagents directory', async () => {
      const created = await createSession();
      const file = await service.resolveSessionFile(created.id, SESSION_ID);
      expect(file).toBe(path.join(root, created.id, `${SESSION_ID}.jsonl`));
      const dir = await service.resolveSubagentsDir(created.id, SESSION_ID);
      expect(dir).toBe(path.join(root, created.id, SESSION_ID, 'subagents'));
    });

    it('resolves eval traces by opaque id only', async () => {
      const created = await createEval();
      expect(await service.resolveSessionFile(created.id, 't002')).toBe(
        path.join(root, created.id, 'traces', 'alpha', 'without-1.jsonl')
      );
      expect(await service.resolveSessionFile(created.id, 't999')).toBeNull();
      expect(await service.resolveSessionFile(created.id, 'alpha')).toBeNull();
      expect(await service.resolveSessionFile(created.id, '../results.json')).toBeNull();
      expect(await service.resolveSubagentsDir(created.id, 't001')).toBeNull();
    });

    it('rejects a wrong session id and unknown imports', async () => {
      const created = await createSession();
      expect(await service.resolveSessionFile(created.id, 'other')).toBeNull();
      expect(
        await service.resolveSessionFile('3f2b8c1e-5a4d-4e6f-8b7a-9c0d1e2f3a4b', SESSION_ID)
      ).toBeNull();
    });

    it('returns null when the file is missing', async () => {
      const created = await createEval();
      fs.rmSync(path.join(root, created.id, 'traces', 'alpha', 'with-1.jsonl'));
      expect(await service.resolveSessionFile(created.id, 't001')).toBeNull();
    });

    it('returns null when a file was replaced by a symlink leaving the import', async () => {
      const created = await createSession();
      const secret = path.join(tmp, 'secret.jsonl');
      fs.writeFileSync(secret, 'secret');
      const file = path.join(root, created.id, `${SESSION_ID}.jsonl`);
      fs.rmSync(file);
      fs.symlinkSync(secret, file);
      expect(await service.resolveSessionFile(created.id, SESSION_ID)).toBeNull();
    });

    it('ignores a hand-edited manifest that points a trace outside the import', async () => {
      const created = await createEval();
      const manifestPath = path.join(root, created.id, 'manifest.json');
      const edited = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      edited.traces[0].file = '../../outside.jsonl';
      fs.writeFileSync(manifestPath, JSON.stringify(edited));
      // The manifest no longer validates, so the whole import is invalid.
      expect(await service.get(created.id)).toBeNull();
      expect(await service.resolveSessionFile(created.id, 't001')).toBeNull();
    });
  });
});

describe('validateImportName', () => {
  it('accepts normal names, including non-ASCII', () => {
    expect(validateImportName('Eval 2026-10-08 · mf-sast')).toEqual({
      valid: true,
      value: 'Eval 2026-10-08 · mf-sast',
    });
    expect(validateImportName('日本語の名前')).toMatchObject({ valid: true });
  });

  it.each([[undefined], [null], [5], [''], ['  '], ['x'.repeat(81)], ['a\nb']])(
    'rejects %j',
    (value) => {
      expect(validateImportName(value).valid).toBe(false);
    }
  );
});

describe('parseManifest', () => {
  const ID = '3f2b8c1e-5a4d-4e6f-8b7a-9c0d1e2f3a4b';
  const base = {
    id: ID,
    name: 'n',
    type: 'session',
    createdAt: '2026-10-08T00:00:00.000Z',
    summary: 's',
    sessionId: SESSION_ID,
  };

  it('accepts a valid session manifest', () => {
    expect(parseManifest(base, ID)).toMatchObject({ valid: true });
  });

  it.each([
    ['not an object', 'x'],
    ['array', []],
    ['wrong id', { ...base, id: '11111111-2222-4333-8444-555555555555' }],
    ['unknown type', { ...base, type: 'other' }],
    ['bad date', { ...base, createdAt: 'soon' }],
    ['non-uuid session id', { ...base, sessionId: '../x' }],
    ['summary too long', { ...base, summary: 'x'.repeat(301) }],
  ])('rejects %s', (_label, raw) => {
    expect(parseManifest(raw, ID).valid).toBe(false);
  });

  it('rejects malformed eval traces', () => {
    const evalBase = { ...base, type: 'eval-run', sessionId: undefined };
    const trace = EVAL_FIELDS.traces![0];
    expect(parseManifest({ ...evalBase, traces: [trace] }, ID).valid).toBe(true);
    for (const bad of [
      { ...trace, id: 'alpha' },
      { ...trace, file: '../x.jsonl' },
      { ...trace, file: '/abs.jsonl' },
      { ...trace, arm: 'both' },
      { ...trace, run: 0 },
      { ...trace, run: 1.5 },
      { ...trace, caseName: '' },
    ]) {
      expect(parseManifest({ ...evalBase, traces: [bad] }, ID).valid).toBe(false);
    }
    expect(parseManifest({ ...evalBase, traces: [trace, trace] }, ID).valid).toBe(false);
    expect(parseManifest({ ...evalBase, traces: 'x' }, ID).valid).toBe(false);
  });
});
