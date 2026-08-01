/**
 * URL routing helpers for deep-linking to a workspace directory and/or session.
 *
 * URL shapes:
 *   /{projectId}             - a workspace directory is selected, no session open
 *   /{projectId}/{sessionId} - a specific session is open
 * projectId is the encoded project directory name (see @main/utils/pathDecoder),
 * already URL-safe, so it round-trips through encodeURIComponent/decodeURIComponent.
 */

// eslint-disable-next-line security/detect-unsafe-regex -- anchored, no backtracking risk
const URL_PATH_PATTERN = /^\/([^/]+)(?:\/([^/]+))?\/?$/;

export interface UrlPathParams {
  projectId: string;
  sessionId?: string;
}

export function buildProjectPath(projectId: string): string {
  return `/${encodeURIComponent(projectId)}`;
}

export function buildSessionPath(projectId: string, sessionId: string): string {
  return `/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`;
}

export function parseUrlPath(pathname: string): UrlPathParams | null {
  const match = URL_PATH_PATTERN.exec(pathname);
  if (!match) return null;
  const sessionId = match[2] ? decodeURIComponent(match[2]) : undefined;
  return { projectId: decodeURIComponent(match[1]), ...(sessionId ? { sessionId } : {}) };
}
