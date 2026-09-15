// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { HrPagination } = await import('../web/src/pages/hr/shared');

function renderPagination(onPageChange = vi.fn()) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <HrPagination
        page={1}
        pageSize={20}
        total={45}
        totalPages={3}
        onPageChange={onPageChange}
        onPageSizeChange={() => undefined}
      />,
    );
  });
  return { container, onPageChange, root };
}

describe('HR pagination controls', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('exposes selectable page options when results span multiple pages', async () => {
    const onPageChange = vi.fn();
    const { container, root } = renderPagination(onPageChange);
    const pageSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="跳转到页码"]',
    );

    expect(pageSelect).toBeTruthy();
    expect(pageSelect?.disabled).toBe(false);
    expect(pageSelect?.options).toHaveLength(3);
    expect(pageSelect?.value).toBe('1');

    await act(async () => {
      pageSelect?.dispatchEvent(new window.Event('change', { bubbles: true }));
      pageSelect!.value = '3';
      pageSelect?.dispatchEvent(new window.Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onPageChange).toHaveBeenCalledWith(3);
    act(() => root.unmount());
  });
});
