import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { hrApi } from './api';
import {
  EmptyState,
  HrNotice,
  HrPagination,
  HrShell,
  hrPaginationState,
  type HrJob,
  type HrJobStats,
  formatHrDate,
  isHrJobExpired,
} from './shared';

type JobWithStats = HrJob & { stats: HrJobStats };

export function HrJobsPage() {
  const [jobs, setJobs] = useState<JobWithStats[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [lifecycle, setLifecycle] = useState('all');
  const [form, setForm] = useState({ title: '', jdText: '', expiresAt: '' });
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await hrApi.listJobs<JobWithStats>({
      page: pagination.page,
      pageSize: pagination.pageSize,
      withStats: true,
      search,
      lifecycle,
    });
    const jobItems = Array.isArray(data.jobs) ? data.jobs : [];
    if (jobItems.length === 0 && (data.page ?? 1) > 1 && (data.total ?? 0) > 0) {
      setPagination((prev) => ({ ...prev, page: Math.min(data.total_pages, data.page - 1) }));
      return;
    }
    setJobs(jobItems);
    setPagination(hrPaginationState(data, jobItems.length));
  }, [lifecycle, pagination.page, pagination.pageSize, search]);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : '加载失败'))
      .finally(() => setLoading(false));
  }, [load]);

  function updateLifecycle(value: string) {
    setLifecycle(value);
    setPagination((prev) => ({ ...prev, page: 1 }));
  }

  function updateSearch(value: string) {
    setSearch(value);
    setPagination((prev) => ({ ...prev, page: 1 }));
  }

  function updatePage(page: number) {
    setPagination((prev) => ({ ...prev, page }));
  }

  function updatePageSize(pageSize: number) {
    setPagination((prev) => ({ ...prev, pageSize, page: 1 }));
  }

  async function createJob() {
    if (!form.title.trim() || !form.jdText.trim()) {
      setError('请填写岗位名称和 JD');
      return;
    }
    setCreating(true);
    try {
      await hrApi.createJob({
        title: form.title,
        jd_text: form.jdText,
        status: 'active',
        expires_at: form.expiresAt
          ? new Date(form.expiresAt).toISOString()
          : null,
      });
      setForm({ title: '', jdText: '', expiresAt: '' });
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setCreating(false);
    }
  }

  async function deleteJob(job: HrJob) {
    if (!window.confirm(`确认软删除岗位「${job.title}」？候选人历史会保留。`)) return;
    try {
      await hrApi.deleteJob(job.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    }
  }

  async function restoreJob(job: HrJob) {
    try {
      await hrApi.restoreJob(job.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复失败');
    }
  }

  return (
    <HrShell title="岗位库" description="管理 JD、招聘状态和岗位级候选人统计">
      <HrNotice error={error} />
      <section className="mb-5 rounded-2xl border bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <input
            className="rounded-lg border bg-background p-2 text-sm"
            placeholder="搜索岗位或部门"
            value={search}
          onChange={(event) => updateSearch(event.target.value)}
        />
          <select className="rounded-lg border bg-background p-2 text-sm" value={lifecycle} onChange={(event) => updateLifecycle(event.target.value)}>
            <option value="all">全部状态</option>
            <option value="active">招聘中</option>
            <option value="paused">暂停</option>
            <option value="closed">已关闭</option>
            <option value="expired">已过期</option>
            <option value="deleted">已删除</option>
          </select>
        </div>
      </section>
      <section className="mb-5 rounded-2xl border bg-card p-4">
        <h3 className="font-medium">新建岗位</h3>
        <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_2fr_auto]">
          <input className="rounded-lg border bg-background p-2 text-sm" placeholder="岗位名称" value={form.title} onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))} />
          <textarea className="min-h-[88px] rounded-lg border bg-background p-2 text-sm" placeholder="粘贴 JD 文本" value={form.jdText} onChange={(event) => setForm((prev) => ({ ...prev, jdText: event.target.value }))} />
          <input
            className="rounded-lg border bg-background p-2 text-sm"
            type="datetime-local"
            aria-label="招聘截止时间"
            value={form.expiresAt}
            onChange={(event) => setForm((prev) => ({ ...prev, expiresAt: event.target.value }))}
          />
          <button className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60" onClick={() => void createJob()} disabled={creating}>
            {creating ? '创建中…' : '创建岗位'}
          </button>
        </div>
      </section>
        <div className="min-h-[320px]">
          {jobs.length === 0 && !loading ? (
            <EmptyState title="没有匹配数据" description="创建岗位或调整搜索条件。" />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {jobs.map((job) => (
            <Link key={job.id} to={`/hr/jobs/${job.id}`} className="rounded-2xl border bg-card p-4 transition-colors hover:border-brand-300">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{job.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {job.department || '未设置部门'} · {job.location || '未设置地点'}
                  </p>
                </div>
                <span className={`rounded-full px-2 py-1 text-xs ${job.deletedAt ? 'bg-rose-100 text-rose-700' : isHrJobExpired(job) ? 'bg-amber-100 text-amber-700' : 'bg-muted'}`}>
                  {job.deletedAt ? '已删除' : isHrJobExpired(job) ? '已过期' : job.status}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">截止：{formatHrDate(job.expiresAt)}</p>
              <div className="mt-4 grid grid-cols-4 gap-2 text-center text-xs">
                <div className="rounded-lg bg-muted/40 p-2"><strong className="block text-base">{job.stats.total}</strong>候选人</div>
                <div className="rounded-lg bg-muted/40 p-2"><strong className="block text-base">{job.stats.pendingTechScreen}</strong>待初筛</div>
                <div className="rounded-lg bg-muted/40 p-2"><strong className="block text-base">{job.stats.interviewing}</strong>面试中</div>
                <div className="rounded-lg bg-muted/40 p-2"><strong className="block text-base">{job.stats.offerSent}</strong>Offer</div>
              </div>
              <div className="mt-3 flex gap-2">
                {job.deletedAt ? (
                  <button className="rounded-lg border px-2 py-1 text-xs" onClick={(event) => { event.preventDefault(); void restoreJob(job); }}>恢复</button>
                ) : (
                  <button className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-700" onClick={(event) => { event.preventDefault(); void deleteJob(job); }}>软删除</button>
                )}
              </div>
            </Link>
              ))}
            </div>
          )}
          <HrPagination
            page={pagination.page}
            pageSize={pagination.pageSize}
            total={pagination.total}
            totalPages={pagination.totalPages}
            disabled={loading}
            onPageChange={updatePage}
            onPageSizeChange={updatePageSize}
          />
        </div>
    </HrShell>
  );
}
