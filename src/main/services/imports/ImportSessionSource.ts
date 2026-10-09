/**
 * ImportSessionSource - reads sessions of `import:*` projects for the session pipeline.
 *
 * - session imports hold a normal Claude Code session file; it is read as is
 * - eval-run imports hold SDK traces; they go through EvalTraceAdapter first
 *
 * SessionParser and ProjectScanner call this instead of reading the file directly, so the
 * rest of the pipeline (chunks, metrics, context) sees the same message shape either way.
 */

import { analyzeSessionFileMetadata, analyzeSessionLines, parseJsonlLine } from '@main/utils/jsonl';
import * as fs from 'fs';
import * as readline from 'readline';

import { adaptEvalTrace } from './EvalTraceAdapter';

import type { ImportService } from './ImportService';
import type { ParsedMessage } from '@main/types';
import type { Session } from '@main/types';
import type { EvalTraceMeta } from '@shared/types/imports';

export interface LoadedEvalTrace {
  messages: ParsedMessage[];
  meta: EvalTraceMeta;
}

async function readLines(filePath: string): Promise<string[]> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const lines: string[] = [];
  for await (const line of rl) lines.push(line);
  return lines;
}

export class ImportSessionSource {
  constructor(private readonly service: ImportService) {}

  /**
   * Adapted messages of an eval trace, or null when this is not an eval-run trace
   * (unknown id, or a session import that the normal pipeline reads directly).
   * Throws with a readable message when the trace itself is unusable.
   */
  async loadEvalTrace(importId: string, sessionId: string): Promise<LoadedEvalTrace | null> {
    const source = await this.service.getEvalTraceSource(importId, sessionId);
    if (!source) return null;
    const adapted = adaptEvalTrace(await readLines(source.filePath), { prompt: source.prompt });
    if (!adapted.ok) throw new Error(adapted.error);
    const messages: ParsedMessage[] = [];
    for (const line of adapted.lines) {
      const parsed = parseJsonlLine(line);
      if (parsed) messages.push(parsed);
    }
    return { messages, meta: adapted.meta };
  }

  /** Adapter metadata of one eval trace (warnings, run totals, denials), or null. */
  async getEvalTraceMeta(importId: string, sessionId: string): Promise<EvalTraceMeta | null> {
    const source = await this.service.getEvalTraceSource(importId, sessionId);
    if (!source) return null;
    const adapted = adaptEvalTrace(await readLines(source.filePath), { prompt: source.prompt });
    return adapted.ok ? adapted.meta : null;
  }

  /** Session metadata for the detail view, built without touching ~/.claude. */
  async buildSession(importId: string, sessionId: string): Promise<Session | null> {
    const manifest = await this.service.get(importId);
    const filePath = await this.service.resolveSessionFile(importId, sessionId);
    if (!manifest || !filePath) return null;

    let metadata;
    if (manifest.type === 'eval-run') {
      const source = await this.service.getEvalTraceSource(importId, sessionId);
      if (!source) return null;
      const adapted = adaptEvalTrace(await readLines(source.filePath), { prompt: source.prompt });
      if (!adapted.ok) return null;
      metadata = await analyzeSessionLines(
        (async function* () {
          await Promise.resolve();
          yield* adapted.lines;
        })()
      );
    } else {
      metadata = await analyzeSessionFileMetadata(filePath);
    }

    const importedAt = Date.parse(manifest.createdAt);
    const firstTimestamp = metadata.firstUserMessage
      ? Date.parse(metadata.firstUserMessage.timestamp)
      : NaN;
    return {
      id: sessionId,
      projectId: `import:${importId}`,
      // The sender's cwd is meaningless here; an empty path also keeps the renderer from
      // reading files relative to it.
      projectPath: '',
      createdAt: Math.floor(Number.isFinite(firstTimestamp) ? firstTimestamp : importedAt),
      updatedAt: Math.floor(importedAt),
      firstMessage: metadata.firstUserMessage?.text,
      messageTimestamp: metadata.firstUserMessage?.timestamp,
      hasSubagents: (manifest.subagentCount ?? 0) > 0,
      messageCount: metadata.messageCount,
      isOngoing: false,
      gitBranch: metadata.gitBranch ?? undefined,
      metadataLevel: 'deep',
      contextConsumption: metadata.contextConsumption,
      compactionCount: metadata.compactionCount,
      phaseBreakdown: metadata.phaseBreakdown,
    };
  }
}
