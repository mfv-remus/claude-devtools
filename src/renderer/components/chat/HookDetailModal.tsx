import { useEffect } from 'react';

import { CODE_BG, CODE_BORDER, COLOR_TEXT_SECONDARY } from '@renderer/constants/cssVariables';
import { formatDuration } from '@renderer/utils/formatters';
import { format } from 'date-fns';
import { AlertCircle, CheckCircle2, CircleSlash, X } from 'lucide-react';

import { CopyButton } from '../common/CopyButton';

import type { HookGroup } from '@renderer/types/groups';

interface HookDetailModalProps {
  hookGroup: HookGroup;
  onClose: () => void;
}

const StatusIcon = ({ hookGroup }: { hookGroup: HookGroup }): React.JSX.Element => {
  if (hookGroup.status === 'cancelled') {
    return <CircleSlash size={14} style={{ color: 'var(--color-text-muted)' }} />;
  }
  if (hookGroup.exitCode !== undefined && hookGroup.exitCode !== 0) {
    return <AlertCircle size={14} style={{ color: 'var(--warning-text)' }} />;
  }
  return <CheckCircle2 size={14} style={{ color: '#4ade80' }} />;
};

/**
 * Detail modal for a single hook execution (SessionStart, PreToolUse, PostToolUse, etc.).
 * Opened from a small inline HookMarker rather than being its own chat group, so a hook
 * firing mid-turn never splits one Claude response into two separate cards.
 */
export const HookDetailModal = ({
  hookGroup,
  onClose,
}: Readonly<HookDetailModalProps>): React.JSX.Element => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const {
    hookName,
    hookEvent,
    status,
    command,
    stdout,
    stderr,
    exitCode,
    durationMs,
    timestamp,
    systemMessage,
    additionalContext,
  } = hookGroup;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        className="absolute inset-0 cursor-default"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
        onClick={onClose}
        aria-label="Close hook detail"
        tabIndex={-1}
      />

      <div
        className="relative mx-4 flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label={`Hook detail: ${hookName || hookEvent}`}
        style={{
          backgroundColor: 'var(--color-surface-overlay)',
          borderColor: 'var(--color-border-emphasis)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between gap-3 border-b px-5 py-3"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                {hookName || hookEvent}
              </h2>
              <StatusIcon hookGroup={hookGroup} />
            </div>
            <div
              className="mt-1 flex items-center gap-3 font-mono text-[11px] tabular-nums"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <span>{status === 'cancelled' ? 'cancelled' : formatDuration(durationMs ?? 0)}</span>
              {exitCode !== undefined && exitCode !== 0 && (
                <span style={{ color: 'var(--warning-text)' }}>exit code {exitCode}</span>
              )}
              <span>{format(timestamp, 'h:mm:ss a')}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-md p-1 transition-colors hover:bg-white/5"
            aria-label="Close"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {command && (
            <div>
              <div className="mb-1 text-xs font-medium" style={{ color: COLOR_TEXT_SECONDARY }}>
                Command
              </div>
              <pre
                className="whitespace-pre-wrap rounded-lg p-3 font-mono text-xs"
                style={{
                  color: COLOR_TEXT_SECONDARY,
                  backgroundColor: CODE_BG,
                  border: `1px solid ${CODE_BORDER}`,
                }}
              >
                {command}
              </pre>
            </div>
          )}

          {systemMessage && (
            <div>
              <div className="mb-1 text-xs font-medium" style={{ color: COLOR_TEXT_SECONDARY }}>
                System message
              </div>
              <pre
                className="whitespace-pre-wrap rounded-lg p-3 font-mono text-xs"
                style={{
                  color: COLOR_TEXT_SECONDARY,
                  backgroundColor: CODE_BG,
                  border: `1px solid ${CODE_BORDER}`,
                }}
              >
                {systemMessage}
              </pre>
            </div>
          )}

          {additionalContext && additionalContext.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium" style={{ color: 'var(--warning-text)' }}>
                Injected context
              </div>
              {additionalContext.map((ctx, i) => (
                <pre
                  key={i}
                  className="whitespace-pre-wrap rounded-lg p-3 font-mono text-xs"
                  style={{
                    color: COLOR_TEXT_SECONDARY,
                    backgroundColor: CODE_BG,
                    border: `1px solid ${CODE_BORDER}`,
                  }}
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
                className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg p-3 font-mono text-xs"
                style={{
                  color: COLOR_TEXT_SECONDARY,
                  backgroundColor: CODE_BG,
                  border: `1px solid ${CODE_BORDER}`,
                }}
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
                className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg p-3 font-mono text-xs"
                style={{
                  color: 'var(--warning-text)',
                  backgroundColor: CODE_BG,
                  border: `1px solid ${CODE_BORDER}`,
                }}
              >
                {stderr}
              </pre>
            </div>
          )}

          {!command && !stdout && !stderr && !systemMessage && !additionalContext?.length && (
            <div className="py-8 text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>
              {status === 'cancelled'
                ? 'This hook was cancelled before it produced any output.'
                : 'No additional output.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
