/**
 * ImportsSection - sidebar block listing imported eval runs and sessions.
 *
 * Hidden entirely when the server has no IMPORTS_ROOT (and in Electron). When
 * IMPORTS_READONLY is set, listing and viewing stay; Import/Rename/Delete are hidden
 * behind a small "read-only" note (the server enforces it, this is convenience only).
 */

import { useEffect, useRef, useState } from 'react';

import { confirm } from '@renderer/components/common/ConfirmDialog';
import { useStore } from '@renderer/store';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FlaskConical,
  MoreHorizontal,
  Plus,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ImportDialog } from './ImportDialog';

import type { ImportListEntry } from '@shared/types/imports';

const entryId = (entry: ImportListEntry): string => (entry.valid ? entry.manifest.id : entry.id);

export const ImportsSection = (): React.JSX.Element | null => {
  const { capabilities, imports, loadImportCapabilities, openImport, renameImport, deleteImport } =
    useStore(
      useShallow((s) => ({
        capabilities: s.importCapabilities,
        imports: s.imports,
        loadImportCapabilities: s.loadImportCapabilities,
        openImport: s.openImport,
        renameImport: s.renameImport,
        deleteImport: s.deleteImport,
      }))
    );
  const [expanded, setExpanded] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    void loadImportCapabilities();
  }, [loadImportCapabilities]);

  if (!capabilities?.enabled) return null;
  const readonly = capabilities.readonly;

  const run = async (action: () => Promise<void>): Promise<void> => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Action failed');
    }
  };

  const onDelete = async (entry: ImportListEntry): Promise<void> => {
    const label = entry.valid ? entry.manifest.name : entry.id;
    const ok = await confirm({
      title: `Delete "${label}"?`,
      message: 'The imported data is removed from the server. This cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (ok) await run(() => deleteImport(entryId(entry)));
  };

  return (
    <div className="border-b" style={{ borderColor: 'var(--color-border)' }}>
      <div className="flex w-full items-center gap-1 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        <button
          type="button"
          onClick={(): void => setExpanded((value) => !value)}
          className="flex flex-1 items-center gap-1.5 text-left hover:text-text-secondary"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown size={13} aria-hidden="true" />
          ) : (
            <ChevronRight size={13} aria-hidden="true" />
          )}
          <span>Imports</span>
          {imports.length > 0 && <span>({imports.length})</span>}
        </button>
        {readonly ? (
          <span className="font-normal normal-case tracking-normal">read-only</span>
        ) : (
          <button
            type="button"
            onClick={(): void => setDialogOpen(true)}
            className="rounded p-0.5 hover:text-text-secondary"
            aria-label="Import eval run or session"
            title="Import eval run or session"
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {expanded && (
        <div className="max-h-52 overflow-y-auto pb-1">
          {imports.length === 0 && (
            <p className="px-3 pb-1 text-xs text-text-muted">
              {readonly ? 'Nothing imported.' : 'Nothing imported yet. Use + to import a .zip.'}
            </p>
          )}
          {imports.map((entry) => {
            const id = entryId(entry);
            return (
              <ImportRow
                key={id}
                entry={entry}
                readonly={readonly}
                menuOpen={menuFor === id}
                renaming={renamingId === id}
                onToggleMenu={(): void => setMenuFor((current) => (current === id ? null : id))}
                onCloseMenu={(): void => setMenuFor(null)}
                onOpen={(): void => void run(() => openImport(id))}
                onStartRename={(): void => setRenamingId(id)}
                onRename={(name): void => {
                  setRenamingId(null);
                  void run(() => renameImport(id, name));
                }}
                onCancelRename={(): void => setRenamingId(null)}
                onDelete={(): void => void onDelete(entry)}
              />
            );
          })}
          {actionError && (
            <p role="alert" className="px-3 pt-1 text-xs text-red-400">
              {actionError}
            </p>
          )}
        </div>
      )}

      {dialogOpen && <ImportDialog onClose={(): void => setDialogOpen(false)} />}
    </div>
  );
};

interface ImportRowProps {
  entry: ImportListEntry;
  readonly: boolean;
  menuOpen: boolean;
  renaming: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onOpen: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}

const ImportRow = ({
  entry,
  readonly,
  menuOpen,
  renaming,
  onToggleMenu,
  onCloseMenu,
  onOpen,
  onStartRename,
  onRename,
  onCancelRename,
  onDelete,
}: ImportRowProps): React.JSX.Element => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onCloseMenu();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCloseMenu();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen, onCloseMenu]);

  const id = entryId(entry);
  const name = entry.valid ? entry.manifest.name : id;
  const Icon = entry.valid && entry.manifest.type === 'session' ? FileText : FlaskConical;

  const copyId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(onCloseMenu, 600);
    } catch {
      onCloseMenu();
    }
  };

  return (
    <div className="group relative flex items-center gap-1 px-3 py-1 hover:bg-[var(--color-surface-raised)]">
      {renaming ? (
        <input
          autoFocus
          defaultValue={name}
          onChange={(e): void => setDraft(e.target.value)}
          onFocus={(): void => setDraft(name)}
          onKeyDown={(e): void => {
            if (e.key === 'Enter' && draft.trim()) onRename(draft.trim());
            if (e.key === 'Escape') onCancelRename();
          }}
          onBlur={onCancelRename}
          maxLength={80}
          aria-label="Import name"
          className="min-w-0 flex-1 rounded border px-1 py-0.5 text-sm outline-none"
          style={{
            backgroundColor: 'var(--color-surface)',
            borderColor: 'var(--color-border-emphasis)',
            color: 'var(--color-text)',
          }}
        />
      ) : (
        <button
          type="button"
          onClick={entry.valid ? onOpen : undefined}
          disabled={!entry.valid}
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left disabled:cursor-default"
        >
          <Icon size={13} className="mt-0.5 shrink-0 text-text-muted" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate text-sm" style={{ color: 'var(--color-text)' }}>
              {name}
              {!entry.valid && (
                <span
                  className="ml-1.5 rounded px-1 text-[10px]"
                  style={{
                    backgroundColor: 'var(--badge-error-bg)',
                    color: 'var(--badge-error-text)',
                  }}
                >
                  invalid
                </span>
              )}
              {entry.valid && entry.manifest.partial && (
                <span
                  className="ml-1.5 rounded px-1 text-[10px]"
                  style={{
                    backgroundColor: 'var(--badge-warning-bg)',
                    color: 'var(--badge-warning-text)',
                  }}
                  title={
                    entry.manifest.partialReason
                      ? `partial: ${entry.manifest.partialReason}`
                      : 'partial'
                  }
                >
                  partial
                </span>
              )}
            </span>
            <span className="block truncate text-xs text-text-muted">
              {entry.valid ? entry.manifest.summary : entry.error}
            </span>
          </span>
        </button>
      )}

      {!renaming && (entry.valid || !readonly) && (
        <button
          type="button"
          onClick={onToggleMenu}
          aria-label={`Actions for ${name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="shrink-0 rounded p-0.5 text-text-muted opacity-0 hover:text-text-secondary focus:opacity-100 group-hover:opacity-100"
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      )}

      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute right-2 top-full z-50 min-w-[140px] overflow-hidden rounded-md border py-1 shadow-lg"
          style={{
            backgroundColor: 'var(--color-surface-overlay)',
            borderColor: 'var(--color-border-emphasis)',
            color: 'var(--color-text)',
          }}
        >
          {entry.valid && !readonly && (
            <MenuButton
              label="Rename"
              onClick={(): void => {
                onCloseMenu();
                onStartRename();
              }}
            />
          )}
          {entry.valid && (
            <MenuButton
              label={copied ? 'Copied!' : 'Copy ID'}
              onClick={(): void => void copyId()}
            />
          )}
          {!readonly && (
            <MenuButton
              label="Delete"
              onClick={(): void => {
                onCloseMenu();
                onDelete();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
};

const MenuButton = ({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}): React.JSX.Element => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--color-surface-raised)]"
  >
    {label}
  </button>
);
