/**
 * ImportDialog - single-step import of an eval run or a session from a .zip.
 *
 * The server validates the archive and reports ALL problems at once; on failure the
 * dialog stays open and lists them. The 200 MB limit is pre-checked here for fast
 * feedback, but the server is the source of truth.
 */

import { useEffect, useRef, useState } from 'react';

import { useStore } from '@renderer/store';
import { IMPORT_MAX_NAME_LENGTH, IMPORT_MAX_ZIP_BYTES } from '@shared/types/imports';
import { AlertTriangle, Upload } from 'lucide-react';

import type { ImportType } from '@shared/types/imports';

interface ImportDialogProps {
  onClose: () => void;
}

const TYPE_OPTIONS: { value: ImportType; label: string; hint: string }[] = [
  {
    value: 'eval-run',
    label: 'Eval run',
    hint: 'results.json + traces/<case>/<with|without>-<N>.jsonl',
  },
  {
    value: 'session',
    label: 'Session',
    hint: '<sessionId>.jsonl, optionally <sessionId>/subagents/agent-*.jsonl',
  },
];

const MAX_MB = IMPORT_MAX_ZIP_BYTES / (1024 * 1024);

export const ImportDialog = ({ onClose }: ImportDialogProps): React.JSX.Element => {
  const uploadImport = useStore((s) => s.uploadImport);
  const openImport = useStore((s) => s.openImport);

  const [type, setType] = useState<ImportType>('eval-run');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const uploading = progress !== null;

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>('input[type="file"]')?.focus();
  }, []);

  const cancelUpload = (): void => abortRef.current?.abort();

  const close = (): void => {
    cancelUpload();
    onClose();
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close only touches refs/props
  }, []);

  const onFileChange = (picked: File | null): void => {
    setFile(picked);
    setErrors([]);
    if (picked && !nameEdited) {
      setName(picked.name.replace(/\.zip$/i, '').slice(0, IMPORT_MAX_NAME_LENGTH));
    }
    if (picked && picked.size > IMPORT_MAX_ZIP_BYTES) {
      setErrors([`The file is larger than the ${MAX_MB} MB limit`]);
    }
  };

  const canSubmit =
    !uploading &&
    file !== null &&
    file.size <= IMPORT_MAX_ZIP_BYTES &&
    name.trim().length > 0 &&
    name.trim().length <= IMPORT_MAX_NAME_LENGTH;

  const submit = async (): Promise<void> => {
    if (!file || !canSubmit) return;
    setErrors([]);
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const manifest = await uploadImport(
        { file, type, name: name.trim() },
        { onProgress: setProgress, signal: controller.signal }
      );
      onClose();
      await openImport(manifest.id);
    } catch (error) {
      setProgress(null);
      if (error instanceof Error && error.name === 'AbortError') return;
      const list = (error as { errors?: string[] }).errors;
      setErrors(
        list && list.length > 0 ? list : [error instanceof Error ? error.message : 'Import failed']
      );
    } finally {
      abortRef.current = null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        className="absolute inset-0 cursor-default"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
        onClick={close}
        aria-label="Close dialog"
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Import"
        className="relative mx-4 w-full max-w-md rounded-lg border p-6 shadow-xl"
        style={{
          backgroundColor: 'var(--color-surface-overlay)',
          borderColor: 'var(--color-border-emphasis)',
        }}
      >
        <h2 className="mb-4 text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          Import
        </h2>

        <fieldset className="mb-4" disabled={uploading}>
          <legend className="mb-1.5 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            Type
          </legend>
          <div className="space-y-1.5">
            {TYPE_OPTIONS.map((option) => (
              <div key={option.value} className="flex items-start gap-2 text-sm">
                <input
                  id={`import-type-${option.value}`}
                  type="radio"
                  name="import-type"
                  className="mt-1"
                  checked={type === option.value}
                  onChange={(): void => setType(option.value)}
                />
                <div>
                  <label
                    htmlFor={`import-type-${option.value}`}
                    className="cursor-pointer"
                    style={{ color: 'var(--color-text)' }}
                  >
                    {option.label}
                  </label>
                  <span className="block text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {option.hint}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </fieldset>

        <label className="mb-4 block text-xs" style={{ color: 'var(--color-text-secondary)' }}>
          Zip file (max {MAX_MB} MB)
          <input
            type="file"
            accept=".zip,application/zip"
            disabled={uploading}
            onChange={(e): void => onFileChange(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm"
            style={{ color: 'var(--color-text)' }}
          />
        </label>

        <label className="mb-4 block text-xs" style={{ color: 'var(--color-text-secondary)' }}>
          Name
          <input
            type="text"
            value={name}
            maxLength={IMPORT_MAX_NAME_LENGTH}
            disabled={uploading}
            onChange={(e): void => {
              setName(e.target.value);
              setNameEdited(true);
            }}
            className="mt-1 block w-full rounded border px-2 py-1.5 text-sm outline-none"
            style={{
              backgroundColor: 'var(--color-surface)',
              borderColor: 'var(--color-border-emphasis)',
              color: 'var(--color-text)',
            }}
          />
        </label>

        {uploading && (
          <div className="mb-4">
            <div
              className="h-1.5 overflow-hidden rounded"
              style={{ backgroundColor: 'var(--color-surface-raised)' }}
              role="progressbar"
              aria-valuenow={Math.round((progress ?? 0) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full bg-blue-500 transition-all"
                style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
              />
            </div>
            <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {(progress ?? 0) < 1 ? 'Uploading…' : 'Validating…'}
            </p>
          </div>
        )}

        {errors.length > 0 && (
          <div
            role="alert"
            className="mb-4 max-h-40 overflow-y-auto rounded border p-2 text-xs"
            style={{ borderColor: 'var(--color-border-emphasis)', color: 'var(--color-text)' }}
          >
            <p className="mb-1 flex items-center gap-1.5 font-medium text-red-400">
              <AlertTriangle className="size-3.5" aria-hidden="true" />
              {errors.length === 1 ? 'Cannot import' : `Cannot import (${errors.length} problems)`}
            </p>
            <ul className="list-disc space-y-0.5 pl-5">
              {errors.map((message, index) => (
                <li key={`${index}-${message}`}>{message}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={uploading ? cancelUpload : close}
            className="rounded px-3 py-1.5 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {uploading ? 'Cancel upload' : 'Cancel'}
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={(): void => void submit()}
            className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            <Upload className="size-3.5" aria-hidden="true" />
            Import
          </button>
        </div>
      </div>
    </div>
  );
};
