import { useState } from 'react';
import { createPortal } from 'react-dom';

import { CODE_BG, COLOR_TEXT_MUTED, COLOR_TEXT_SECONDARY } from '@renderer/constants/cssVariables';
import { formatDuration } from '@renderer/utils/formatters';
import { format } from 'date-fns';
import { AlertCircle, Ban, CheckCircle2, CircleSlash, Webhook } from 'lucide-react';

import { HookDetailModal } from '../HookDetailModal';

import type { HookGroup } from '@renderer/types/groups';

interface HookMarkerProps {
  hookGroup: HookGroup;
}

const StatusIcon = ({ hookGroup }: { hookGroup: HookGroup }): React.JSX.Element => {
  if (hookGroup.status === 'blocked') {
    return <Ban size={13} style={{ color: 'var(--tool-result-error-text)' }} />;
  }
  if (hookGroup.status === 'cancelled') {
    return <CircleSlash size={13} style={{ color: COLOR_TEXT_MUTED }} />;
  }
  if (hookGroup.exitCode !== undefined && hookGroup.exitCode !== 0) {
    return <AlertCircle size={13} style={{ color: 'var(--warning-text)' }} />;
  }
  return <CheckCircle2 size={13} style={{ color: '#4ade80' }} />;
};

/**
 * A single marked point on the main chat flow for a CLI hook execution
 * (SessionStart, PreToolUse, PostToolUse, etc.). Clicking opens a modal with the
 * full command/stdout/stderr detail — the hook never renders as its own chat
 * group, so one firing mid-turn can't split a single Claude response in two.
 */
export const HookMarker = ({ hookGroup }: Readonly<HookMarkerProps>): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false);
  const { hookName, hookEvent, status, durationMs, timestamp, systemMessage } = hookGroup;

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="group flex w-full items-center gap-2 overflow-hidden rounded px-2 py-1 text-left transition-colors"
        style={{ backgroundColor: 'transparent' }}
        onMouseEnter={(e) =>
          Object.assign(e.currentTarget.style, { backgroundColor: 'var(--tool-item-hover-bg)' })
        }
        onMouseLeave={(e) =>
          Object.assign(e.currentTarget.style, { backgroundColor: 'transparent' })
        }
      >
        <Webhook size={13} className="shrink-0" style={{ color: COLOR_TEXT_MUTED }} />
        <span
          className="shrink-0 whitespace-nowrap text-xs font-medium"
          style={{ color: COLOR_TEXT_SECONDARY }}
        >
          Hook
        </span>
        <span
          className="shrink-0 truncate rounded px-1 py-0.5 font-mono text-[11px]"
          style={{ backgroundColor: CODE_BG, color: COLOR_TEXT_MUTED }}
        >
          {hookName || hookEvent}
        </span>
        <StatusIcon hookGroup={hookGroup} />
        {systemMessage && (
          <span
            className="min-w-0 flex-1 truncate text-left text-[11px]"
            style={{ color: COLOR_TEXT_MUTED }}
            title={systemMessage}
          >
            {systemMessage}
          </span>
        )}
        {!systemMessage && <span className="flex-1" />}
        <span
          className="shrink-0 whitespace-nowrap text-[11px]"
          style={{ color: COLOR_TEXT_MUTED }}
        >
          {status === 'cancelled' && 'cancelled'}
          {status === 'blocked' && 'blocked'}
          {status === 'success' && formatDuration(durationMs ?? 0)}
        </span>
        <span
          className="shrink-0 whitespace-nowrap text-[11px]"
          style={{ color: COLOR_TEXT_MUTED }}
        >
          {format(timestamp, 'h:mm:ss a')}
        </span>
      </button>

      {isOpen &&
        createPortal(
          <HookDetailModal hookGroup={hookGroup} onClose={() => setIsOpen(false)} />,
          document.body
        )}
    </>
  );
};
