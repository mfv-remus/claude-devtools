/**
 * ImportService - storage for imported eval runs and sessions under IMPORTS_ROOT.
 *
 * Layout:
 *   <root>/<importId>/manifest.json   (+ the extracted bundle files)
 *   <root>/.staging-<uuid>/           (being written; invisible to list())
 *   <root>/.trash-<uuid>/             (being deleted; removed right after)
 *
 * Transport-agnostic: no HTTP, no IPC. The extractor writes into a staging directory,
 * then `commit()` writes the manifest and renames the directory into place, so a crash
 * never leaves a half-written import visible. Imports are immutable except for rename.
 *
 * Paths are only ever built from ids that matched `isImportId()` and from file names
 * recorded in the manifest, and are re-checked to stay inside the root (including after
 * resolving symlinks).
 */

import { createLogger } from '@shared/utils/logger';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { buildEvalResultsView } from './evalResultsView';
import { generateImportId, isEvalTraceId, isImportId } from './importIds';
import { parseManifest, validateImportName } from './ImportManifest';

import type {
  EvalResultsView,
  ImportListEntry,
  ImportManifest,
  ImportTraceRef,
} from '@shared/types/imports';

const logger = createLogger('Imports:ImportService');

const MANIFEST_FILE = 'manifest.json';
const STAGING_PREFIX = '.staging-';
const TRASH_PREFIX = '.trash-';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS_BYTES = 64 * 1024 * 1024;

export interface StagedImport {
  id: string;
  /** Absolute path of the staging directory the extractor writes into */
  dir: string;
}

export type ImportFields = Omit<ImportManifest, 'id' | 'createdAt'>;

export type { ImportListEntry };

