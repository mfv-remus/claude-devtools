import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ARCHIVE_LIMITS } from '../../../../src/main/services/imports/archivePolicy';
import { importFromZip } from '../../../../src/main/services/imports/importFromZip';
import { ImportService } from '../../../../src/main/services/imports/ImportService';

import { buildZip, type FakeZipEntry } from './zipFixture';

// All content is invented. The session id is a made-up UUID.
const SESSION_ID = '0c28b55a-823d-41df-90ea-3ac39db23ce7';

function results(overrides: Record<string, unknown> = {}) {
  const run = { error: null };
  return {
    schemaVersion: 1,
    claudeVersion: '9.9.9',
    partial: false,
    cases: [
      { name: 'alpha', runsPerCase: 1, arms: { with: [run], without: [run] } },
      { name: 'beta', runsPerCase: 1, arms: { with: [run], without: [run] } },
    ],
    ...overrides,
  };
}

function evalEntries(extra: FakeZipEntry[] = []): FakeZipEntry[] {
  const traces = ['alpha', 'beta'].flatMap((c) =>
    ['with', 'without'].map((arm) => ({
      name: `traces/${c}/${arm}-1.jsonl`,
      data: '{"type":"x"}\n',
    }))
  );
  return [{ name: 'results.json', data: JSON.stringify(results()) }, ...traces, ...extra];
}

