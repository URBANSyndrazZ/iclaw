import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { hrApi } from './api';
import {
  EmptyState,
  HrNotice,
  HrPagination,
  HrShell,
  hrPaginationState,
  type HrAnalysisJob,
} from './shared';

const STATUS_LABELS: Record<HrAnalysisJob['status'], string> = {
  queued: '排队中',
  running: '运行中',
  completed: '成功',
  failed: '失败',
  retrying: '重试中',
};

const TYPE_LABELS: Record<string, string> = {
  candidate_analysis: '候选人完整分析',
  resume_parse: '简历解析',
  jd_match: 'JD 匹配',
  interview_questions: '面问题生成',
  feedback_analysis: '反馈分析',
  market_analysis: '岗位诊断',
};

function formatTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

export function HrAnalysisJobsPage() {
  const [jobs, setJobs] = useState<HrAnalysisJob[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    const data = await hrApi.listAnalysisJobs({
      page: pagination.page,
      pageSize: pagination.pageSize,
      status: statusFilter || undefined,
    });
    const analysisItems = Array.isArray(data.jobs) ? data.jobs : [];
    if (
      analysisItems.length === 0 &&
      (data.page ?? 1) > 1 &&
      (data.total ?? 0) > 0
    ) {
      setPagination((prev) => ({
        ...prev,
        page: Math.min(data.total_pages, data.page - 1),
      }));
      return;
    }
    if (requestId !== requestIdRef.current) return;
    setJobs(analysisItems);
    setPagination(hrPaginationState(data, analysisItems.length));
  }, [pagination.page, pagination.pageSize, statusFilter]);

  const safeRefresh = useCallback(async () => {
    try {
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  useEffect(() => {
    void safeRefresh();
  }, [safeRefresh]);

  useEffect(() => {
    const timer = setInterval(() => {
      void safeRefresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [safeRefresh]);

  async function retry(jobId: string) {
    setRetryingId(jobId);
    setError(null);
    try {
      await hrApi.retryAnalysis(jobId);
      setMessage('任务已重新排队');
      await safeRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '重试失败');
    } finally {
      setRetryingId(null);
    }
  }

  function updateStatusFilter(value: string) {
    setStatusFilter(value);
    setPagination((prev) => ({ ...prev, page: 1 }));
  }

  function updatePage(page: number) {
    setPagination((prev) => ({ ...prev, page }));
  }

  function updatePageSize(pageSize: number) {
    setPagination((prev) => ({ ...prev, pageSize, page: 1 }));
  }

  return (
    <HrShell title="AI 任务" description="观察候选人分析的排队、重试和失败原因">
      <HrNotice error={error} />
      {message && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {message}
        </div>
      )}
      <section className="mb-4 flex flex-wrap gap-2 rounded-2xl border bg-card p-4">
        <select
          className="rounded-lg border bg-background p-2 text-sm"
          value={statusFilter}
          onChange={(event) => updateStatusFilter(event.target.value)}
        >
          <option value="">全部状态</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </section>
      <div className="min-h-[320px]">
        {jobs.length === 0 && !loading ? (
          <EmptyState title="没有匹配数据" description="上传简历并触发 AI 分析后展示任务状态。" />
        ) : (
          <div className="overflow-hidden rounded-2xl border bg-card">
          <div className="hidden bg-muted px-4 py-2 text-sm font-medium md:grid md:grid-cols-12 md:gap-3">
            <span className="md:col-span-2">状态</span>
            <span className="md:col-span-3">类型</span>
            <span className="md:col-span-2">尝试</span>
            <span className="md:col-span-2">创建时间</span>
            <span className="md:col-span-3">失败原因</span>
          </div>
          <div>
            {jobs.map((job) => (
              <div
                key={job.id}
                className="grid gap-2 border-t p-4 md:grid-cols-12 md:items-center md:gap-3"
              >
                <div className="md:col-span-2">
                  <span
                    className={`rounded-full px-2 py-1 text-xs ${
                      job.status === 'completed'
                        ? 'bg-emerald-50 text-emerald-700'
                        : job.status === 'failed'
                          ? 'bg-rose-50 text-rose-700'
                          : 'bg-blue-50 text-blue-700'
                    }`}
                  >
                    {STATUS_LABELS[job.status]}
                  </span>
                </div>
                <div className="text-sm md:col-span-3">
                  {TYPE_LABELS[job.type] ?? job.type}
                  <div className="mt-1 text-xs text-muted-foreground">
                    <Link to={`/hr/candidates/${job.targetId}`}>查看候选人</Link>
                  </div>
                </div>
                <div className="text-sm text-muted-foreground md:col-span-2">
                  {job.attempt} / {job.maxAttempt}
                </div>
                <div className="text-sm text-muted-foreground md:col-span-2">
                  {formatTime(job.createdAt)}
                </div>
                <div className="text-sm md:col-span-3">
                  <p className="line-clamp-2 text-muted-foreground">
                    {job.lastError || job.error || '—'}
                  </p>
                  {job.nextRetryAt && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      下次重试：{formatTime(job.nextRetryAt)}
                    </p>
                  )}
                </div>
                <div className="md:col-span-12 md:mt-1">
                  <button
                    className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-60"
                    disabled={retryingId === job.id || job.status === 'running'}
                    onClick={() => void retry(job.id)}
                  >
                    {retryingId === job.id ? '重试中…' : '手动重试'}
                  </button>
                </div>
              </div>
            ))}
          </div>
          </div>
        )}
        <HrPagination
          page={pagination.page}
          pageSize={pagination.pageSize}
          total={pagination.total}
          totalPages={pagination.totalPages}
          onPageChange={updatePage}
          onPageSizeChange={updatePageSize}
        />
      </div>
    </HrShell>
  );
}
