import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChunkBuilder } from '../../../../src/main/services/analysis/ChunkBuilder';
import { ProjectScanner } from '../../../../src/main/services/discovery/ProjectScanner';
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
