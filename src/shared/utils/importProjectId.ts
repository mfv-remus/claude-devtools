/**
 * Import project ids, shared by main and renderer.
 *
 * An import is addressed as `import:<uuid>` (uuid = lowercase v4, server-generated).
 * This is the single definition of what counts as an import; every process gates on
 * `isImportProjectId()` instead of matching the prefix itself.
 */

export const IMPORT_PROJECT_PREFIX = 'import:';

const IMPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isImportId(value: unknown): value is string {
  return typeof value === 'string' && IMPORT_ID_PATTERN.test(value);
}

export function isImportProjectId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(IMPORT_PROJECT_PREFIX) &&
    isImportId(value.slice(IMPORT_PROJECT_PREFIX.length))
  );
}

/** Returns the import id for an `import:<uuid>` project id, or null if it is not one. */
export function parseImportProjectId(value: unknown): string | null {
  return isImportProjectId(value) ? value.slice(IMPORT_PROJECT_PREFIX.length) : null;
}
