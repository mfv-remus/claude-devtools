import { describe, expect, it } from 'vitest';

import { adaptEvalTrace } from '../../../../src/main/services/imports/EvalTraceAdapter';

// All content is invented.
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';
const T2 = '2026-01-01T00:00:02.000Z';

const init = {
  type: 'system',
  subtype: 'init',
  uuid: 'u-init',
  session_id: 's1',
  claude_code_version: '9.9.9',
  model: 'model-x',
  cwd: '/fake/cwd',
};
const thinking = { type: 'system', subtype: 'thinking_tokens', uuid: 'u-th', estimated_tokens: 5 };
const assistantTool = {
  type: 'assistant',
  uuid: 'a1',
  timestamp: T0,
  request_id: 'req-1',
  parent_tool_use_id: null,
  message: {
    id: 'm1',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/x' } }],
  },
};
const toolResult = {
  type: 'user',
  uuid: 'r1',
  timestamp: T1,
  parent_tool_use_id: null,
  tool_use_result: { type: 'text', file: { filePath: '/x' } },
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'hello' }],
  },
};
const assistantText = {
  type: 'assistant',
  uuid: 'a2',
  timestamp: T2,
  request_id: 'req-2',
  parent_tool_use_id: null,
  message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
};
const result = {
  type: 'result',
  subtype: 'success',
  uuid: 'u-res',
  is_error: false,
  num_turns: 2,
  duration_ms: 1500,
  total_cost_usd: 0.25,
  stop_reason: 'end_turn',
  terminal_reason: 'completed',
};

const toLines = (...items: unknown[]) => items.map((item) => JSON.stringify(item));

function adapt(items: unknown[], prompt?: string) {
  const out = adaptEvalTrace(toLines(...items), { prompt });
  if (!out.ok) throw new Error(out.error);
  return { ...out, entries: out.lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe('adaptEvalTrace', () => {
  const full = [init, thinking, assistantTool, toolResult, assistantText, result];

  it('maps snake_case fields and marks tool results as internal messages', () => {
    const { entries } = adapt(full);
    expect(entries.map((e) => e.uuid)).toEqual(['a1', 'r1', 'a2']);
    expect(entries[0].requestId).toBe('req-1');
    expect(entries[0]).not.toHaveProperty('request_id');
    expect(entries[1]).toMatchObject({
      isMeta: true,
      sourceToolUseID: 'tool-1',
      sourceToolAssistantUUID: 'a1',
      toolUseResult: { type: 'text' },
    });
    expect(entries[1]).not.toHaveProperty('tool_use_result');
  });

  it('synthesizes the parent chain and carries cwd from init', () => {
    const { entries } = adapt(full);
    expect(entries.map((e) => e.parentUuid)).toEqual([null, 'a1', 'r1']);
    expect(entries.every((e) => e.cwd === '/fake/cwd')).toBe(true);
  });

  it('prepends a real user message from the case prompt, just before the first line', () => {
    const { entries } = adapt(full, 'Review this change');
    expect(entries[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'Review this change' },
      parentUuid: null,
    });
    expect(entries[0]).not.toHaveProperty('isMeta');
    expect(Date.parse(entries[0].timestamp as string)).toBe(Date.parse(T0) - 1);
    expect(entries[1].parentUuid).toBe(entries[0].uuid);
  });

  it('adds no user message without a prompt', () => {
    expect(adapt(full).entries[0].type).toBe('assistant');
  });

  it('keeps init, result and permission denials as metadata, not as messages', () => {
    const denied = {
      type: 'system',
      subtype: 'permission_denied',
      uuid: 'u-pd',
      tool_name: 'Bash',
      tool_use_id: 'tool-9',
      message: 'nope',
    };
    const { meta, entries } = adapt([init, denied, assistantTool, assistantText, result]);
    expect(entries).toHaveLength(2);
    expect(meta).toMatchObject({
      hasInit: true,
      hasResult: true,
      claudeVersion: '9.9.9',
      model: 'model-x',
      result: { numTurns: 2, totalCostUsd: 0.25, terminalReason: 'completed', isError: false },
      permissionDenials: [{ toolUseId: 'tool-9', toolName: 'Bash', message: 'nope' }],
      warnings: [],
    });
  });

  it('keeps one entry per line even when lines share a message id', () => {
    const second = {
      ...assistantText,
      uuid: 'a1b',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'same message' }] },
    };
    const { entries } = adapt([init, assistantTool, second]);
    expect(entries.map((e) => e.uuid)).toEqual(['a1', 'a1b']);
  });

  it('hides inline subagent lines and warns', () => {
    const sub = { ...assistantText, uuid: 'sub1', parent_tool_use_id: 'tool-1' };
    const { entries, meta } = adapt([init, assistantTool, sub, assistantText]);
    expect(entries.map((e) => e.uuid)).toEqual(['a1', 'a2']);
    expect(meta.hiddenSubagentLines).toBe(1);
    expect(meta.warnings.join(' ')).toContain('subagent');
  });

  it('warns, but still adapts, when init or result is missing', () => {
    const { meta } = adapt([assistantTool, assistantText]);
    expect(meta.hasInit).toBe(false);
    expect(meta.hasResult).toBe(false);
    expect(meta.warnings).toHaveLength(2);
  });

  it('ignores invalid JSON, unknown types and string tool_use_result', () => {
    const stringResult = { ...toolResult, tool_use_result: 'Error: failed' };
    const out = adaptEvalTrace(
      [
        'not json',
        '',
        ...toLines({ type: 'future-thing', uuid: 'z' }, init, assistantTool, stringResult),
      ],
      {}
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.meta.ignoredLines).toBe(2);
    const last = JSON.parse(out.lines[1]) as Record<string, unknown>;
    expect(last).not.toHaveProperty('toolUseResult');
    expect(last.isMeta).toBe(true);
  });

  it('rejects a trace without assistant messages', () => {
    const out = adaptEvalTrace(toLines(init, result), {});
    expect(out).toEqual({ ok: false, error: 'The trace has no assistant messages' });
  });
});
