import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { hrApi } from './api';
import {
  defaultHrFeishuConfig,
  HrNotice,
  HrShell,
  HR_FEISHU_FIELDS,
  requestJson,
  type HrFeishuAccount,
  type HrFeishuConfigForm,
} from './shared';

type HrFeishuStatus = {
  configured: boolean;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastStatus: 'not_synced' | 'pending' | 'synced' | 'failed' | null;
  lastError: string | null;
};

type FeishuTestResult = {
  connected: boolean;
  fields: string[];
  missingFields: string[];
  typeIssues: Array<{ field: string; message: string }>;
};

const SYNC_STATUS_LABELS: Record<
  NonNullable<HrFeishuStatus['lastStatus']>,
  string
> = {
  not_synced: '未同步',
  pending: '同步中',
  synced: '最近同步成功',
  failed: '最近同步失败',
};

function mergeFeishuConfig(
  config: Partial<HrFeishuConfigForm> | null | undefined,
): HrFeishuConfigForm {
  const defaults = defaultHrFeishuConfig();
  return {
    ...defaults,
    ...config,
    field_mapping: {
      ...defaults.field_mapping,
      ...config?.field_mapping,
    },
  };
}

function formatSyncedAt(value: string | null): string {
  if (!value) return '从未同步';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function HrFeishuPage() {
  const [accounts, setAccounts] = useState<HrFeishuAccount[]>([]);
  const [config, setConfig] = useState<HrFeishuConfigForm>(
    defaultHrFeishuConfig(),
  );
  const [status, setStatus] = useState<HrFeishuStatus | null>(null);
  const [testResult, setTestResult] = useState<FeishuTestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    const [accountData, configData, statusData] = await Promise.all([
      requestJson<{ accounts: HrFeishuAccount[] }>('/api/channel-accounts'),
      hrApi.feishuConfig(),
      hrApi.feishuStatus(),
    ]);
    setAccounts(
      accountData.accounts.filter((account) => account.provider === 'feishu'),
    );
    setConfig(mergeFeishuConfig(configData.config));
    setStatus(statusData.status);
  }, []);

  useEffect(() => {
    setLoading(true);
    loadConfig()
      .then(() => setError(null))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : '加载飞书配置失败'),
      )
      .finally(() => setLoading(false));
  }, [loadConfig]);

  const canSubmit =
    accounts.length > 0 &&
    config.channel_account_id.trim().length > 0 &&
    config.app_token.trim().length > 0 &&
    config.table_id.trim().length > 0 &&
    config.field_mapping.candidate_id?.trim().length > 0;

  async function testConnection() {
    if (!canSubmit || testing) return;
    setTesting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await hrApi.testFeishuConfig(config);
      setTestResult(result);
      setSuccess(
        result.missingFields.length || result.typeIssues.length
          ? '连接成功，但请补齐或修改缺失字段映射'
          : '连接成功，字段映射完整',
      );
    } catch (err) {
      setTestResult(null);
      setSuccess(null);
      setError(err instanceof Error ? err.message : '飞书连接测试失败');
    } finally {
      setTesting(false);
    }
  }

  async function saveConfig(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || saving) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await hrApi.saveFeishuConfig(config);
      setConfig(mergeFeishuConfig(result.config));
      setTestResult(null);
      const statusData = await hrApi.feishuStatus();
      setStatus(statusData.status);
      setSuccess('飞书多维表格配置已保存');
    } catch (err) {
      setSuccess(null);
      setError(err instanceof Error ? err.message : '保存飞书配置失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <HrShell
      title="飞书多维表格"
      description="绑定 Feishu channel account 和 Bitable 表格，同步候选人人才库。"
    >
      <HrNotice error={error} />
      {success && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          {success}
        </div>
      )}
      {loading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : (
        <div className="space-y-4">
          <div className="rounded-2xl border bg-card p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  当前状态
                </p>
                <p className="mt-1 font-medium">
                  {status?.configured ? '已配置' : '未配置'}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  同步开关
                </p>
                <p className="mt-1 font-medium">
                  {status?.enabled ? '已启用' : '已停用'}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  最近同步
                </p>
                <p className="mt-1 font-medium">
                  {status?.lastStatus
                    ? SYNC_STATUS_LABELS[status.lastStatus]
                    : '未同步'}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatSyncedAt(status?.lastSyncedAt ?? null)}
                </p>
              </div>
            </div>
            {status?.lastError && (
              <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">
                {status.lastError}
              </p>
            )}
          </div>

          {accounts.length === 0 ? (
            <div className="rounded-2xl border border-dashed bg-card/50 p-6">
              <p className="font-medium">还没有可用的飞书渠道账号</p>
              <p className="mt-2 text-sm text-muted-foreground">
                请先在系统设置中创建 Feishu channel account，并保存 App ID 和
                App Secret。iclaw 不会在 HR 页面重复存储密钥。
              </p>
              <Link
                className="mt-3 inline-block text-sm text-brand-600"
                to="/settings"
              >
                前往系统设置
              </Link>
            </div>
          ) : (
            <form
              onSubmit={saveConfig}
              className="rounded-2xl border bg-card p-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="font-medium">飞书渠道账号</span>
                  <select
                    className="mt-1 w-full rounded-lg border bg-background p-2 text-sm"
                    value={config.channel_account_id}
                    onChange={(event) =>
                      setConfig((prev) => ({
                        ...prev,
                        channel_account_id: event.target.value,
                      }))
                    }
                  >
                    <option value="">选择飞书账号</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="font-medium">Bitable App Token</span>
                  <input
                    className="mt-1 w-full rounded-lg border bg-background p-2 text-sm"
                    placeholder="例如 bascn..."
                    value={config.app_token}
                    onChange={(event) =>
                      setConfig((prev) => ({
                        ...prev,
                        app_token: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="text-sm sm:col-span-2">
                  <span className="font-medium">Table ID</span>
                  <input
                    className="mt-1 w-full rounded-lg border bg-background p-2 text-sm"
                    placeholder="例如 tbl..."
                    value={config.table_id}
                    onChange={(event) =>
                      setConfig((prev) => ({
                        ...prev,
                        table_id: event.target.value,
                      }))
                    }
                  />
                </label>
              </div>

              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  onChange={(event) =>
                    setConfig((prev) => ({
                      ...prev,
                      enabled: event.target.checked,
                    }))
                  }
                />
                启用候选人同步
              </label>

              <div className="mt-4">
                <h3 className="font-medium">字段映射</h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {HR_FEISHU_FIELDS.map((field) => (
                    <label key={field.key} className="text-xs">
                      {field.label}
                      {field.key === 'candidate_id' && '（必填）'}
                      <input
                        className="mt-1 w-full rounded-lg border bg-background p-2 text-sm"
                        value={config.field_mapping[field.key] ?? ''}
                        onChange={(event) =>
                          setConfig((prev) => ({
                            ...prev,
                            field_mapping: {
                              ...prev.field_mapping,
                              [field.key]: event.target.value,
                            },
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>

              {testResult && (
                <div
                  className={`mt-4 rounded-lg border p-2 text-sm ${
                    testResult.missingFields.length ||
                    testResult.typeIssues.length
                      ? 'border-amber-300 bg-amber-50 text-amber-800'
                      : 'border-emerald-300 bg-emerald-50 text-emerald-700'
                  }`}
                >
                  {testResult.missingFields.length
                    ? `连接成功，但缺失字段：${testResult.missingFields.join('、')}`
                    : '连接成功，字段映射完整'}
                  {testResult.typeIssues.length > 0 && (
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {testResult.typeIssues.map((issue) => (
                        <li key={`${issue.field}-${issue.message}`}>
                          {issue.field}: {issue.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-lg border px-3 py-2 text-sm disabled:opacity-60"
                  disabled={!canSubmit || testing}
                  onClick={() => void testConnection()}
                >
                  {testing ? '测试中…' : '测试连接'}
                </button>
                <button
                  className="rounded-lg bg-brand-600 px-4 py-2 text-white disabled:opacity-60"
                  disabled={!canSubmit || saving}
                >
                  {saving ? '保存中…' : '保存飞书配置'}
                </button>
              </div>
              {!canSubmit && (
                <p className="mt-2 text-xs text-muted-foreground">
                  请选择飞书账号，填写 App Token、Table ID，并保留候选人 ID
                  字段映射。
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                先在飞书开放平台创建应用并授权 Bitable
                读写，再在这里选择账号、绑定表格。候选人 ID
                用于幂等更新同一条记录。
              </p>
            </form>
          )}
        </div>
      )}
    </HrShell>
  );
}
