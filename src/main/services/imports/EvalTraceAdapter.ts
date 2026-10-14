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
 * - inline subagent lines (`parent_tool_use_id` set) are grouped by the `system/task_started`
 *   line that spawned them and returned as separate transcripts (agentId = task_id), each
 *   opened by a synthetic user message holding `task_started.prompt`; lines no task owns are
 *   counted as hidden
 */

import type { EvalTraceMeta } from '@shared/types/imports';

export interface AdaptEvalTraceOptions {
  /** Case prompt from results.json; becomes the first (real) user message */
  prompt?: string;
}

/** One subagent transcript, in the shape of a Claude Code `agent-{id}.jsonl` file */
export interface AdaptedEvalSubagent {
  /** `task_started.task_id` */
  agentId: string;
  /** tool_use id of the call that spawned it (Agent, Task or Skill) */
  toolUseId: string;
  description?: string;
  subagentType?: string;
  lines: string[];
}

export type AdaptEvalTraceResult =
  | { ok: true; lines: string[]; subagents: AdaptedEvalSubagent[]; meta: EvalTraceMeta }
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
    subagentCount: 0,
    hiddenSubagentLines: 0,
    ignoredLines: 0,
    warnings: [],
  };

  const entries: RawLine[] = [];
  /** subagent lines by `parent_tool_use_id`, in trace order */
  const subagentEntries = new Map<string, RawLine[]>();
  /** spawning tool_use id -> its `system/task_started` line */
  const taskStarts = new Map<string, RawLine>();
  /** spawning tool_use id -> its `system/task_notification` line (the subagent has finished) */
  const taskNotifications = new Map<string, RawLine>();
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
      } else if (subtype === 'task_started') {
        const toolUseId = asString(line.tool_use_id);
        if (toolUseId && asString(line.task_id)) taskStarts.set(toolUseId, line);
      } else if (subtype === 'task_notification') {
        const toolUseId = asString(line.tool_use_id);
        if (toolUseId) taskNotifications.set(toolUseId, line);
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

    const parentToolUseId = asString(line.parent_tool_use_id);

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
      isSidechain: parentToolUseId !== undefined,
      userType: 'external',
      message: line.message,
    };

    if (type === 'assistant') {
      if (parentToolUseId === undefined) assistantCount++;
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
    if (parentToolUseId !== undefined) {
      const group = subagentEntries.get(parentToolUseId);
      if (group) group.push(entry);
      else subagentEntries.set(parentToolUseId, [entry]);
    } else {
      entries.push(entry);
    }
  }

  if (assistantCount === 0) {
    return { ok: false, error: 'The trace has no assistant messages' };
  }

  if (!meta.hasInit)
    meta.warnings.push('The trace has no system/init line (model and cwd unknown)');
  if (!meta.hasResult)
    meta.warnings.push('The trace has no result line (the run may have been killed)');

  const subagents: AdaptedEvalSubagent[] = [];
  for (const [toolUseId, group] of subagentEntries) {
    const started = taskStarts.get(toolUseId);
    if (!started) {
      meta.hiddenSubagentLines += group.length;
      continue;
    }
    const agentId = asString(started.task_id)!;
    for (const entry of group) entry.agentId = agentId;
    const subagentPrompt = asString(started.prompt);
    const firstMs = group
      .map((entry) => Date.parse(String(entry.timestamp)))
      .find((ms) => Number.isFinite(ms));
    if (subagentPrompt) {
      group.unshift({
        type: 'user',
        uuid: `eval-subagent-prompt-${agentId}`,
        timestamp: new Date((firstMs ?? Date.now()) - 1).toISOString(),
        sessionId,
        cwd,
        agentId,
        isSidechain: true,
        userType: 'external',
        message: { role: 'user', content: subagentPrompt },
      });
    }
    // The stream never carries a subagent's final text, only the `task_notification` summary.
    // Without a closing text message the transcript ends on a tool_result and reads as ongoing.
    const summary = asString(taskNotifications.get(toolUseId)?.summary);
    if (summary && summary.trim() !== '') {
      const lastMs = group
        .map((entry) => Date.parse(String(entry.timestamp)))
        .filter((ms) => Number.isFinite(ms))
        .pop();
      group.push({
        type: 'assistant',
        uuid: `eval-subagent-result-${agentId}`,
        timestamp: new Date((lastMs ?? Date.now()) + 1).toISOString(),
        sessionId,
        cwd,
        agentId,
        isSidechain: true,
        userType: 'external',
        message: { role: 'assistant', content: [{ type: 'text', text: summary }] },
      });
    }
    subagents.push({
      agentId,
      toolUseId,
      description: asString(started.description),
      subagentType: asString(started.subagent_type),
      lines: chainLines(group),
    });
  }
  meta.subagentCount = subagents.length;
  if (meta.hiddenSubagentLines > 0) {
    meta.warnings.push(
      `${meta.hiddenSubagentLines} subagent line(s) have no matching task_started line and are not shown`
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

  return { ok: true, lines: chainLines(entries), subagents, meta };
}

/** Parent chain by line order (the trace has none). */
function chainLines(entries: RawLine[]): string[] {
  return entries.map((entry, index) =>
    JSON.stringify({ ...entry, parentUuid: index === 0 ? null : entries[index - 1].uuid })
  );
}
