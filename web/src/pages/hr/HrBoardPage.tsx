import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AI_STATUS_LABELS,
  EmptyState,
  HR_STAGES,
  HrNotice,
  HrShell,
  STAGE_LABELS,
  scoreColor,
  type HrCandidate,
} from './shared';
import { hrApi } from './api';

export function HrBoardPage() {
  const [candidates, setCandidates] = useState<HrCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hrApi.listCandidates()
      .then((data) => setCandidates(data.candidates))
      .catch((err) => setError(err instanceof Error ? err.message : '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  const grouped = useMemo(
    () => HR_STAGES.map((stage) => ({
      stage,
      items: candidates.filter((candidate) => candidate.stage === stage),
    })),
    [candidates],
  );

  return (
    <HrShell title="推面看板" description="按招聘阶段跟踪候选人流转">
      <HrNotice error={error} />
      {loading ? (
        <EmptyState title="加载中" description="请稍候。" />
      ) : candidates.length === 0 ? (
        <EmptyState title="暂无候选人" description="从岗位详情导入简历后开始跟踪。" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
          {grouped.map(({ stage, items }) => (
            <div key={stage} className="rounded-2xl border bg-card p-3">
              <h3 className="mb-2 text-sm font-medium">
                {STAGE_LABELS[stage]} · {items.length}
              </h3>
              <div className="space-y-2">
                {items.map((candidate) => (
                  <Link
                    key={candidate.id}
                    to={`/hr/candidates/${candidate.id}`}
                    className="block rounded-xl border border-border bg-card p-3 transition-colors hover:border-brand-300"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{candidate.fullName}</span>
                      <span className={`text-sm font-semibold ${scoreColor(candidate.overallScore)}`}>
                        {candidate.overallScore ?? '—'}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {candidate.summary || '暂无解析摘要'}
                    </p>
                    <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{STAGE_LABELS[candidate.stage]}</span>
                      <span className={candidate.aiStatus === 'failed' ? 'text-rose-600' : ''}>
                        {AI_STATUS_LABELS[candidate.aiStatus]}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </HrShell>
  );
}
