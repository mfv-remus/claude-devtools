/**
 * HTTP route handlers for Imports (user-named, immutable copies of eval runs and sessions).
 *
 * Routes:
 * - GET    /api/imports/capabilities  -> { enabled, readonly }
 * - GET    /api/imports               -> list (valid and invalid entries)
 * - POST   /api/imports               -> multipart upload: type, name, file (.zip)
 * - PATCH  /api/imports/:id           -> rename
 * - DELETE /api/imports/:id           -> delete
 *
 * Write routes are guarded against cross-site requests (custom header + Origin/Host check)
 * and refused when IMPORTS_READONLY is set. The list/read routes exist only when an
 * ImportService is configured (IMPORTS_ROOT).
 */

import fastifyMultipart from '@fastify/multipart';
import { createLogger } from '@shared/utils/logger';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';

import { DEFAULT_ARCHIVE_LIMITS } from '../services/imports/archivePolicy';
import { importFromZip } from '../services/imports/importFromZip';
import { isEvalTraceId, isImportId } from '../services/imports/importIds';

import type { ImportService } from '../services/imports/ImportService';
import type { ImportSessionSource } from '../services/imports/ImportSessionSource';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const logger = createLogger('HTTP:imports');

/** Header the renderer must send on write requests; forces a CORS preflight cross-site. */
export const IMPORTS_REQUEST_HEADER = 'x-claude-devtools';

/** Prefix of the upload temp dir; ImportService.cleanupLeftovers removes it after a crash. */
const UPLOAD_DIR_PREFIX = '.staging-upload-';

const MAX_FIELD_BYTES = 4096;

export interface ImportRouteOptions {
  service: ImportService | undefined;
  /** Reads eval traces for the meta route; optional so the routes stay usable in isolation */
  source?: ImportSessionSource;
  readonly: boolean;
}

/** Same-origin requests, or origins explicitly listed in CORS_ORIGIN ('*' is not a match). */
function isAllowedOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true; // non-browser client; the custom header is still required
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (originHost === request.headers.host) return true;
  const configured = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '' && value !== '*');
  return configured.includes(origin);
}

/** Returns true when the request may proceed; otherwise sends the error reply. */
function guardWrite(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ImportRouteOptions
): boolean {
  if (options.readonly) {
    void reply.status(403).send({ error: 'Imports are read-only on this server' });
    return false;
  }
  if (request.headers[IMPORTS_REQUEST_HEADER] === undefined || !isAllowedOrigin(request)) {
    void reply.status(403).send({ error: 'Cross-site request rejected' });
    return false;
  }
  return true;
}

function statusForCode(code: string): number {
  switch (code) {
    case 'invalid-id':
    case 'invalid-name':
    case 'invalid-archive':
      return 400;
    case 'not-found':
      return 404;
    default:
      return 500;
  }
}

interface UploadOutcome {
  status: number;
  body: unknown;
}

async function handleUpload(
  request: FastifyRequest,
  service: ImportService,
  uploadDir: string
): Promise<UploadOutcome> {
  await service.init();
  await fs.promises.mkdir(uploadDir, { mode: 0o700 });
  // Own file name; the client-supplied filename is never used.
  const zipPath = path.join(uploadDir, 'upload.zip');

  const fields: Record<string, string> = {};
  let received = false;
  try {
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        if (typeof part.value === 'string') fields[part.fieldname] = part.value;
        continue;
      }
      if (received) {
        part.file.resume();
        continue;
      }
      received = true;
      await pipeline(part.file, createWriteStream(zipPath, { flags: 'wx', mode: 0o600 }));
      if (part.file.truncated) {
        return {
          status: 413,
          body: {
            errors: [
              `File exceeds the ${DEFAULT_ARCHIVE_LIMITS.maxZipBytes / (1024 * 1024)} MB limit`,
            ],
          },
        };
      }
    }
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    if (code.startsWith('FST_')) {
      return { status: 400, body: { errors: ['Malformed or oversized upload'] } };
    }
    throw error;
  }

  if (!received) return { status: 400, body: { errors: ['No file was uploaded'] } };

  const result = await importFromZip(service, {
    zipPath,
    type: fields.type as 'eval-run' | 'session',
    name: fields.name ?? '',
  });
  if (!result.ok) return { status: statusForCode(result.code), body: { errors: result.errors } };
  return { status: 201, body: { manifest: result.manifest, ignored: result.ignored } };
}

