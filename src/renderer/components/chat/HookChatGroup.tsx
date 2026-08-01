import React, { useState } from 'react';

import {
  CODE_BG,
  CODE_BORDER,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SECONDARY,
  TOOL_CALL_BG,
  TOOL_CALL_BORDER,
  TOOL_CALL_TEXT,
} from '@renderer/constants/cssVariables';
import { formatDuration } from '@renderer/utils/formatters';
import { format } from 'date-fns';
import { AlertCircle, CheckCircle2, ChevronRight, CircleSlash, Webhook } from 'lucide-react';

import { CopyButton } from '../common/CopyButton';

import type { HookGroup } from '@renderer/types/groups';

interface HookChatGroupProps {
  hookGroup: HookGroup;
}

const StatusIcon = ({ hookGroup }: { hookGroup: HookGroup }): React.JSX.Element => {
  if (hookGroup.status === 'cancelled') {
    return <CircleSlash size={14} style={{ color: COLOR_TEXT_MUTED }} />;
  }
  if (hookGroup.exitCode !== undefined && hookGroup.exitCode !== 0) {
    return <AlertCircle size={14} style={{ color: 'var(--warning-text)' }} />;
  }
  return <CheckCircle2 size={14} style={{ color: '#4ade80' }} />;
};

/**
 * HookChatGroup displays a CLI hook execution (SessionStart, UserPromptSubmit,
 * PostToolUse, etc.). Collapsed by default since hooks can fire frequently and
 * are secondary to the main conversation flow.
 */
const HookChatGroupInner = ({ hookGroup }: Readonly<HookChatGroupProps>): React.JSX.Element => {
  const [isExpanded, setIsExpanded] = useState(false);
  const { hookName, hookEvent, status, command, stdout, stderr, exitCode, durationMs, timestamp } =
    hookGroup;

  const hasExpandableContent = Boolean(command || stdout || stderr);

  return (
    <div className="my-2">
      <button
        onClick={() => hasExpandableContent && setIsExpanded(!isExpanded)}
        className={`group flex w-full items-center gap-3 overflow-hidden rounded-lg px-4 py-2 transition-all duration-200 ${
          hasExpandableContent ? 'cursor-pointer' : 'cursor-default'
        }`}
        style={{
          backgroundColor: TOOL_CALL_BG,
          border: `1px solid ${TOOL_CALL_BORDER}`,
        }}
        aria-expanded={isExpanded}
        aria-label="Toggle hook execution details"
      >
        <div
          className="flex shrink-0 items-center gap-2 transition-colors"
          style={{ color: TOOL_CALL_TEXT }}
        >
          {hasExpandableContent && (
            <ChevronRight
              size={16}
              className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
            />
          )}
          <Webhook size={16} />
        </div>

        <span
          className="shrink-0 whitespace-nowrap text-sm font-medium"
          style={{ color: TOOL_CALL_TEXT }}
        >
          Hook
        </span>

        <span
          className="min-w-0 truncate rounded px-1.5 py-0.5 font-mono text-xs"
          style={{ backgroundColor: CODE_BG, color: COLOR_TEXT_SECONDARY }}
        >
          {hookName || hookEvent}
        </span>

        <StatusIcon hookGroup={hookGroup} />

        {hookGroup.systemMessage && (
          <span
            className="min-w-0 flex-1 truncate text-left text-xs"
            style={{ color: COLOR_TEXT_MUTED }}
            title={hookGroup.systemMessage}
          >
            {hookGroup.systemMessage}
          </span>
        )}

        <span
          className="ml-auto shrink-0 whitespace-nowrap text-xs"
          style={{ color: COLOR_TEXT_MUTED }}
        >
          {status === 'cancelled'
            ? 'cancelled'
            : durationMs !== undefined
              ? formatDuration(durationMs)
              : ''}
        </span>
        <span className="shrink-0 whitespace-nowrap text-xs" style={{ color: COLOR_TEXT_MUTED }}>
          {format(timestamp, 'h:mm:ss a')}
        </span>
      </button>

      {isExpanded && hasExpandableContent && (
        <div
          className="group relative mt-2 space-y-2 overflow-hidden rounded-lg px-4 py-3"
          style={{ backgroundColor: CODE_BG, border: `1px solid ${CODE_BORDER}` }}
        >
          {command && (
            <div>
              <div className="mb-1 text-xs font-medium" style={{ color: COLOR_TEXT_SECONDARY }}>
                Command
              </div>
              <pre
                className="whitespace-pre-wrap font-mono text-xs"
                style={{ color: COLOR_TEXT_SECONDARY }}
              >
                {command}
              </pre>
            </div>
          )}

          {hookGroup.additionalContext && hookGroup.additionalContext.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium" style={{ color: 'var(--warning-text)' }}>
                Injected context
              </div>
              {hookGroup.additionalContext.map((ctx, i) => (
                <pre
                  key={i}
                  className="whitespace-pre-wrap font-mono text-xs"
                  style={{ color: COLOR_TEXT_SECONDARY }}
                >
                  {ctx}
                </pre>
              ))}
            </div>
          )}

          {stdout && (
            <div className="relative">
              <div className="mb-1 text-xs font-medium" style={{ color: COLOR_TEXT_SECONDARY }}>
                stdout
              </div>
              <CopyButton text={stdout} />
              <pre
                className="max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-xs"
                style={{ color: COLOR_TEXT_SECONDARY }}
              >
                {stdout}
              </pre>
            </div>
          )}

          {stderr && (
            <div>
              <div className="mb-1 text-xs font-medium" style={{ color: 'var(--warning-text)' }}>
                stderr
              </div>
              <pre
                className="max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-xs"
                style={{ color: 'var(--warning-text)' }}
              >
                {stderr}
              </pre>
            </div>
          )}

          {exitCode !== undefined && exitCode !== 0 && (
            <div className="text-xs" style={{ color: 'var(--warning-text)' }}>
              Exit code: {exitCode}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const HookChatGroup = React.memo(HookChatGroupInner);
