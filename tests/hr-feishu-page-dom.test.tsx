// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const { HrFeishuPage } = await import('../web/src/pages/hr/HrFeishuPage');
const { HrFeishuStatusBadge } = await import('../web/src/pages/hr/shared');

const config = {
  channel_account_id: 'account-1',
  app_token: 'bascn123',
  table_id: 'tbl123',
  field_mapping: {
    candidate_id: '候选人ID',
    full_name: '候选人',
    job_title: '岗位',
    stage: '阶段',
    score: '评分',
    recommendation: '推荐结论',
    resume_url: '简历链接',
    source: '来源',
    updated_at: '更新时间',
  },
  enabled: true,
};

const status = {
  configured: true,
  enabled: true,
  lastSyncedAt: '2026-09-08T00:00:00.000Z',
  lastStatus: 'synced' as const,
  lastError: null,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

function mockFetch(
  requests: Array<{
    url: string;
    payload: unknown;
    ok?: boolean;
    status?: number;
  }>,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = requests.find((item) => item.url === url);
    if (!match) throw new Error(`Unexpected fetch: ${url}`);
    return jsonResponse(match.payload, match.ok, match.status);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderPage() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/hr/feishu']}>
        <HrFeishuPage />
      </MemoryRouter>,
    );
  });
  await vi.waitFor(() => {
    expect(container?.textContent).toContain('飞书多维表格');
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    container!.querySelectorAll<HTMLButtonElement>('button'),
  ).find((item) => item.textContent?.includes(label));
  expect(match).toBeDefined();
  return match!;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe('HR Feishu Bitable binding page', () => {
  test('loads a Feishu account, saved config and sync status', async () => {
    const fetchMock = mockFetch([
      {
        url: '/api/channel-accounts',
        payload: {
          accounts: [
            { id: 'account-1', name: 'HR Feishu', provider: 'feishu' },
            { id: 'discord-1', name: 'Discord', provider: 'discord' },
          ],
        },
      },
      { url: '/api/hr/feishu/config', payload: { config } },
      { url: '/api/hr/feishu/status', payload: { status } },
    ]);
    await renderPage();

    const select = container!.querySelector('select')!;
    expect(select.value).toBe('account-1');
    expect(select.textContent).toContain('HR Feishu');
    expect(select.textContent).not.toContain('Discord');
    expect(container!.textContent).toContain('Bitable App Token');
    expect(container!.textContent).toContain('最近同步成功');
    expect(container!.textContent).toContain('飞书');
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
      '/api/channel-accounts',
    );
  });

  test('tests the unsaved connection and reports missing fields', async () => {
    mockFetch([
      {
        url: '/api/channel-accounts',
        payload: {
          accounts: [
            { id: 'account-1', name: 'HR Feishu', provider: 'feishu' },
          ],
        },
      },
      { url: '/api/hr/feishu/config', payload: { config } },
      { url: '/api/hr/feishu/status', payload: { status } },
      {
        url: '/api/hr/feishu/test',
        payload: {
          connected: true,
          fields: ['候选人ID', '候选人'],
          missingFields: ['岗位'],
          typeIssues: [
            { field: '推荐结论', message: '期望 文本，实际为 单选' },
          ],
        },
      },
    ]);
    await renderPage();

    await act(async () => {
      button('测试连接').click();
    });
    await vi.waitFor(() => {
      expect(container?.textContent).toContain('缺失字段：岗位');
      expect(container?.textContent).toContain(
        '推荐结论: 期望 文本，实际为 单选',
      );
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/hr/feishu/test',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('saves config and refreshes status', async () => {
    const fetchMock = mockFetch([
      {
        url: '/api/channel-accounts',
        payload: {
          accounts: [
            { id: 'account-1', name: 'HR Feishu', provider: 'feishu' },
          ],
        },
      },
      { url: '/api/hr/feishu/config', payload: { config } },
      { url: '/api/hr/feishu/status', payload: { status } },
      { url: '/api/hr/feishu/config', payload: { config } },
      { url: '/api/hr/feishu/status', payload: { status } },
    ]);
    await renderPage();

    await act(async () => {
      button('保存飞书配置').click();
    });
    await vi.waitFor(() => {
      expect(container?.textContent).toContain('配置已保存');
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/hr/feishu/config',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify(config),
      }),
    );
  });

  test('disables actions when no Feishu account is available', async () => {
    mockFetch([
      { url: '/api/channel-accounts', payload: { accounts: [] } },
      { url: '/api/hr/feishu/config', payload: { config: null } },
      {
        url: '/api/hr/feishu/status',
        payload: { status: { ...status, configured: false } },
      },
    ]);
    await renderPage();

    expect(container?.textContent).toContain('还没有可用的飞书渠道账号');
    expect(container!.textContent).not.toContain('测试连接');
  });

  test('status badge links to the binding page', async () => {
    mockFetch([{ url: '/api/hr/feishu/status', payload: { status } }]);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={['/hr']}>
          <HrFeishuStatusBadge />
        </MemoryRouter>,
      );
    });
    await vi.waitFor(() => {
      const link = container!.querySelector('a[href="/hr/feishu"]');
      expect(link?.textContent).toContain('飞书已连接');
    });
  });
});
