import { describe, expect, it } from 'vitest';

import {
  buildImportProjectId,
  formatEvalTraceId,
  generateImportId,
  isEvalTraceId,
  isImportId,
  isImportProjectId,
  parseImportProjectId,
} from '../../../../src/main/services/imports/importIds';

const VALID_ID = '3f2b8c1e-5a4d-4e6f-8b7a-9c0d1e2f3a4b';

describe('import ids', () => {
  it('generates ids that pass its own guard', () => {
    for (let i = 0; i < 20; i++) {
      expect(isImportId(generateImportId())).toBe(true);
    }
  });

  it('accepts only lowercase UUID v4', () => {
    expect(isImportId(VALID_ID)).toBe(true);
    expect(isImportId(VALID_ID.toUpperCase())).toBe(false);
    expect(isImportId('3f2b8c1e-5a4d-1e6f-8b7a-9c0d1e2f3a4b')).toBe(false); // version 1
    expect(isImportId(`${VALID_ID}/..`)).toBe(false);
    expect(isImportId(`../${VALID_ID}`)).toBe(false);
    expect(isImportId('')).toBe(false);
    expect(isImportId(undefined)).toBe(false);
    expect(isImportId(42)).toBe(false);
  });

  it('builds and parses project ids', () => {
    const projectId = buildImportProjectId(VALID_ID);
    expect(projectId).toBe(`import:${VALID_ID}`);
    expect(isImportProjectId(projectId)).toBe(true);
    expect(parseImportProjectId(projectId)).toBe(VALID_ID);
  });

  it('refuses to build a project id from a bad import id', () => {
    expect(() => buildImportProjectId('../etc')).toThrow();
  });

  it('does not treat real project ids or tricks as imports', () => {
    expect(isImportProjectId('-Users-name-project')).toBe(false);
    expect(isImportProjectId('import:')).toBe(false);
    expect(isImportProjectId('import:../..')).toBe(false);
    expect(isImportProjectId(`import:${VALID_ID}~x`)).toBe(false);
    expect(isImportProjectId(`xximport:${VALID_ID}`)).toBe(false);
    expect(isImportProjectId(` import:${VALID_ID}`)).toBe(false);
    expect(parseImportProjectId('-Users-name-project')).toBeNull();
  });

  it('formats and recognises eval trace ids', () => {
    expect(formatEvalTraceId(0)).toBe('t001');
    expect(formatEvalTraceId(41)).toBe('t042');
    expect(formatEvalTraceId(1234)).toBe('t1235');
    expect(isEvalTraceId('t001')).toBe(true);
    expect(isEvalTraceId('t1235')).toBe(true);
    expect(isEvalTraceId('t01')).toBe(false);
    expect(isEvalTraceId('t001/../x')).toBe(false);
    expect(isEvalTraceId('T001')).toBe(false);
    expect(isEvalTraceId('abc')).toBe(false);
  });
});