describe('importFromZip', () => {
  let tmp: string;
  let root: string;
  let service: ImportService;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-zip-test-'));
    root = path.join(tmp, 'imports');
    service = new ImportService(root);
    await service.init();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function zip(entries: FakeZipEntry[]): string {
    const file = path.join(tmp, `upload-${Math.random().toString(36).slice(2)}.zip`);
    fs.writeFileSync(file, buildZip(entries));
    return file;
  }

  const run = (zipPath: string, type: 'eval-run' | 'session' = 'eval-run', limits?: object) =>
    importFromZip(service, {
      zipPath,
      type,
      name: 'My import',
      limits: limits ? { ...DEFAULT_ARCHIVE_LIMITS, ...limits } : undefined,
    });

  /** Nothing may be left behind after a rejected import */
  function expectRootEmpty() {
    expect(fs.readdirSync(root)).toEqual([]);
  }

  describe('eval-run', () => {
    it('imports a complete bundle and extracts only the whitelisted files', async () => {
      const result = await run(
        zip(
          evalEntries([
            { name: 'report.html', data: '<script>x</script>' },
            { name: 'aggregate-result.json', data: '{}' },
          ])
        )
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.manifest).toMatchObject({
        name: 'My import',
        type: 'eval-run',
        summary: '2 cases × 2 arms × 1 run',
        claudeVersion: '9.9.9',
        schemaVersion: 1,
      });
      expect(result.manifest.traces).toHaveLength(4);
      expect(result.ignored.sort()).toEqual(['aggregate-result.json', 'report.html']);

      const dir = path.join(root, result.manifest.id);
      expect(fs.readdirSync(dir).sort()).toEqual(['manifest.json', 'results.json', 'traces']);
      const traceFile = await service.resolveSessionFile(result.manifest.id, 't001');
      expect(traceFile && fs.readFileSync(traceFile, 'utf8')).toBe('{"type":"x"}\n');
    });

    it('rejects a missing trace and leaves nothing behind', async () => {
      const entries = evalEntries().filter((e) => e.name !== 'traces/beta/without-1.jsonl');
      const result = await run(zip(entries));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.errors[0]).toContain('Missing trace');
      expectRootEmpty();
    });

    it('rejects results.json that is not JSON, and an unsupported schemaVersion', async () => {
      const bad = await run(zip([{ name: 'results.json', data: '{oops' }]));
      expect(!bad.ok && bad.errors).toEqual(['results.json is not a valid JSON object']);

      const v2 = await run(
        zip([{ name: 'results.json', data: JSON.stringify(results({ schemaVersion: 2 })) }])
      );
      expect(!v2.ok && v2.errors[0]).toContain('Unsupported results.json schemaVersion');
      expectRootEmpty();
    });

    it('accepts a partial suite with missing traces', async () => {
      const data = JSON.stringify(results({ partial: true, partialReason: 'cost_ceiling' }));
      const result = await run(
        zip([
          { name: 'results.json', data },
          { name: 'traces/alpha/with-1.jsonl', data: '{}\n' },
        ])
      );
      expect(result.ok).toBe(true);
      expect(result.ok && result.manifest).toMatchObject({
        partial: true,
        partialReason: 'cost_ceiling',
      });
    });

    it('does not echo case names into paths: a hostile case name is rejected', async () => {
      const hostile = results({
        cases: [{ name: '../../escape', runsPerCase: 1, arms: { with: [{ error: null }] } }],
      });
      const result = await run(zip([{ name: 'results.json', data: JSON.stringify(hostile) }]));
      expect(result.ok).toBe(false);
      expectRootEmpty();
      expect(fs.existsSync(path.join(tmp, 'escape'))).toBe(false);
    });
  });

  describe('session', () => {
    it('imports a session with subagents and skips tool-results', async () => {
      const result = await run(
        zip([
          { name: `${SESSION_ID}.jsonl`, data: '{"type":"user"}\n' },
          { name: `${SESSION_ID}/subagents/agent-a.jsonl`, data: '{}\n' },
          { name: `${SESSION_ID}/tool-results/toolu_1.txt`, data: 'big output' },
        ]),
        'session'
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.manifest).toMatchObject({
        type: 'session',
        sessionId: SESSION_ID,
        subagentCount: 1,
        summary: '1 session + 1 subagent',
      });
      const dir = path.join(root, result.manifest.id);
      expect(fs.existsSync(path.join(dir, SESSION_ID, 'tool-results'))).toBe(false);
      expect(await service.resolveSubagentsDir(result.manifest.id, SESSION_ID)).toBe(
        path.join(dir, SESSION_ID, 'subagents')
      );
    });

    it('rejects an eval bundle submitted as a session, and vice versa', async () => {
      const asSession = await run(zip(evalEntries()), 'session');
      expect(asSession.ok).toBe(false);
      const asEval = await run(zip([{ name: `${SESSION_ID}.jsonl`, data: '{}\n' }]), 'eval-run');
      expect(asEval.ok).toBe(false);
      expectRootEmpty();
    });
  });

  describe('hostile archives', () => {
    it('rejects path traversal and absolute names', async () => {
      for (const name of ['../evil.jsonl', '/etc/evil', 'a/../../evil']) {
        const result = await run(zip([...evalEntries(), { name, data: 'x' }]));
        expect(result.ok).toBe(false);
      }
      expectRootEmpty();
      expect(fs.existsSync(path.join(tmp, 'evil.jsonl'))).toBe(false);
    });

    it('rejects symbolic links', async () => {
      const result = await run(
        zip([...evalEntries(), { name: 'traces/link', data: '/etc/passwd', unixMode: 0o120777 }])
      );
      expect(!result.ok && result.errors.join('\n')).toContain('symbolic link');
      expectRootEmpty();
    });

    it('rejects encrypted entries', async () => {
      const result = await run(
        zip([...evalEntries(), { name: 'secret.bin', data: 'x', encrypted: true }])
      );
      expect(!result.ok && result.errors.join('\n')).toContain('encrypted');
      expectRootEmpty();
    });

    it('rejects a malformed encrypted entry already at open time', async () => {
      const result = await run(
        zip([
          ...evalEntries(),
          { name: 'secret.bin', data: 'x', encrypted: true, malformedEncryption: true },
        ])
      );
      expect(!result.ok && result.errors[0]).toContain('Not a valid zip archive');
      expectRootEmpty();
    });

    it('rejects an entry whose declared size exceeds the per-entry limit (bomb guard)', async () => {
      const result = await run(
        zip([
          ...evalEntries(),
          { name: 'traces/alpha/with-1.jsonl', data: 'x', declaredSize: 5_000_000 },
        ]),
        'eval-run',
        { maxEntryBytes: 1_000_000 }
      );
      expect(result.ok).toBe(false);
      expectRootEmpty();
    });

    it('rejects when the declared total exceeds the limit', async () => {
      const result = await run(zip(evalEntries()), 'eval-run', { maxTotalUncompressedBytes: 10 });
      expect(!result.ok && result.errors.join('\n')).toContain('expands to');
      expectRootEmpty();
    });

    it('rejects an entry whose real size differs from the declared one, discarding staging', async () => {
      const entries = evalEntries().map((e) =>
        e.name === 'traces/alpha/with-1.jsonl' ? { ...e, declaredSize: 3 } : e
      );
      const result = await run(zip(entries));
      expect(result.ok).toBe(false);
      expectRootEmpty();
    });

    it('rejects too many entries and an oversized zip file', async () => {
      const many = await run(zip(evalEntries()), 'eval-run', { maxEntries: 2 });
      expect(!many.ok && many.errors[0]).toContain('entries');

      const big = await run(zip(evalEntries()), 'eval-run', { maxZipBytes: 10 });
      expect(!big.ok && big.errors[0]).toContain('limit is');
      expectRootEmpty();
    });

    it('rejects unsupported compression methods and duplicate names', async () => {
      const method = await run(zip([...evalEntries(), { name: 'x.txt', data: 'x', method: 99 }]));
      expect(method.ok).toBe(false);
      const dupes = await run(zip([...evalEntries(), { name: 'results.json', data: '{}' }]));
      expect(!dupes.ok && dupes.errors.join('\n')).toContain('Duplicate');
      expectRootEmpty();
    });

    it('rejects files that are not zip archives', async () => {
      const junk = path.join(tmp, 'junk.zip');
      fs.writeFileSync(junk, Buffer.from('this is not a zip file at all'));
      const result = await run(junk);
      expect(!result.ok && result.errors[0]).toContain('Not a valid zip archive');
      const empty = path.join(tmp, 'empty.zip');
      fs.writeFileSync(empty, Buffer.alloc(0));
      expect((await run(empty)).ok).toBe(false);
      expectRootEmpty();
    });

    it('never reflects raw control characters from names in errors', async () => {
      const result = await run(zip([{ name: 'bad\u0001name', data: 'x' }]));
      expect(result.ok).toBe(false);
      // eslint-disable-next-line no-control-regex -- asserting their absence
      expect(!result.ok && result.errors.join('')).not.toMatch(/[\u0000-\u001f]/);
    });
  });

  it('rejects an invalid name before touching the archive', async () => {
    const result = await importFromZip(service, {
      zipPath: path.join(tmp, 'does-not-exist.zip'),
      type: 'eval-run',
      name: '  ',
    });
    expect(!result.ok && result.code).toBe('invalid-name');
  });

  it('reports a missing upload file as a failure, not a crash', async () => {
    const result = await run(path.join(tmp, 'does-not-exist.zip'));
    expect(!result.ok && result.code).toBe('io-error');
    expectRootEmpty();

    // An internal failure is logged on purpose; test/setup.ts fails on unexpected console.error.
    const errorSpy = vi.mocked(console.error);
    expect(errorSpy).toHaveBeenCalledWith(
      '[Imports:importFromZip]',
      'Failed to read the archive:',
      expect.any(Error)
    );
    errorSpy.mockClear();
  });
});
