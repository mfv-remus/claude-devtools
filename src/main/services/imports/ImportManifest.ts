/**
 * Validation of import names and manifest.json content.
 *
 * manifest.json is written by the server, but the imports directory is a user-visible
 * bind mount, so a manifest read from disk is treated as untrusted input: every field
 * is checked and the id must match the directory it was found in.
 */

import { IMPORT_MAX_NAME_LENGTH } from '@shared/types/imports';

import { checkEntryName, hasControlCharacters } from './archivePolicy';
import { isEvalTraceId, isImportId } from './importIds';

import type { EvalArm, ImportManifest, ImportTraceRef, ImportType } from '@shared/types/imports';

const MAX_IMPORT_NAME_LENGTH = IMPORT_MAX_NAME_LENGTH;
const MAX_SUMMARY_LENGTH = 300;
const MAX_TRACES = 5000;
const MAX_CASE_NAME_LENGTH = 200;
const IMPORT_TYPES: readonly ImportType[] = ['eval-run', 'session'];
const EVAL_ARMS: readonly EvalArm[] = ['with', 'without'];
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NameResult = { valid: true; value: string } | { valid: false; error: string };

export function validateImportName(name: unknown): NameResult {
  if (typeof name !== 'string') {
    return { valid: false, error: 'name must be a string' };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'name cannot be empty' };
  }
  if (trimmed.length > MAX_IMPORT_NAME_LENGTH) {
    return { valid: false, error: `name exceeds ${MAX_IMPORT_NAME_LENGTH} characters` };
  }
  if (hasControlCharacters(trimmed)) {
    return { valid: false, error: 'name contains control characters' };
  }
  return { valid: true, value: trimmed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTraceRef(raw: unknown): ImportTraceRef | null {
  if (!isRecord(raw)) return null;
  const { id, file, caseName, arm, run } = raw;
  if (!isEvalTraceId(id)) return null;
  if (typeof file !== 'string' || checkEntryName(file, 600) !== null || file.endsWith('/')) {
    return null;
  }
  if (typeof caseName !== 'string' || caseName.length === 0) return null;
  if (caseName.length > MAX_CASE_NAME_LENGTH || hasControlCharacters(caseName)) return null;
  if (!EVAL_ARMS.includes(arm as EvalArm)) return null;
  if (typeof run !== 'number' || !Number.isInteger(run) || run < 1) return null;
  return { id, file, caseName, arm: arm as EvalArm, run };
}

function parseTraces(raw: unknown): ImportTraceRef[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_TRACES) return null;
  const traces: ImportTraceRef[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    const trace = parseTraceRef(item);
    if (!trace || ids.has(trace.id)) return null;
    ids.add(trace.id);
    traces.push(trace);
  }
  return traces;
}

export type ManifestResult =
  | { valid: true; manifest: ImportManifest }
  | { valid: false; error: string };

/**
 * Parses and validates a manifest. `expectedId` is the directory name the manifest was
 * found in; a mismatch means the directory was copied or edited by hand.
 */
export function parseManifest(raw: unknown, expectedId: string): ManifestResult {
  const fail = (error: string): ManifestResult => ({ valid: false, error });

  if (!isRecord(raw)) return fail('manifest is not a JSON object');
  if (!isImportId(raw.id) || raw.id !== expectedId) return fail('manifest id does not match');

  const name = validateImportName(raw.name);
  if (!name.valid) return fail(name.error);

  if (!IMPORT_TYPES.includes(raw.type as ImportType)) return fail('unknown import type');
  const type = raw.type as ImportType;

  if (typeof raw.createdAt !== 'string' || Number.isNaN(Date.parse(raw.createdAt))) {
    return fail('createdAt is not a valid date');
  }
  if (typeof raw.summary !== 'string' || raw.summary.length > MAX_SUMMARY_LENGTH) {
    return fail('summary is missing or too long');
  }

  const manifest: ImportManifest = {
    id: raw.id,
    name: name.value,
    type,
    createdAt: raw.createdAt,
    summary: raw.summary,
  };

  if (type === 'eval-run') {
    const traces = parseTraces(raw.traces);
    if (!traces) return fail('traces are missing or malformed');
    manifest.traces = traces;
    if (typeof raw.claudeVersion === 'string') manifest.claudeVersion = raw.claudeVersion;
    if (typeof raw.schemaVersion === 'number') manifest.schemaVersion = raw.schemaVersion;
    if (raw.partial === true) manifest.partial = true;
    if (typeof raw.partialReason === 'string') manifest.partialReason = raw.partialReason;
    return { valid: true, manifest };
  }

  if (typeof raw.sessionId !== 'string' || !SESSION_ID_PATTERN.test(raw.sessionId)) {
    return fail('sessionId is missing or not a UUID');
  }
  manifest.sessionId = raw.sessionId;
  if (typeof raw.subagentCount === 'number' && Number.isInteger(raw.subagentCount)) {
    manifest.subagentCount = raw.subagentCount;
  }
  return { valid: true, manifest };
}