export type ImportOpResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; code: 'invalid-id' | 'invalid-name' | 'not-found' | 'io-error'; error: string };

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export class ImportService {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  getRoot(): string {
    return this.root;
  }

  /** Creates the root directory if needed. Call once at startup. */
  async init(): Promise<void> {
    await fs.promises.mkdir(this.root, { recursive: true });
  }

  /**
   * Removes staging/trash directories left by a crash. Safe at startup only (no upload
   * in flight yet); anything else under the root is untouched.
   */
  async cleanupLeftovers(): Promise<number> {
    let removed = 0;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (!isNotFound(error)) logger.error('cleanupLeftovers failed to read root:', error);
      return 0;
    }
    for (const entry of entries) {
      const isLeftover =
        entry.name.startsWith(STAGING_PREFIX) || entry.name.startsWith(TRASH_PREFIX);
      if (!entry.isDirectory() || !isLeftover) continue;
      try {
        await fs.promises.rm(path.join(this.root, entry.name), { recursive: true, force: true });
        removed++;
      } catch (error) {
        logger.error(`Failed to remove leftover ${entry.name}:`, error);
      }
    }
    return removed;
  }

  // ===========================================================================
  // Create
  // ===========================================================================

  async createStaging(): Promise<StagedImport> {
    await this.init();
    const id = generateImportId();
    const dir = path.join(this.root, `${STAGING_PREFIX}${randomUUID()}`);
    await fs.promises.mkdir(dir, { mode: 0o755 });
    return { id, dir };
  }

  async discardStaging(staged: StagedImport): Promise<void> {
    if (!this.isStagingDir(staged.dir)) {
      logger.error('discardStaging refused a path outside the staging area');
      return;
    }
    await fs.promises.rm(staged.dir, { recursive: true, force: true }).catch((error) => {
      logger.error('discardStaging failed:', error);
    });
  }

  /**
   * Writes manifest.json into the staging directory and renames it to <root>/<id>.
   * On failure the staging directory is removed.
   */
  async commit(
    staged: StagedImport,
    fields: ImportFields
  ): Promise<ImportOpResult<ImportManifest>> {
    if (!this.isStagingDir(staged.dir) || !isImportId(staged.id)) {
      return { ok: false, code: 'invalid-id', error: 'Invalid staging directory' };
    }
    const name = validateImportName(fields.name);
    if (!name.valid) {
      await this.discardStaging(staged);
      return { ok: false, code: 'invalid-name', error: name.error };
    }

    const candidate = {
      ...fields,
      name: name.value,
      id: staged.id,
      createdAt: new Date().toISOString(),
    };
    const parsed = parseManifest(candidate, staged.id);
    if (!parsed.valid) {
      await this.discardStaging(staged);
      return { ok: false, code: 'io-error', error: `Invalid manifest: ${parsed.error}` };
    }

    try {
      await this.writeManifestFile(staged.dir, parsed.manifest);
      await fs.promises.rename(staged.dir, path.join(this.root, staged.id));
      return { ok: true, value: parsed.manifest };
    } catch (error) {
      logger.error('commit failed:', error);
      await this.discardStaging(staged);
      return { ok: false, code: 'io-error', error: 'Failed to save the import' };
    }
  }

  // ===========================================================================
  // Read
  // ===========================================================================

  /** All imports, newest first. Unreadable import directories are included as invalid. */
  async list(): Promise<ImportListEntry[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (!isNotFound(error)) logger.error('list failed to read root:', error);
      return [];
    }

    const result: ImportListEntry[] = [];
    for (const entry of entries) {
      // Only real directories named like an import id: ignores dotfiles, staging, strays,
      // and symlinks planted in the mount.
      if (!entry.isDirectory() || !isImportId(entry.name)) continue;
      result.push(await this.readEntry(entry.name));
    }

    const created = (item: ImportListEntry): string => (item.valid ? item.manifest.createdAt : '');
    return result.sort((a, b) => created(b).localeCompare(created(a)));
  }

  async get(id: string): Promise<ImportManifest | null> {
    if (!isImportId(id)) return null;
    const entry = await this.readEntry(id);
    return entry.valid ? entry.manifest : null;
  }

  private async readEntry(id: string): Promise<ImportListEntry> {
    const manifestPath = path.join(this.root, id, MANIFEST_FILE);
    try {
      const stat = await fs.promises.lstat(manifestPath);
      if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
        return { valid: false, id, error: 'manifest.json is not a regular file or is too large' };
      }
      const parsed = parseManifest(
        JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')),
        id
      );
      return parsed.valid
        ? { valid: true, manifest: parsed.manifest }
        : { valid: false, id, error: parsed.error };
    } catch (error) {
      const reason = isNotFound(error) ? 'manifest.json is missing' : 'manifest.json is unreadable';
      return { valid: false, id, error: reason };
    }
  }

  // ===========================================================================
  // Rename / delete
  // ===========================================================================

  async rename(id: string, newName: unknown): Promise<ImportOpResult<ImportManifest>> {
    if (!isImportId(id)) return { ok: false, code: 'invalid-id', error: 'Invalid import id' };
    const name = validateImportName(newName);
    if (!name.valid) return { ok: false, code: 'invalid-name', error: name.error };

    const manifest = await this.get(id);
    if (!manifest) return { ok: false, code: 'not-found', error: 'Import not found' };

    const updated: ImportManifest = { ...manifest, name: name.value };
    try {
      await this.writeManifestFile(path.join(this.root, id), updated);
      return { ok: true, value: updated };
    } catch (error) {
      logger.error(`rename failed for ${id}:`, error);
      return { ok: false, code: 'io-error', error: 'Failed to rename the import' };
    }
  }

  /** Deletes an import, including invalid ones. The directory is renamed first so a
   * half-deleted import never shows up in list(). */
  async delete(id: string): Promise<ImportOpResult> {
    if (!isImportId(id)) return { ok: false, code: 'invalid-id', error: 'Invalid import id' };

    const dir = path.join(this.root, id);
    const trash = path.join(this.root, `${TRASH_PREFIX}${randomUUID()}`);
    try {
      const stat = await fs.promises.lstat(dir);
      if (!stat.isDirectory()) {
        return { ok: false, code: 'not-found', error: 'Import not found' };
      }
      await fs.promises.rename(dir, trash);
    } catch (error) {
      if (isNotFound(error)) return { ok: false, code: 'not-found', error: 'Import not found' };
      logger.error(`delete failed for ${id}:`, error);
      return { ok: false, code: 'io-error', error: 'Failed to delete the import' };
    }

    try {
      await fs.promises.rm(trash, { recursive: true, force: true });
    } catch (error) {
      // The import is already gone from list(); the leftover is cleaned at next startup.
      logger.error(`delete left ${trash} behind:`, error);
    }
    return { ok: true, value: undefined };
  }

  // ===========================================================================
  // Path resolution (used by the session pipeline in a later slice)
  // ===========================================================================

  /**
   * Absolute path of the JSONL file for a session id inside an import, or null.
   * - session import: sessionId must equal the manifest's session id
   * - eval-run import: sessionId must be a trace id (t001) listed in the manifest
   * The file must exist and, after resolving symlinks, still lie inside the import.
   */
  async resolveSessionFile(importId: string, sessionId: string): Promise<string | null> {
    const manifest = await this.get(importId);
    if (!manifest) return null;

    let relative: string | undefined;
    if (manifest.type === 'session') {
      if (sessionId === manifest.sessionId) relative = `${manifest.sessionId}.jsonl`;
    } else if (isEvalTraceId(sessionId)) {
      relative = manifest.traces?.find((trace) => trace.id === sessionId)?.file;
    }
    if (!relative) return null;
    return this.resolveInsideImport(importId, relative);
  }

  /**
   * Everything needed to adapt one eval trace: the file, its manifest entry and the case
   * prompt from results.json. Null when the import is not an eval-run or the id is unknown.
   */
  async getEvalTraceSource(
    importId: string,
    sessionId: string
  ): Promise<{ filePath: string; ref: ImportTraceRef; prompt?: string } | null> {
    const manifest = await this.get(importId);
    if (manifest?.type !== 'eval-run') return null;
    const ref = manifest.traces?.find((trace) => trace.id === sessionId);
    if (!ref) return null;
    const filePath = await this.resolveSessionFile(importId, sessionId);
    if (!filePath) return null;
    return { filePath, ref, prompt: await this.readCasePrompt(importId, ref.caseName) };
  }

  /** Read model of an eval-run import (results.json), or null for other imports. */
  async getEvalResults(importId: string): Promise<EvalResultsView | null> {
    const manifest = await this.get(importId);
    if (manifest?.type !== 'eval-run') return null;
    const resultsPath = await this.resolveInsideImport(importId, 'results.json');
    if (!resultsPath) return null;
    try {
      const stat = await fs.promises.stat(resultsPath);
      if (stat.size > MAX_RESULTS_BYTES) return null;
      return buildEvalResultsView(JSON.parse(await fs.promises.readFile(resultsPath, 'utf8')));
    } catch (error) {
      logger.error(`Failed to read results for ${importId}:`, error);
      return null;
    }
  }

  private async readCasePrompt(importId: string, caseName: string): Promise<string | undefined> {
    const resultsPath = await this.resolveInsideImport(importId, 'results.json');
    if (!resultsPath) return undefined;
    try {
      const stat = await fs.promises.stat(resultsPath);
      if (stat.size > MAX_RESULTS_BYTES) return undefined;
      const parsed: unknown = JSON.parse(await fs.promises.readFile(resultsPath, 'utf8'));
      const cases = (parsed as { cases?: unknown }).cases;
      if (!Array.isArray(cases)) return undefined;
      for (const item of cases as { name?: unknown; promptMarkdown?: unknown }[]) {
        if (item.name === caseName && typeof item.promptMarkdown === 'string') {
          return item.promptMarkdown;
        }
      }
    } catch (error) {
      logger.error(`Failed to read the case prompt for ${importId}:`, error);
    }
    return undefined;
  }

  /** Absolute path of a session import's subagents directory, or null. */
  async resolveSubagentsDir(importId: string, sessionId: string): Promise<string | null> {
    const manifest = await this.get(importId);
    if (manifest?.type !== 'session' || sessionId !== manifest.sessionId) return null;
    return this.resolveInsideImport(importId, `${manifest.sessionId}/subagents`);
  }

  private async resolveInsideImport(importId: string, relative: string): Promise<string | null> {
    const importDir = path.join(this.root, importId);
    const target = path.resolve(importDir, relative);
    if (!isInside(importDir, target)) return null;
    try {
      const [realRoot, realTarget] = await Promise.all([
        fs.promises.realpath(this.root),
        fs.promises.realpath(target),
      ]);
      return isInside(path.join(realRoot, importId), realTarget) ? target : null;
    } catch {
      return null;
    }
  }

  /**
   * Synchronous variants of the resolvers above, for the path builders in pathDecoder
   * (which are synchronous and called from many places). They read one small manifest.
   */
  resolveSessionFileSync(importId: string, sessionId: string): string | null {
    const manifest = this.getSync(importId);
    if (!manifest) return null;
    return this.resolveInsideImportSync(importId, this.sessionFileFor(manifest, sessionId));
  }

  resolveSubagentsDirSync(importId: string, sessionId: string): string | null {
    const manifest = this.getSync(importId);
    if (manifest?.type !== 'session' || sessionId !== manifest.sessionId) return null;
    return this.resolveInsideImportSync(importId, `${manifest.sessionId}/subagents`);
  }

  private sessionFileFor(manifest: ImportManifest, sessionId: string): string | undefined {
    if (manifest.type === 'session') {
      return sessionId === manifest.sessionId ? `${manifest.sessionId}.jsonl` : undefined;
    }
    return isEvalTraceId(sessionId)
      ? manifest.traces?.find((trace) => trace.id === sessionId)?.file
      : undefined;
  }

  private getSync(id: string): ImportManifest | null {
    if (!isImportId(id)) return null;
    const manifestPath = path.join(this.root, id, MANIFEST_FILE);
    try {
      const stat = fs.lstatSync(manifestPath);
      if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
      const parsed = parseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), id);
      return parsed.valid ? parsed.manifest : null;
    } catch {
      return null;
    }
  }

  private resolveInsideImportSync(importId: string, relative: string | undefined): string | null {
    if (!relative) return null;
    const importDir = path.join(this.root, importId);
    const target = path.resolve(importDir, relative);
    if (!isInside(importDir, target)) return null;
    try {
      const realRoot = fs.realpathSync(this.root);
      const realTarget = fs.realpathSync(target);
      return isInside(path.join(realRoot, importId), realTarget) ? target : null;
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private isStagingDir(dir: string): boolean {
    const resolved = path.resolve(dir);
    return (
      path.dirname(resolved) === this.root && path.basename(resolved).startsWith(STAGING_PREFIX)
    );
  }

  /** Writes manifest.json atomically: temp file in the same directory, then rename. */
  private async writeManifestFile(dir: string, manifest: ImportManifest): Promise<void> {
    const target = path.join(dir, MANIFEST_FILE);
    const temp = path.join(dir, `${MANIFEST_FILE}.${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o644,
      });
      await fs.promises.rename(temp, target);
    } catch (error) {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
