import { afterEach, describe, expect, it } from 'vitest';

import { subprojectRegistry } from '../../../../src/main/services/discovery/SubprojectRegistry';

describe('SubprojectRegistry', () => {
  afterEach(() => {
    subprojectRegistry.clear();
  });

  it('uses the last path segment of cwd as the composite ID suffix', () => {
    const id = subprojectRegistry.register('-Users-name-project', '/Users/name/project/apps/foo', [
      'session-1',
    ]);

    expect(id).toBe('-Users-name-project~foo');
    expect(subprojectRegistry.getBaseDir(id)).toBe('-Users-name-project');
    expect(subprojectRegistry.getCwd(id)).toBe('/Users/name/project/apps/foo');
  });

  it('sanitizes characters outside the URL-safe set', () => {
    const id = subprojectRegistry.register('-Users-name-project', '/Users/name/project/a b!@c', [
      'session-1',
    ]);

    expect(id).toBe('-Users-name-project~a-b-c');
  });

  it('falls back to a content hash when two different cwds sanitize to the same suffix', () => {
    const firstId = subprojectRegistry.register('-Users-name-project', '/Users/name/project/foo', [
      'session-1',
    ]);
    const secondId = subprojectRegistry.register('-Users-name-project', '/Users/name/other/foo', [
      'session-2',
    ]);

    expect(firstId).toBe('-Users-name-project~foo');
    expect(secondId).not.toBe(firstId);
    expect(secondId).toMatch(/^-Users-name-project~foo-[a-f0-9]{8}$/);
    expect(subprojectRegistry.getCwd(firstId)).toBe('/Users/name/project/foo');
    expect(subprojectRegistry.getCwd(secondId)).toBe('/Users/name/other/foo');
  });

  it('reuses the same composite ID when the same cwd is registered again', () => {
    const firstId = subprojectRegistry.register('-Users-name-project', '/Users/name/project/foo', [
      'session-1',
    ]);
    const secondId = subprojectRegistry.register('-Users-name-project', '/Users/name/project/foo', [
      'session-2',
    ]);

    expect(secondId).toBe(firstId);
  });

  it('uses a suffixHint instead of the cwd basename when provided', () => {
    const id = subprojectRegistry.register(
      '-Users-name-project',
      '/Users/name/project',
      ['session-1'],
      'root'
    );

    expect(id).toBe('-Users-name-project~root');
  });

  it('isComposite distinguishes composite IDs from plain encoded paths', () => {
    expect(subprojectRegistry.isComposite('-Users-name-project')).toBe(false);
    expect(subprojectRegistry.isComposite('-Users-name-project~foo')).toBe(true);
  });
});
