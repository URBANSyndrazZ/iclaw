// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const { baseNavItems } = await import('../web/src/components/layout/nav-items');
const { SettingsNav } =
  await import('../web/src/components/settings/SettingsNav');

function renderSettingsNav(
  canManageBilling: boolean,
  onTabChange: (tab: string) => void = () => undefined,
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <SettingsNav
          activeTab="profile"
          onTabChange={onTabChange}
          canManageSystemConfig
          canManageBilling={canManageBilling}
          canManageUsers
          isAdmin
          mustChangePassword={false}
        />
      </MemoryRouter>,
    );
  });
  return { container, root };
}

describe('HR-first navigation', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  test('exposes only HR workbench, HR assistant and settings in the primary nav', () => {
    expect(baseNavItems.map((item) => item.path)).toEqual([
      '/hr',
      '/chat',
      '/settings',
    ]);
    expect(baseNavItems.map((item) => item.label)).toEqual([
      'HR 工作台',
      'HR 助手',
      '设置',
    ]);
  });

  test('keeps advanced platform capabilities in the settings tab flow', () => {
    const onTabChange = vi.fn();
    const { container, root } = renderSettingsNav(true, onTabChange);
    expect(container.textContent).toContain('高级能力');
    const advancedLabels = ['智能体', '能力库', '任务', '用量', '账单'];
    expect(
      advancedLabels.every((label) =>
        Array.from(container.querySelectorAll('button')).some(
          (button) => button.textContent === label,
        ),
      ),
    ).toBe(true);
    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '能力库')
        ?.click();
    });
    expect(onTabChange).toHaveBeenCalledWith('capabilities');
    act(() => root.unmount());
  });

  test('hides billing from users without billing permission', () => {
    const { container, root } = renderSettingsNav(false);
    expect(container.textContent).not.toContain('账单');
    act(() => root.unmount());
  });
});
