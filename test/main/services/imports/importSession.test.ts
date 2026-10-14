import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChunkBuilder } from '../../../../src/main/services/analysis/ChunkBuilder';
import { ProjectScanner } from '../../../../src/main/services/discovery/ProjectScanner';
import { SubagentResolver } from '../../../../src/main/services/discovery/SubagentResolver';
import { importFromZip } from '../../../../src/main/services/imports/importFromZip';
import { ImportService } from '../../../../src/main/services/imports/ImportService';
import { ImportSessionSource } from '../../../../src/main/services/imports/ImportSessionSource';
import { SessionParser } from '../../../../src/main/services/parsing/SessionParser';
import { isAIChunk, isUserChunk } from '../../../../src/main/types';
import { setImportPathResolver } from '../../../../src/main/utils/pathDecoder';

import { buildZip } from './zipFixture';

// All content is invented.
const PROMPT = 'Please review the fake change';

const lines = [
  {
    type: 'system',
    subtype: 'init',
    uuid: 'i',
    session_id: 's',
    claude_code_version: '9.9.9',
    model: 'model-x',
    cwd: '/fake/cwd',
  },
  { type: 'system', subtype: 'thinking_tokens', uuid: 't', estimated_tokens: 3 },
  {
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-01-01T00:00:00.000Z',
    request_id: 'r1',
    parent_tool_use_id: null,
    message: {
      id: 'm1',
      role: 'assistant',
      model: 'model-x',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/x' } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  },
  {
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-01-01T00:00:01.000Z',
    parent_tool_use_id: null,
    tool_use_result: { type: 'text', file: { filePath: '/x', content: 'hi' } },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'hi' }],
    },
  },
  {
    type: 'assistant',
    uuid: 'a2',
    timestamp: '2026-01-01T00:00:02.000Z',
    request_id: 'r2',
    parent_tool_use_id: null,
    message: {
      id: 'm2',
      role: 'assistant',
      model: 'model-x',
      content: [{ type: 'text', text: 'All good' }],
      usage: { input_tokens: 20, output_tokens: 6 },
    },
  },
  { type: 'result', subtype: 'success', uuid: 'res', num_turns: 2, total_cost_usd: 0.1 },
]
  .map((l) => JSON.stringify(l))
  .join('\n');

const results = {
  schemaVersion: 1,
  claudeVersion: '9.9.9',
  partial: false,
  cases: [
    { name: 'alpha', runsPerCase: 1, promptMarkdown: PROMPT, arms: { with: [{ error: null }] } },
  ],
};

