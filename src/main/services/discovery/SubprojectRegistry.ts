/**
 * SubprojectRegistry - Maps composite project IDs to their split data.
 *
 * When multiple sessions in the same encoded directory have different `cwd` values,
 * they are split into separate "subprojects". Each subproject gets a composite ID
 * of the form `{encodedDir}~{subdirName}`, using the last path segment of its cwd
 * so IDs stay readable in URLs. If two subprojects under the same base directory
 * would sanitize to the same name, the later one falls back to a short content hash
 * (`{encodedDir}~{subdirName}-{sha256(cwd).slice(0,8)}`) to stay unique.
 *
 * The separator is `~` rather than `::` because `~` is an RFC 3986 "unreserved"
 * character, so it survives in URLs unescaped instead of becoming `%3A%3A`.
 * Note: like the lossy dash-based path encoding this app already relies on, a
 * literal `~` inside a real directory name could in theory collide with this
 * separator; `lastIndexOf` is used when parsing to make that as unlikely as possible.
 *
 * This singleton registry tracks:
 * - Which base directory a composite ID maps to
 * - Which cwd each subproject represents
 * - Which session IDs belong to each subproject
 */

import * as crypto from 'crypto';
import * as path from 'path';

/** Separator between the encoded base directory and the subproject suffix. */
export const SUBPROJECT_SEPARATOR = '~';

interface SubprojectEntry {
  baseDir: string;
  cwd: string;
  sessionIds: Set<string>;
}

/**
 * Sanitize a raw path segment into a URL/ID-safe token.
 * Keeps alphanumerics, dots, underscores and dashes; collapses everything else to `-`.
 */
function sanitizeSegment(segment: string): string {
  return segment
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

class SubprojectRegistryImpl {
  private readonly entries = new Map<string, SubprojectEntry>();

  /**
   * Register a subproject and return its composite ID.
   *
   * @param baseDir - The encoded directory name (e.g., "-Users-name-project")
   * @param cwd - The actual working directory for this subproject
   * @param sessionIds - Session IDs belonging to this subproject
   * @param suffixHint - Optional literal suffix to use instead of deriving one from `cwd`.
   *   Used for the "root" subproject (the one matching the project's own directory), whose
   *   cwd basename would otherwise just repeat the project name (e.g. `project~project`).
   * @returns Composite ID in the form `{baseDir}~{suffix}` (or `~{suffix}-{hash}` on name collision)
   */
  register(baseDir: string, cwd: string, sessionIds: string[], suffixHint?: string): string {
    const hash = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 8);
    const sanitized = sanitizeSegment(suffixHint ?? path.basename(cwd));
    const suffix = sanitized || hash;

    let compositeId = `${baseDir}${SUBPROJECT_SEPARATOR}${suffix}`;
    const existing = this.entries.get(compositeId);
    if (existing && existing.cwd !== cwd) {
      // Another subproject already claimed this name with a different cwd.
      compositeId = `${baseDir}${SUBPROJECT_SEPARATOR}${suffix}-${hash}`;
    }

    this.entries.set(compositeId, {
      baseDir,
      cwd,
      sessionIds: new Set(sessionIds),
    });
    return compositeId;
  }

  /**
   * Extract the base directory from any project ID (composite or plain).
   * For composite IDs (`{encoded}~{suffix}`), returns the encoded part.
   * For plain IDs, returns the ID as-is.
   */
  getBaseDir(projectId: string): string {
    const sep = projectId.lastIndexOf(SUBPROJECT_SEPARATOR);
    if (sep !== -1) {
      return projectId.slice(0, sep);
    }
    return projectId;
  }

  /**
   * Check if a project ID is a composite (split) ID.
   */
  isComposite(projectId: string): boolean {
    return projectId.includes(SUBPROJECT_SEPARATOR);
  }

  /**
   * Get the session ID filter set for a composite project ID.
   * Returns null for plain (non-composite) IDs.
   */
  getSessionFilter(projectId: string): Set<string> | null {
    const entry = this.entries.get(projectId);
    return entry?.sessionIds ?? null;
  }

  /**
   * Get the cwd for a composite project ID.
   * Returns null for plain (non-composite) IDs.
   */
  getCwd(projectId: string): string | null {
    const entry = this.entries.get(projectId);
    return entry?.cwd ?? null;
  }

  /**
   * Get the full entry for a composite project ID.
   */
  getEntry(projectId: string): SubprojectEntry | undefined {
    return this.entries.get(projectId);
  }

  /**
   * Clear all registered subprojects. Called at the start of a full re-scan.
   */
  clear(): void {
    this.entries.clear();
  }
}

/** Module-level singleton */
export const subprojectRegistry = new SubprojectRegistryImpl();
