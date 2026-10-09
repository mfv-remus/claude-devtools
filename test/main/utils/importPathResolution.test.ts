import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateProjectId } from '../../../src/main/ipc/guards';
import { importFromZip } from '../../../src/main/services/imports/importFromZip';
import { ImportService } from '../../../src/main/services/imports/ImportService';
import {
  buildSessionPath,
  buildSubagentsPath,
  setImportPathResolver,
} from '../../../src/main/utils/pathDecoder';
import { buildZip } from '../services/imports/zipFixture';

// All content is invented.
const SESSION_ID = '0c28b55a-823d-41df-90ea-3ac39db23ce7';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const PROJECTS = '/base/projects';

describe('import path resolution', () => {
  let root: string;
  let service: ImportService;
  let importId: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-paths-'));
    service = new ImportService(root);
    setImportPathResolver({
      root: service.getRoot(),
      sessionFile: (id, sid) => service.resolveSessionFileSync(id, sid),
      subagentsDir: (id, sid) => service.resolveSubagentsDirSync(id, sid),
    });
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } });
    const zipPath = path.join(root, 'in.zip');
    fs.writeFileSync(
      zipPath,
      buildZip([
        { name: `${SESSION_ID}.jsonl`, data: `${line}\n` },
        { name: `${SESSION_ID}/subagents/agent-a1.jsonl`, data: `${line}\n` },
      ])
    );
    const result = await importFromZip(service, { zipPath, type: 'session', name: 'x' });
    if (!result.ok) throw new Error(result.errors.join(', '));
    importId = result.manifest.id;
  });

  afterEach(() => {
    setImportPathResolver(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves session and subagents paths inside the imports root, not projectsDir', () => {
    const file = buildSessionPath(PROJECTS, `import:${importId}`, SESSION_ID);
    expect(file).toBe(path.join(root, importId, `${SESSION_ID}.jsonl`));
    expect(fs.existsSync(file)).toBe(true);
    expect(buildSubagentsPath(PROJECTS, `import:${importId}`, SESSION_ID)).toBe(
      path.join(root, importId, SESSION_ID, 'subagents')
    );
  });

  it('maps unknown imports, sessions and path-like session ids to a path that does not exist', () => {
    const cases = [
      buildSessionPath(PROJECTS, `import:${MISSING_ID}`, SESSION_ID),
      buildSessionPath(PROJECTS, `import:${importId}`, 'other-session'),
      buildSessionPath(PROJECTS, `import:${importId}`, '../../etc/passwd'),
      buildSubagentsPath(PROJECTS, `import:${importId}`, 'other-session'),
    ];
    for (const result of cases) {
      expect(result.startsWith(path.join(root, '.unresolved-import'))).toBe(true);
      expect(fs.existsSync(result)).toBe(false);
    }
  });

  it('refuses a resolver that returns a path outside the root', () => {
    setImportPathResolver({
      root: service.getRoot(),
      sessionFile: () => '/etc/passwd',
      subagentsDir: () => null,
    });
    expect(buildSessionPath(PROJECTS, `import:${importId}`, SESSION_ID)).not.toBe('/etc/passwd');
  });

  it('does not resolve through a symlink that escapes the import', () => {
    const outside = path.join(root, 'outside.jsonl');
    fs.writeFileSync(outside, '{}\n');
    const link = path.join(root, importId, `${SESSION_ID}.jsonl`);
    fs.rmSync(link);
    fs.symlinkSync(outside, link);
    const result = buildSessionPath(PROJECTS, `import:${importId}`, SESSION_ID);
    expect(result).not.toBe(link);
    expect(fs.existsSync(result)).toBe(false);
  });

  it('throws when imports are not enabled', () => {
    setImportPathResolver(null);
    expect(() => buildSessionPath(PROJECTS, `import:${importId}`, SESSION_ID)).toThrow(
      /not enabled/
    );
  });

  it('leaves regular project paths unchanged', () => {
    expect(buildSessionPath(PROJECTS, '-Users-name-proj', 'abc')).toBe(
      path.join(PROJECTS, '-Users-name-proj', 'abc.jsonl')
    );
  });
});

describe('validateProjectId for imports', () => {
  it('accepts only the strict import form', () => {
    expect(validateProjectId(`import:${MISSING_ID}`).valid).toBe(true);
    for (const bad of [
      'import:',
      'import:../x',
      'import:not-a-uuid',
      `import:${MISSING_ID}/..`,
      `import:${SESSION_ID.replace(/^.{8}/, 'ABCDEF01').slice(0, 14)}4${SESSION_ID.slice(15).toUpperCase()}`,
      `import:${MISSING_ID}~x`,
      `Import:${MISSING_ID}`,
    ]) {
      expect(validateProjectId(bad).valid, bad).toBe(false);
    }
  });

  it('still accepts normal encoded paths', () => {
    expect(validateProjectId('-Users-name-proj').valid).toBe(true);
  });
});