export function registerImportRoutes(app: FastifyInstance, options: ImportRouteOptions): void {
  const { service } = options;

  app.get('/api/imports/capabilities', async () => ({
    enabled: service !== undefined,
    readonly: options.readonly,
  }));

  if (!service) return;

  // Child scope so the multipart parser only applies to the import routes.
  void app.register(async (scope) => {
    await scope.register(fastifyMultipart, {
      limits: {
        fileSize: DEFAULT_ARCHIVE_LIMITS.maxZipBytes,
        files: 1,
        fields: 4,
        parts: 6,
        fieldSize: MAX_FIELD_BYTES,
      },
    });

    scope.get('/api/imports', async (_request, reply) => {
      try {
        return await service.list();
      } catch (error) {
        logger.error('Error in GET /api/imports:', error);
        return reply.status(500).send({ error: 'Failed to list imports' });
      }
    });

    scope.get<{ Params: { id: string } }>('/api/imports/:id/results', async (request, reply) => {
      if (!isImportId(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid import id' });
      }
      try {
        const results = await service.getEvalResults(request.params.id);
        if (!results) return await reply.status(404).send({ error: 'Eval results not found' });
        return results;
      } catch (error) {
        logger.error('Error in GET /api/imports/:id/results:', error);
        return reply.status(500).send({ error: 'Failed to read eval results' });
      }
    });

    scope.get<{ Params: { id: string; sessionId: string } }>(
      '/api/imports/:id/traces/:sessionId/meta',
      async (request, reply) => {
        const { id, sessionId } = request.params;
        if (!isImportId(id) || !isEvalTraceId(sessionId)) {
          return reply.status(400).send({ error: 'Invalid import or trace id' });
        }
        try {
          const meta = await options.source?.getEvalTraceMeta(id, sessionId);
          if (!meta) return await reply.status(404).send({ error: 'Trace not found' });
          return meta;
        } catch (error) {
          logger.error('Error in GET /api/imports/:id/traces/:sessionId/meta:', error);
          return reply.status(500).send({ error: 'Failed to read the trace' });
        }
      }
    );

    scope.post('/api/imports', async (request, reply) => {
      if (!guardWrite(request, reply, options)) return reply;
      if (!request.isMultipart()) {
        return reply.status(400).send({ errors: ['Expected a multipart upload'] });
      }

      const uploadDir = path.join(service.getRoot(), `${UPLOAD_DIR_PREFIX}${randomUUID()}`);
      let outcome: { status: number; body: unknown };
      try {
        outcome = await handleUpload(request, service, uploadDir);
      } catch (error) {
        logger.error('Error in POST /api/imports:', error);
        outcome = { status: 500, body: { errors: ['Failed to import the file'] } };
      }
      // Remove the temp upload before replying so a finished request leaves nothing behind.
      await fs.promises.rm(uploadDir, { recursive: true, force: true }).catch((error) => {
        logger.error('Failed to remove upload dir:', error);
      });
      return reply.status(outcome.status).send(outcome.body);
    });

    scope.patch<{ Params: { id: string }; Body: { name?: unknown } }>(
      '/api/imports/:id',
      async (request, reply) => {
        if (!guardWrite(request, reply, options)) return reply;
        if (!isImportId(request.params.id)) {
          return reply.status(400).send({ error: 'Invalid import id' });
        }
        const result = await service.rename(request.params.id, request.body?.name);
        if (!result.ok) {
          return reply.status(statusForCode(result.code)).send({ error: result.error });
        }
        return result.value;
      }
    );

    scope.delete<{ Params: { id: string } }>('/api/imports/:id', async (request, reply) => {
      if (!guardWrite(request, reply, options)) return reply;
      if (!isImportId(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid import id' });
      }
      const result = await service.delete(request.params.id);
      if (!result.ok) {
        return reply.status(statusForCode(result.code)).send({ error: result.error });
      }
      return reply.status(204).send();
    });
  });
}
