/**
 * EvalTraceAdapter - converts an eval trace (SDK stream-json, as written by a plugin eval
 * run) into the session JSONL shape the existing parser and chunk builder understand.
 * Pure and read-time only: the stored file is never modified.
 *
 * Differences handled (see docs/plans/eval-imports/T3.md):
 * - snake_case fields: `request_id` -> `requestId`, `tool_use_result` -> `toolUseResult`
 * - no real user prompt in the trace: a synthetic user message is built from the case's
 *   `promptMarkdown` (results.json)
 * - tool_result user lines are marked `isMeta: true`
 * - no `parentUuid`: synthesized from line order
 * - `system/init` is kept as metadata, `system/thinking_tokens` is dropped, `result` is
 *   kept as run totals, anything unknown is ignored (the format is not documented)
 * - inline subagent lines (`parent_tool_use_id` set) are hidden and counted in v1
 */

import type { EvalTraceMeta } from '@shared/types/imports';

export interface AdaptEvalTraceOptions {
  /** Case prompt from results.json; becomes the first (real) user message */
  prompt?: string;
}

export type AdaptEvalTraceResult =
  | { ok: true; lines: string[]; meta: EvalTraceMeta }
  | { ok: false; error: string };

type RawLine = Record<string, unknown>;

const SYNTHETIC_PROMPT_UUID = 'eval-prompt-00000000';

const isRecord = (value: unknown): value is RawLine =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function contentBlocks(message: unknown): RawLine[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

export function adaptEvalTrace(
  rawLines: Iterable<string>,
  options: AdaptEvalTraceOptions = {}
): AdaptEvalTraceResult {
  const meta: EvalTraceMeta = {
    hasInit: false,
    hasResult: false,
    permissionDenials: [],
    hiddenSubagentLines: 0,
    ignoredLines: 0,
    warnings: [],
  };

  const entries: RawLine[] = [];
  /** tool_use id -> uuid of the assistant line that issued it */
  const toolUseOwner = new Map<string, string>();
  let cwd: string | undefined;
  let sessionId: string | undefined;
  let assistantCount = 0;

  for (const raw of rawLines) {
    if (raw.trim() === '') continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      meta.ignoredLines++;
      continue;
    }
    if (!isRecord(line)) {
      meta.ignoredLines++;
      continue;
    }

    const type = asString(line.type);
    const subtype = asString(line.subtype);

    if (type === 'system') {
      if (subtype === 'init') {
        meta.hasInit = true;
        meta.claudeVersion = asString(line.claude_code_version);
        meta.model = asString(line.model);
        cwd = asString(line.cwd);
        meta.cwd = cwd;
        sessionId = asString(line.session_id);
      } else if (subtype === 'permission_denied') {
        const toolUseId = asString(line.tool_use_id);
        if (toolUseId) {
          meta.permissionDenials.push({
            toolUseId,
            toolName: asString(line.tool_name),
            message: asString(line.message),
          });
        }
      }
      // thinking_tokens and other system subtypes: estimates / unknown, dropped
      continue;
    }

    if (type === 'result') {
      meta.hasResult = true;
      meta.result = {
        isError: line.is_error === true,
        numTurns: asNumber(line.num_turns),
        durationMs: asNumber(line.duration_ms),
        totalCostUsd: asNumber(line.total_cost_usd),
        stopReason: asString(line.stop_reason),
        terminalReason: asString(line.terminal_reason),
      };
      continue;
    }

    if (type !== 'assistant' && type !== 'user') {
      meta.ignoredLines++;
      continue;
    }

    if (line.parent_tool_use_id != null) {
      meta.hiddenSubagentLines++;
      continue;
    }

    const uuid = asString(line.uuid);
    if (!uuid || !isRecord(line.message)) {
      meta.ignoredLines++;
      continue;
    }

    const entry: RawLine = {
      type,
      uuid,
      timestamp: line.timestamp,
      sessionId: sessionId ?? asString(line.session_id),
      cwd,
      isSidechain: false,
      userType: 'external',
      message: line.message,
    };

    if (type === 'assistant') {
      assistantCount++;
      const requestId = asString(line.request_id);
      if (requestId) entry.requestId = requestId;
      for (const block of contentBlocks(line.message)) {
        const id = asString(block.id);
        if (block.type === 'tool_use' && id) toolUseOwner.set(id, uuid);
      }
    } else {
      const results = contentBlocks(line.message).filter((block) => block.type === 'tool_result');
      if (results.length > 0) {
        entry.isMeta = true;
        const toolUseId = asString(results[0].tool_use_id);
        if (toolUseId) {
          entry.sourceToolUseID = toolUseId;
          const owner = toolUseOwner.get(toolUseId);
          if (owner) entry.sourceToolAssistantUUID = owner;
        }
        // Object results only; string results duplicate the tool_result block content.
        if (isRecord(line.tool_use_result)) entry.toolUseResult = line.tool_use_result;
      }
    }
    entries.push(entry);
  }

  if (assistantCount === 0) {
    return { ok: false, error: 'The trace has no assistant messages' };
  }

  if (!meta.hasInit)
    meta.warnings.push('The trace has no system/init line (model and cwd unknown)');
  if (!meta.hasResult)
    meta.warnings.push('The trace has no result line (the run may have been killed)');
  if (meta.hiddenSubagentLines > 0) {
    meta.warnings.push(
      `${meta.hiddenSubagentLines} subagent line(s) inside this trace are not shown in this version`
    );
  }

  // Synthetic user prompt: just before the first message of the trace.
  const prompt = options.prompt?.trim();
  if (prompt) {
    const firstMs = entries
      .map((entry) => Date.parse(String(entry.timestamp)))
      .find((ms) => Number.isFinite(ms));
    entries.unshift({
      type: 'user',
      uuid: SYNTHETIC_PROMPT_UUID,
      timestamp: new Date((firstMs ?? Date.now()) - 1).toISOString(),
      sessionId,
      cwd,
      isSidechain: false,
      userType: 'external',
      message: { role: 'user', content: options.prompt },
    });
  }

  // Parent chain by line order (the trace has none).
  const lines = entries.map((entry, index) =>
    JSON.stringify({ ...entry, parentUuid: index === 0 ? null : entries[index - 1].uuid })
  );

  return { ok: true, lines, meta };
}
