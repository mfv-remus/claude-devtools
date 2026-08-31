/**
 * Shared helpers for turning hook execution data into a display-ready HookGroup.
 * Used both for standalone hook chunks (no adjacent AI turn to attach to) and for
 * hook SemanticSteps embedded inline within an AIGroup's display items.
 */

import type { SemanticStep } from '@renderer/types/data';
import type { HookGroup } from '@renderer/types/groups';

/**
 * Parses a hook's stdout as JSON to extract the fields the CLI itself surfaces
 * to the user: `systemMessage` and `hookSpecificOutput.additionalContext`.
 * Hooks that print plain (non-JSON) text have neither field.
 */
export function parseHookStdout(stdout: string): {
  systemMessage?: string;
  additionalContext?: string[];
} {
  if (!stdout.trim()) return {};

  try {
    const parsed = JSON.parse(stdout) as {
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string | string[] };
    };
    const rawContext = parsed.hookSpecificOutput?.additionalContext;
    const additionalContext =
      rawContext === undefined ? undefined : Array.isArray(rawContext) ? rawContext : [rawContext];

    return { systemMessage: parsed.systemMessage, additionalContext };
  } catch {
    return {};
  }
}

/**
 * Builds a HookGroup from a 'hook'-type SemanticStep (a hook that fired mid-turn
 * and was kept inline within the enclosing AIChunk instead of splitting it).
 */
export function buildHookGroupFromStep(step: SemanticStep): HookGroup {
  const { content } = step;
  const status = content.hookStatus ?? 'success';
  const { systemMessage, additionalContext } =
    status === 'success' && content.hookStdout ? parseHookStdout(content.hookStdout) : {};

  return {
    id: step.id,
    timestamp: step.startTime,
    hookName: content.hookName ?? 'unknown',
    hookEvent: content.hookEvent ?? 'unknown',
    status,
    command: content.hookCommand,
    stdout: content.hookStdout,
    stderr: content.hookStderr,
    exitCode: content.hookExitCode,
    durationMs: step.durationMs,
    systemMessage,
    additionalContext,
  };
}
