/**
 * importFromZip - turns an uploaded zip into a stored import.
 *
 * Flow (nothing is written under the imports root until every check has passed):
 *   1. name check
 *   2. list entries, apply archive policy (names, symlinks, sizes, counts)
 *   3. type-specific layout validation (eval-run reads results.json from the zip)
 *   4. extract ONLY the whitelisted entries into a staging directory
 *   5. commit: write manifest.json, atomically rename into place
 * Any failure after step 3 discards the staging directory.
 */

import { createLogger } from '@shared/utils/logger';

import {
  type ArchiveLimits,
  DEFAULT_ARCHIVE_LIMITS,
  isDirectoryEntry,
  validateArchiveEntries,
} from './archivePolicy';
import {
  type BundleValidation,
  RESULTS_FILE,
  validateEvalRunBundle,
  validateSessionBundle,
} from './bundleValidators';
import { validateImportName } from './ImportManifest';
import { type ImportFields, type ImportService } from './ImportService';
import { extractZipEntries, listZipEntries, readZipEntryText, ZipError } from './zipArchive';

import type { ImportManifest, ImportType } from '@shared/types/imports';

const logger = createLogger('Imports:importFromZip');

/** results.json of a real suite is under 1 MB; this is generous but bounded. */
const MAX_RESULTS_BYTES = 64 * 1024 * 1024;

export interface ImportFromZipRequest {
  zipPath: string;
  type: ImportType;
  name: string;
  limits?: ArchiveLimits;
}

export type ImportFromZipResult =
  | { ok: true; manifest: ImportManifest; ignored: string[] }
  | { ok: false; code: 'invalid-name' | 'invalid-archive' | 'io-error'; errors: string[] };

const invalid = (errors: string[]): ImportFromZipResult => ({
  ok: false,
  code: 'invalid-archive',
  errors,
});

export async function importFromZip(
  service: ImportService,
  request: ImportFromZipRequest
): Promise<ImportFromZipResult> {
  const limits = request.limits ?? DEFAULT_ARCHIVE_LIMITS;

  const name = validateImportName(request.name);
  if (!name.valid) return { ok: false, code: 'invalid-name', errors: [name.error] };
  if (request.type !== 'eval-run' && request.type !== 'session') {
    return invalid(['Unknown import type']);
  }

  // 2. Entry list + policy
  let fileNames: string[];
  try {
    const entries = await listZipEntries(request.zipPath, limits);
    const policy = validateArchiveEntries(entries, limits);
    if (policy.errors.length > 0) return invalid(policy.errors);
    fileNames = entries.filter((entry) => !isDirectoryEntry(entry)).map((entry) => entry.fileName);
  } catch (error) {
    if (error instanceof ZipError) return invalid([error.message]);
    logger.error('Failed to read the archive:', error);
    return { ok: false, code: 'io-error', errors: ['Failed to read the uploaded file'] };
  }

  // 3. Layout
  let validation: BundleValidation;
  let fields: ImportFields;
  try {
    if (request.type === 'eval-run') {
      const results = await readResults(request.zipPath, fileNames);
      const evalRun = validateEvalRunBundle(fileNames, results);
      validation = evalRun;
      fields = {
        name: name.value,
        type: 'eval-run',
        summary: evalRun.summary,
        claudeVersion: evalRun.claudeVersion,
        schemaVersion: evalRun.schemaVersion,
        partial: evalRun.partial ? true : undefined,
        partialReason: evalRun.partialReason,
        traces: evalRun.traces,
      };
    } else {
      const session = validateSessionBundle(fileNames);
      validation = session;
      fields = {
        name: name.value,
        type: 'session',
        summary: session.summary,
        sessionId: session.sessionId,
        subagentCount: session.subagentCount,
      };
    }
  } catch (error) {
    if (error instanceof ZipError) return invalid([error.message]);
    logger.error('Failed to validate the archive:', error);
    return { ok: false, code: 'io-error', errors: ['Failed to read the uploaded file'] };
  }
  if (validation.errors.length > 0) return invalid(validation.errors);

  // 4 + 5. Extract whitelisted entries, then commit
  const staged = await service.createStaging();
  try {
    await extractZipEntries(request.zipPath, staged.dir, new Set(validation.extract), limits);
  } catch (error) {
    await service.discardStaging(staged);
    if (error instanceof ZipError) return invalid([error.message]);
    logger.error('Extraction failed:', error);
    return { ok: false, code: 'io-error', errors: ['Failed to extract the uploaded file'] };
  }

  const committed = await service.commit(staged, fields);
  if (!committed.ok) {
    return {
      ok: false,
      code: committed.code === 'invalid-name' ? 'invalid-name' : 'io-error',
      errors: [committed.error],
    };
  }
  return { ok: true, manifest: committed.value, ignored: validation.ignored };
}

/** Parsed results.json, or undefined when absent or not valid JSON (the validator reports it). */
async function readResults(zipPath: string, fileNames: readonly string[]): Promise<unknown> {
  if (!fileNames.includes(RESULTS_FILE)) return undefined;
  const text = await readZipEntryText(zipPath, RESULTS_FILE, MAX_RESULTS_BYTES);
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
