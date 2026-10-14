import {
  IMPORT_PROJECT_PREFIX,
  isImportId,
  isImportProjectId,
} from '@shared/utils/importProjectId';

/**
 * URL routing helpers for deep-linking to a workspace directory and/or session.
 *
 * URL shapes:
 *   /{projectId}             - a workspace directory is selected, no session open
 *   /{projectId}/{sessionId} - a specific session is open
 * projectId is the encoded project directory name (see @main/utils/pathDecoder),
 * already URL-safe, so it round-trips through encodeURIComponent/decodeURIComponent.
 * Import project ids (`import:<uuid>`) are written as `import_<uuid>` in the URL, which reads
 * better than an escaped colon; `import:<uuid>` and `import%3A<uuid>` are still accepted.
 */

const IMPORT_URL_PREFIX = 'import_';

// eslint-disable-next-line security/detect-unsafe-regex -- anchored, no backtracking risk
const URL_PATH_PATTERN = /^\/([^/]+)(?:\/([^/]+))?\/?$/;

export interface UrlPathParams {
  projectId: string;
  sessionId?: string;
}

function projectIdToUrlSegment(projectId: string): string {
  const urlId = isImportProjectId(projectId)
    ? `${IMPORT_URL_PREFIX}${projectId.slice(IMPORT_PROJECT_PREFIX.length)}`
    : projectId;
  return encodeURIComponent(urlId);
}

function projectIdFromUrlSegment(segment: string): string {
  const decoded = decodeURIComponent(segment);
  return decoded.startsWith(IMPORT_URL_PREFIX) &&
    isImportId(decoded.slice(IMPORT_URL_PREFIX.length))
    ? `${IMPORT_PROJECT_PREFIX}${decoded.slice(IMPORT_URL_PREFIX.length)}`
    : decoded;
}

export function buildProjectPath(projectId: string): string {
  return `/${projectIdToUrlSegment(projectId)}`;
}

export function buildSessionPath(projectId: string, sessionId: string): string {
  return `/${projectIdToUrlSegment(projectId)}/${encodeURIComponent(sessionId)}`;
}

export function parseUrlPath(pathname: string): UrlPathParams | null {
  const match = URL_PATH_PATTERN.exec(pathname);
  if (!match) return null;
  const sessionId = match[2] ? decodeURIComponent(match[2]) : undefined;
  return { projectId: projectIdFromUrlSegment(match[1]), ...(sessionId ? { sessionId } : {}) };
}
