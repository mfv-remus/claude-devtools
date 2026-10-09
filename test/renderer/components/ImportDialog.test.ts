import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeMock = vi.hoisted(() => ({
  uploadImport: vi.fn(),
  openImport: vi.fn(),
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeMock) => unknown) => selector(storeMock),
}));

import { ImportDialog } from '../../../src/renderer/components/imports/ImportDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ImportDialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(ImportDialog, { onClose })));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const importButton = (): HTMLButtonElement =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Import')!;

  function pickFile(file: File): void {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('starts with Import disabled and suggests the name from the file', () => {
    expect(importButton().disabled).toBe(true);
    pickFile(new File(['x'], 'nightly-run.zip'));
    const name = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(name.value).toBe('nightly-run');
    expect(importButton().disabled).toBe(false);
  });

  it('blocks an oversized file before uploading', () => {
    const big = new File(['x'], 'big.zip');
    Object.defineProperty(big, 'size', { value: 201 * 1024 * 1024 });
    pickFile(big);
    expect(container.textContent).toContain('larger than the 200 MB limit');
    expect(importButton().disabled).toBe(true);
  });

  it('lists every problem the server reports and stays open', async () => {
    storeMock.uploadImport.mockRejectedValue(
      Object.assign(new Error('first'), { errors: ['first problem', 'second problem'] })
    );
    pickFile(new File(['x'], 'run.zip'));
    await act(async () => {
      importButton().click();
      await Promise.resolve();
    });
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('2 problems');
    expect([...alert.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'first problem',
      'second problem',
    ]);
    expect(onClose).not.toHaveBeenCalled();
    expect(importButton().disabled).toBe(false);
  });

  it('closes and opens the new import on success', async () => {
    storeMock.uploadImport.mockResolvedValue({ id: 'new-id' });
    pickFile(new File(['x'], 'run.zip'));
    await act(async () => {
      importButton().click();
      await Promise.resolve();
    });
    expect(storeMock.uploadImport).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'eval-run', name: 'run' }),
      expect.any(Object)
    );
    expect(onClose).toHaveBeenCalled();
    expect(storeMock.openImport).toHaveBeenCalledWith('new-id');
  });

  it('stays quiet when the upload is cancelled', async () => {
    storeMock.uploadImport.mockRejectedValue(
      Object.assign(new Error('Upload cancelled'), { name: 'AbortError' })
    );
    pickFile(new File(['x'], 'run.zip'));
    await act(async () => {
      importButton().click();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
