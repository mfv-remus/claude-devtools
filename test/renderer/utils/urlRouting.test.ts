import { describe, expect, it } from 'vitest';

import {
  buildProjectPath,
  buildSessionPath,
  parseUrlPath,
} from '../../../src/renderer/utils/urlRouting';

const IMPORT_PROJECT = 'import:00000000-0000-4000-8000-000000000000';

describe('urlRouting with import project ids', () => {
  it('round-trips the overview path', () => {
    const path = buildProjectPath(IMPORT_PROJECT);
    expect(path).toBe('/import_00000000-0000-4000-8000-000000000000');
    expect(parseUrlPath(path)).toEqual({ projectId: IMPORT_PROJECT });
  });

  it('round-trips a trace path', () => {
    const path = buildSessionPath(IMPORT_PROJECT, 't001');
    expect(path).toBe('/import_00000000-0000-4000-8000-000000000000/t001');
    expect(parseUrlPath(path)).toEqual({ projectId: IMPORT_PROJECT, sessionId: 't001' });
  });

  it('still parses links written with an escaped colon', () => {
    expect(parseUrlPath('/import%3A00000000-0000-4000-8000-000000000000/t001')).toEqual({
      projectId: IMPORT_PROJECT,
      sessionId: 't001',
    });
  });

  it('parses the underscore form back to the import project id', () => {
    expect(parseUrlPath('/import_00000000-0000-4000-8000-000000000000/t001')).toEqual({
      projectId: IMPORT_PROJECT,
      sessionId: 't001',
    });
  });

  it('does not treat import_ followed by a non-uuid as an import', () => {
    expect(parseUrlPath('/import_notauuid')).toEqual({ projectId: 'import_notauuid' });
  });

  it('keeps other reserved characters escaped', () => {
    expect(buildSessionPath('-Users-name-project', 'a/b c')).toBe('/-Users-name-project/a%2Fb%20c');
  });

  it('also parses an unescaped colon', () => {
    expect(parseUrlPath(`/${IMPORT_PROJECT}/t002`)).toEqual({
      projectId: IMPORT_PROJECT,
      sessionId: 't002',
    });
  });
});
