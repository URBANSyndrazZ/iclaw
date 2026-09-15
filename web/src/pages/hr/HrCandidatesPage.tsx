import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { hrApi } from './api';
import {
  EmptyState,
  HR_STAGES,
  HrNotice,
  HrPagination,
  HrShell,
  hrPaginationState,
  STAGE_LABELS,
  AI_STATUS_LABELS,
  scoreColor,
  type HrCandidate,
  type HrJob,
} from './shared';

export function HrCandidatesPage() {
  const [candidates, setCandidates] = useState<HrCandidate[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<HrJob[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [jobId, setJobId] = useState('all');
  const [stage, setStage] = useState('all');
  const [source, setSource] = useState('all');
  const [talentOnly, setTalentOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyzingIds, setAnalyzingIds] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    const jobData = await hrApi.listJobs<HrJob>({ includeDeleted: true });
    setJobs(jobData.jobs);
  }, []);

  const refreshCandidates = useCallback(async () => {
    setLoading(true);
    const data = await hrApi.listCandidates<HrCandidate>({
      page: pagination.page,
      pageSize: pagination.pageSize,
      search,
      jobId: jobId === 'all' ? undefined : jobId,
      stage: stage === 'all' ? undefined : stage,
      source: source === 'all' ? undefined : source,
      talentPool: talentOnly ? true : undefined,
    });
    const candidateItems = Array.isArray(data.candidates) ? data.candidates : [];
    if (
      candidateItems.length === 0 &&
      (data.page ?? 1) > 1 &&
      (data.total ?? 0) > 0
    ) {
      setPagination((prev) => ({
        ...prev,
        page: Math.min(data.total_pages, data.page - 1),
      }));
      return;
    }
    setCandidates(candidateItems);
    const candidateSources = Array.isArray(data.sources) && data.sources.length
      ? data.sources
      : [...new Set(candidateItems.map((item) => item.source))];
    setSources(candidateSources);
    setPagination(hrPaginationState(data, candidateItems.length));
  }, [jobId, pagination.page, pagination.pageSize, search, source, stage, talentOnly]);

  useEffect(() => {
    loadJobs().catch((err) =>
      setError(err instanceof Error ? err.message : '岗位列表加载失败'),
    );
  }, [loadJobs]);

  useEffect(() => {
    refreshCandidates().catch((err) =>
      setError(err instanceof Error ? err.message : '加载失败'),
    ).finally(() => setLoading(false));
  }, [refreshCandidates]);

  function updateFilter<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPagination((prev) => ({ ...prev, page: 1 }));
    };
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

  function updateTalentOnly(value: boolean) {
    setTalentOnly(value);
    setPagination((prev) => ({ ...prev, page: 1 }));
  }

  const filtered = candidates;

  async function analyzeCandidate(candidateId: string) {
    if (analyzingIds.includes(candidateId)) return;
    setAnalyzingIds((ids) => [...ids, candidateId]);
    setStatus('AI 分析已排队');
    try {
      await hrApi.reanalyzeCandidate(candidateId);
      await refreshCandidates();
      void pollCandidate(candidateId).catch((err) =>
        setError(err instanceof Error ? err.message : 'AI 分析状态查询失败'),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI 分析失败');
    } finally {
      setAnalyzingIds((ids) => ids.filter((id) => id !== candidateId));
    }
  }

  async function pollCandidate(candidateId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const detail = await hrApi.getCandidate(candidateId);
      const candidate = detail.candidate;
      setCandidates((items) => items.map((item) => (
        item.id === candidateId ? { ...item, ...candidate } : item
      )));
      if (!candidate || candidate.aiStatus !== 'running') {
        setStatus(
          candidate?.aiStatus === 'completed'
            ? 'AI 分析完成'
            : `AI 分析失败：${candidate?.aiError ?? '未知错误'}`,
        );
        return;
      }
    }
    setStatus('AI 分析仍在后台执行，请稍后刷新查看');
  }

  return (
    <HrShell title="候选人中心" description="集中检索、筛选和管理人才库候选人">
      <HrNotice error={error} />
      {status && (
        <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          {status}
        </div>
      )}
      <section className="mb-4 rounded-2xl border bg-card p-4">
        <div className="grid gap-3 lg:grid-cols-5">
          <input
            className="rounded-lg border bg-background p-2 text-sm"
            placeholder="搜索姓名或岗位"
            value={search}
            onChange={(event) => updateSearch(event.target.value)}
          />
          <select
            className="rounded-lg border bg-background p-2 text-sm"
            value={jobId}
              onChange={(event) => updateFilter(setJobId)(event.target.value)}
          >
            <option value="all">全部岗位</option>
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.title}
              </option>
            ))}
          </select>
          <select
            className="rounded-lg border bg-background p-2 text-sm"
            value={stage}
              onChange={(event) => updateFilter(setStage)(event.target.value)}
          >
            <option value="all">全部阶段</option>
            {HR_STAGES.map((item) => (
              <option key={item} value={item}>
                {STAGE_LABELS[item]}
              </option>
            ))}
          </select>
          <select
            className="rounded-lg border bg-background p-2 text-sm"
            value={source}
              onChange={(event) => updateFilter(setSource)(event.target.value)}
          >
            <option value="all">全部来源</option>
            {sources.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={talentOnly}
              onChange={(event) => updateTalentOnly(event.target.checked)}
            />
            仅人才库
          </label>
        </div>
      </section>
      <div className="min-h-[320px]">
        {candidates.length === 0 && !loading ? (
          <EmptyState
            title="没有匹配数据"
            description="调整筛选条件，或从岗位详情导入简历。"
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((candidate) => (
              <article
                key={candidate.id}
                className="rounded-2xl border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Link
                      to={`/hr/candidates/${candidate.id}`}
                      className="truncate font-semibold hover:text-brand-600"
                    >
                      {candidate.fullName}
                    </Link>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {jobs.find((job) => job.id === candidate.jobId)?.title ||
                        '未关联岗位'}
                    </p>
                  </div>
                  <span
                    className={`text-xl font-bold ${scoreColor(candidate.overallScore)}`}
                  >
                    {candidate.overallScore ?? '—'}
                  </span>
                </div>
                <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
                  {candidate.summary || '暂无 AI 摘要'}
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full bg-muted px-2 py-1">
                    {STAGE_LABELS[candidate.stage]}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-1">
                    {candidate.source}
                  </span>
                  {candidate.talentPool && (
                    <span className="rounded-full bg-brand-50 px-2 py-1 text-brand-700">
                      人才库
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span
                    className={`text-xs ${candidate.aiStatus === 'failed' ? 'text-rose-600' : 'text-muted-foreground'}`}
                  >
                    {AI_STATUS_LABELS[candidate.aiStatus]}
                  </span>
                  <button
                    className="rounded-lg border px-2 py-1 text-xs disabled:opacity-60"
                    disabled={
                      analyzingIds.includes(candidate.id) ||
                      candidate.aiStatus === 'running'
                    }
                    onClick={() => void analyzeCandidate(candidate.id)}
                  >
                    {analyzingIds.includes(candidate.id) ? '分析中…' : 'AI 分析'}
                  </button>
                </div>
                {candidate.aiError && (
                  <p className="mt-2 line-clamp-2 text-xs text-rose-600">
                    {candidate.aiError}
                  </p>
                )}
              </article>
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