describe('eval trace through the session pipeline', () => {
  let root: string;
  let importId: string;
  let service: ImportService;
  let source: ImportSessionSource;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-session-'));
    service = new ImportService(path.join(root, 'imports'));
    source = new ImportSessionSource(service);
    setImportPathResolver({
      root: service.getRoot(),
      sessionFile: (id, sid) => service.resolveSessionFileSync(id, sid),
      subagentsDir: (id, sid) => service.resolveSubagentsDirSync(id, sid),
    });
    const zipPath = path.join(root, 'in.zip');
    fs.writeFileSync(
      zipPath,
      buildZip([
        { name: 'results.json', data: JSON.stringify(results) },
        { name: 'traces/alpha/with-1.jsonl', data: `${lines}\n` },
      ])
    );
    const imported = await importFromZip(service, { zipPath, type: 'eval-run', name: 'run' });
    if (!imported.ok) throw new Error(imported.errors.join(', '));
    importId = imported.manifest.id;
  });

  afterEach(() => {
    setImportPathResolver(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('parses into a user chunk and one AI chunk with a linked tool execution', async () => {
    const scanner = new ProjectScanner(path.join(root, 'projects'), path.join(root, 'todos'));
    const parser = new SessionParser(scanner);
    parser.setImportSource(source);

    const parsed = await parser.parseSession(`import:${importId}`, 't001');
    const chunks = new ChunkBuilder().buildChunks(parsed.messages, []);

    expect(chunks.filter(isUserChunk)).toHaveLength(1);
    expect(chunks.find(isUserChunk)?.userMessage.content).toBe(PROMPT);
    const ai = chunks.filter(isAIChunk);
    expect(ai).toHaveLength(1);
    expect(ai[0].toolExecutions).toHaveLength(1);
    expect(ai[0].toolExecutions[0].toolCall.name).toBe('Read');
    expect(ai[0].toolExecutions[0].result?.content).toBe('hi');
    // Token totals come from the last line per request, not summed twice.
    expect(parsed.metrics.inputTokens).toBe(30);
    expect(parsed.metrics.outputTokens).toBe(11);
  });

  it('builds session metadata without reading ~/.claude', async () => {
    const session = await source.buildSession(importId, 't001');
    expect(session).toMatchObject({
      id: 't001',
      projectId: `import:${importId}`,
      projectPath: '',
      firstMessage: PROMPT,
      hasSubagents: false,
      isOngoing: false,
    });
    expect(session?.messageCount).toBeGreaterThan(0);
  });

  it('returns null for unknown traces and throws a readable error for unusable ones', async () => {
    expect(await source.loadEvalTrace(importId, 't999')).toBeNull();
    expect(await source.buildSession(importId, 't999')).toBeNull();

    const file = path.join(service.getRoot(), importId, 'traces/alpha/with-1.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ type: 'result', uuid: 'x' })}\n`);
    await expect(source.loadEvalTrace(importId, 't001')).rejects.toThrow(/no assistant/);
  });

  it('leaves the stored trace untouched', async () => {
    await source.loadEvalTrace(importId, 't001');
    const file = path.join(service.getRoot(), importId, 'traces/alpha/with-1.jsonl');
    expect(fs.readFileSync(file, 'utf8')).toBe(`${lines}\n`);
  });
});

describe('eval trace with an inline subagent through the session pipeline', () => {
  const AGENT_ID = 'agent-fake-1';
  const SUB_PROMPT = 'Check the fake file';
  const base = { parent_tool_use_id: null };
  const subLine = (extra: Record<string, unknown>) => ({
    ...extra,
    parent_tool_use_id: 'agent-call-1',
  });

  const traceLines = [
    { type: 'system', subtype: 'init', uuid: 'i', session_id: 's', cwd: '/fake/cwd' },
    {
      ...base,
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-01-01T00:00:00.000Z',
      request_id: 'r1',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'agent-call-1',
            name: 'Agent',
            input: { description: 'Check it', subagent_type: 'fake:checker', prompt: SUB_PROMPT },
          },
        ],
      },
    },
    {
      type: 'system',
      subtype: 'task_started',
      uuid: 'ts',
      task_id: AGENT_ID,
      tool_use_id: 'agent-call-1',
      description: 'Check it',
      subagent_type: 'fake:checker',
      prompt: SUB_PROMPT,
    },
    {
      ...base,
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-01-01T00:00:01.000Z',
      tool_use_result: { isAsync: true, status: 'async_launched', agentId: AGENT_ID },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'agent-call-1', content: 'launched' }],
      },
    },
    subLine({
      type: 'assistant',
      uuid: 's1',
      timestamp: '2026-01-01T00:00:02.000Z',
      request_id: 'sr1',
      message: {
        id: 'sm1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'sub-tool-1', name: 'Read', input: { file_path: '/x' } }],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    }),
    subLine({
      type: 'user',
      uuid: 's2',
      timestamp: '2026-01-01T00:00:03.000Z',
      tool_use_result: { type: 'text', file: { filePath: '/x', content: 'hi' } },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'sub-tool-1', content: 'hi' }],
      },
    }),
    subLine({
      type: 'assistant',
      uuid: 's3',
      timestamp: '2026-01-01T00:00:04.000Z',
      request_id: 'sr2',
      message: {
        id: 'sm2',
        role: 'assistant',
        content: [{ type: 'text', text: 'Looks fine' }],
        usage: { input_tokens: 9, output_tokens: 4 },
      },
    }),
    {
      ...base,
      type: 'assistant',
      uuid: 'a2',
      timestamp: '2026-01-01T00:00:05.000Z',
      request_id: 'r2',
      message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    },
    { type: 'result', subtype: 'success', uuid: 'res', num_turns: 2, total_cost_usd: 0.1 },
  ]
    .map((l) => JSON.stringify(l))
    .join('\n');

  let root: string;
  let importId: string;
  let projectId: string;
  let scanner: ProjectScanner;
  let parser: SessionParser;
  let resolver: SubagentResolver;
  let source: ImportSessionSource;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-subagent-'));
    const service = new ImportService(path.join(root, 'imports'));
    source = new ImportSessionSource(service);
    setImportPathResolver({
      root: service.getRoot(),
      sessionFile: (id, sid) => service.resolveSessionFileSync(id, sid),
      subagentsDir: (id, sid) => service.resolveSubagentsDirSync(id, sid),
    });
    const zipPath = path.join(root, 'in.zip');
    fs.writeFileSync(
      zipPath,
      buildZip([
        { name: 'results.json', data: JSON.stringify(results) },
        { name: 'traces/alpha/with-1.jsonl', data: `${traceLines}\n` },
      ])
    );
    const imported = await importFromZip(service, { zipPath, type: 'eval-run', name: 'run' });
    if (!imported.ok) throw new Error(imported.errors.join(', '));
    importId = imported.manifest.id;
    projectId = `import:${importId}`;

    scanner = new ProjectScanner(path.join(root, 'projects'), path.join(root, 'todos'));
    parser = new SessionParser(scanner);
    parser.setImportSource(source);
    resolver = new SubagentResolver(scanner);
    resolver.setImportSource(source);
  });

  afterEach(() => {
    setImportPathResolver(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps subagent lines out of the main thread', async () => {
    const parsed = await parser.parseSession(projectId, 't001');
    expect(parsed.messages.map((m) => m.uuid)).not.toContain('s1');
    expect(parsed.taskCalls.map((tc) => tc.id)).toEqual(['agent-call-1']);
  });

  it('resolves the subagent and links it to the Agent call', async () => {
    const parsed = await parser.parseSession(projectId, 't001');
    const subagents = await resolver.resolveSubagents(
      projectId,
      't001',
      parsed.taskCalls,
      parsed.messages
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: AGENT_ID,
      parentTaskId: 'agent-call-1',
      description: 'Check it',
      subagentType: 'fake:checker',
    });
    expect(subagents[0].messages.map((m) => m.uuid)).toEqual([
      `eval-subagent-prompt-${AGENT_ID}`,
      's1',
      's2',
      's3',
    ]);
    expect(subagents[0].messages[0].content).toBe(SUB_PROMPT);
    expect(subagents[0].metrics.inputTokens).toBe(16);
  });

  it('attaches the subagent to the AI chunk, tied to its Agent call', async () => {
    const parsed = await parser.parseSession(projectId, 't001');
    const subagents = await resolver.resolveSubagents(
      projectId,
      't001',
      parsed.taskCalls,
      parsed.messages
    );
    const ai = new ChunkBuilder().buildChunks(parsed.messages, subagents).filter(isAIChunk);
    const processes = ai.flatMap((c) => c.processes);
    expect(processes.map((p) => p.id)).toEqual([AGENT_ID]);
    expect(processes[0].parentTaskId).toBe('agent-call-1');
  });

  it('flags the session as having subagents', async () => {
    expect((await source.buildSession(importId, 't001'))?.hasSubagents).toBe(true);
  });

  it('builds the drill-down detail of the subagent', async () => {
    const detail = await new ChunkBuilder().buildSubagentDetail(
      projectId,
      't001',
      AGENT_ID,
      parser,
      resolver,
      scanner.getFileSystemProvider(),
      scanner.getProjectsDir()
    );
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(AGENT_ID);
    expect(detail?.description).toBe('Check it');
    expect(detail?.subagentType).toBe('fake:checker');
    const ai = detail?.chunks.filter(isAIChunk) ?? [];
    expect(ai.flatMap((c) => c.toolExecutions.map((t) => t.toolCall.name))).toEqual(['Read']);
  });

  it('returns no detail for an unknown subagent id', async () => {
    const detail = await new ChunkBuilder().buildSubagentDetail(
      projectId,
      't001',
      'agent-missing',
      parser,
      resolver,
      scanner.getFileSystemProvider(),
      scanner.getProjectsDir()
    );
    expect(detail).toBeNull();
    // The file lookup it falls back to reports the miss; that warning is expected here.
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Subagent file not found')
    );
    vi.mocked(console.warn).mockClear();
  });
});
