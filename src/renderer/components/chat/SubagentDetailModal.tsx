import { useEffect } from 'react';

import { TabUIProvider } from '@renderer/contexts/TabUIContext';
import { useStore } from '@renderer/store';
import { formatDuration } from '@renderer/utils/formatters';
import { transformChunksToConversation } from '@renderer/utils/groupTransformer';
import { formatTokensCompact } from '@shared/utils/tokenFormatting';
import { AlertTriangle, Loader2, X } from 'lucide-react';

import { ChatHistoryItem } from './ChatHistoryItem';

const noopRegisterRef = () => () => {};

/**
 * Fixed synthetic tab ID so nested AIChatGroup/DisplayItemList expand-toggle
 * state (which requires a TabUIContext) works inside this modal. Shared across
 * all opened subagents since expand state is keyed by aiGroup/item id anyway.
 */
const SUBAGENT_MODAL_TAB_ID = 'subagent-detail-modal';

/**
 * Drill-down modal showing a subagent's full execution transcript.
 * Driven entirely by subagentSlice state (currentSubagentDetail / loading / error).
 * Mounted once at the app root, like ConfirmDialog.
 */
export const SubagentDetailModal = (): React.JSX.Element | null => {
  const { detail, loading, error, closeSubagentModal } = useStore((s) => ({
    detail: s.currentSubagentDetail,
    loading: s.subagentDetailLoading,
    error: s.subagentDetailError,
    closeSubagentModal: s.closeSubagentModal,
  }));

  const isOpen = loading || error != null || detail != null;

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeSubagentModal();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeSubagentModal]);

  if (!isOpen) return null;

  const conversation = detail ? transformChunksToConversation(detail.chunks, [], false) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <button
        className="absolute inset-0 cursor-default"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
        onClick={closeSubagentModal}
        aria-label="Close subagent detail"
        tabIndex={-1}
      />

      <div
        className="relative mx-4 flex max-h-[85vh] w-full max-w-4xl flex-col rounded-lg border shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label={detail?.description ?? 'Subagent detail'}
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
              {detail?.subagentType && (
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                  style={{
                    backgroundColor: 'var(--badge-neutral-bg)',
                    color: 'var(--badge-neutral-text)',
                  }}
                >
                  {detail.subagentType}
                </span>
              )}
              <h2 className="truncate text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                {detail?.description ?? 'Subagent detail'}
              </h2>
            </div>
            {detail && (
              <div
                className="mt-1 flex items-center gap-3 font-mono text-[11px] tabular-nums"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <span>{formatDuration(detail.duration)}</span>
                <span>
                  {formatTokensCompact(detail.metrics.inputTokens)} in /{' '}
                  {formatTokensCompact(detail.metrics.outputTokens)} out
                </span>
                {detail.metrics.thinkingTokens > 0 && (
                  <span>{formatTokensCompact(detail.metrics.thinkingTokens)} thinking</span>
                )}
                <span>{detail.metrics.messageCount} messages</span>
              </div>
            )}
          </div>
          <button
            onClick={closeSubagentModal}
            className="shrink-0 rounded-md p-1 transition-colors hover:bg-white/5"
            aria-label="Close"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div
              className="flex items-center justify-center gap-2 py-12 text-sm"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <Loader2 className="size-4 animate-spin" />
              Loading subagent transcript...
            </div>
          )}

          {!loading && error && (
            <div
              className="flex items-center justify-center gap-2 py-12 text-sm"
              style={{ color: 'var(--error-highlight-text, #ef4444)' }}
            >
              <AlertTriangle className="size-4" />
              {error}
            </div>
          )}

          {!loading && !error && conversation && (
            <TabUIProvider tabId={SUBAGENT_MODAL_TAB_ID}>
              <div className="space-y-4">
                {conversation.items.map((item) => (
                  <ChatHistoryItem
                    key={item.group.id}
                    item={item}
                    highlightedGroupId={null}
                    isSearchHighlight={false}
                    isNavigationHighlight={false}
                    registerChatItemRef={noopRegisterRef}
                    registerAIGroupRef={noopRegisterRef}
                    registerToolRef={() => {}}
                  />
                ))}
              </div>
            </TabUIProvider>
          )}
        </div>
      </div>
    </div>
  );
};
