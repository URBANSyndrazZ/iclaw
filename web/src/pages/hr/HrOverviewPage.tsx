import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { hrApi } from './api';
import {
  EmptyState,
  HrNotice,
  HrShell,
  MetricCard,
  STAGE_LABELS,
  scoreColor,
  type HrCandidate,
  type HrJob,
  type HrJobStats,
} from './shared';

type Overview = {
  metrics: {
    activeJobs: number;
    totalCandidates: number;
    pendingTechScreen: number;
    interviewing: number;
    offerSent: number;
    talentPool: number;
    aiFailed: number;
  };
  activeJobs: Array<{ job: HrJob; stats: HrJobStats }>;
  upcomingJobs: Array<{ job: HrJob; stats: HrJobStats }>;
  expiredJobs: Array<{ job: HrJob; stats: HrJobStats }>;
  recentCandidates: HrCandidate[];
  pendingItems: Array<{
    type: 'pending_tech_screen' | 'ai_failed';
    title: string;
    detail: string;
    targetId: string;
  }>;
};

type AgentActivity = {
  id: string;
  action: string;
  targetId: string | null;
  jobId: string | null;
  jobTitle: string | null;
  candidateId: string | null;
  candidateName: string | null;
  summary: string;
  source: 'agent_runtime' | 'web' | 'system' | 'unknown';
  createdAt: string;
};

const ACTIVITY_SOURCE_LABELS: Record<AgentActivity['source'], string> = {
  agent_runtime: '聊天',
  web: '页面',
  system: '系统',
  unknown: '未标记',
};

export function HrOverviewPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [cleanupDue, setCleanupDue] = useState<HrCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      hrApi.overview<Overview>(),
      hrApi.agentActivity(),
      hrApi.listCandidates({ page: 1, pageSize: 20, cleanupDue: true }),
    ])
      .then(([overviewData, activityData, cleanupData]) => {
        if (!mounted) return;
        setOverview(overviewData.overview);
        setActivity(activityData.activity);
        setCleanupDue(cleanupData.candidates);
      })
      .catch((err) => mounted && setError(err.message));
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <HrShell
      title="工作台总览"
      description="跟踪招聘进度、AI 诊断状态和待处理事项"
      headerAction={(
        <a
          className="rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-100"
          href="/api/hr/overview/export.csv"
          download
        >
          导出 CSV
        </a>
      )}
    >
      <HrNotice error={error} />
      {!overview && !error ? (
        <div className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
          正在加载…
        </div>
      ) : overview ? (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="活跃岗位" value={overview.metrics.activeJobs} />
            <MetricCard
              label="候选人总数"
              value={overview.metrics.totalCandidates}
            />
            <MetricCard
              label="待技术初筛"
              value={overview.metrics.pendingTechScreen}
            />
            <MetricCard label="面试中" value={overview.metrics.interviewing} />
            <MetricCard label="已发 Offer" value={overview.metrics.offerSent} />
            <MetricCard label="人才库" value={overview.metrics.talentPool} />
            <MetricCard label="AI 分析失败" value={overview.metrics.aiFailed} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border bg-card p-4">
              <h3 className="font-medium">活跃岗位</h3>
              {overview.activeJobs.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  暂无活跃岗位
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {overview.activeJobs.map(({ job, stats }) => (
                    <Link
                      key={job.id}
                      to={`/hr/jobs/${job.id}`}
                      className="block rounded-xl border p-3 transition-colors hover:border-brand-300"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{job.title}</span>
                        <span className="text-sm text-muted-foreground">
                          {stats.total} 人
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        待初筛 {stats.pendingTechScreen} · 面试中{' '}
                        {stats.interviewing} · Offer {stats.offerSent}
                      </p>
                    </Link>
                  ))}
                </div>
              )}
            </section>
            <section className="rounded-2xl border bg-card p-4">
              <h3 className="font-medium">即将到期岗位</h3>
              {overview.upcomingJobs.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  未来 7 天没有到期岗位
                </p>
              ) : (
                <div className="mt-3 space-y-2">
                  {overview.upcomingJobs.map(({ job }) => (
                    <Link
                      key={job.id}
                      to={`/hr/jobs/${job.id}`}
                      className="block rounded-xl border p-3 text-sm"
                    >
                      <div className="flex justify-between">
                        <span className="font-medium">{job.title}</span>
                        <span>
                          {new Date(job.expiresAt!).toLocaleDateString('zh-CN')}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </section>
            <section className="rounded-2xl border bg-card p-4 lg:col-span-2">
              <h3 className="font-medium">已过期岗位</h3>
              {overview.expiredJobs.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  暂无已过期岗位
                </p>
              ) : (
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {overview.expiredJobs.map(({ job }) => (
                    <Link
                      key={job.id}
                      to={`/hr/jobs/${job.id}`}
                      className="block rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-sm"
                    >
                      <div className="flex justify-between">
                        <span className="font-medium">{job.title}</span>
                        <span>{job.status}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </section>
            <section className="rounded-2xl border bg-card p-4">
              <h3 className="font-medium">待处理事项</h3>
              {overview.pendingItems.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  暂无待处理事项
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {overview.pendingItems.map((item, index) => (
                    <div
                      key={`${item.type}-${item.targetId}-${index}`}
                      className="rounded-xl border p-3"
                    >
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {item.detail}
                      </p>
                      {item.type === 'pending_tech_screen' && (
                        <Link
                          className="mt-2 inline-block text-sm text-brand-600"
                          to={`/hr/candidates/${item.targetId}`}
                        >
                          查看候选人
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
          <section className="rounded-2xl border bg-card p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">最近候选人</h3>
              <Link className="text-sm text-brand-600" to="/hr/candidates">
                进入候选人中心
              </Link>
            </div>
            {overview.recentCandidates.length === 0 ? (
              <EmptyState
                title="还没有候选人"
                description="从岗位详情批量导入简历后，这里会展示最近候选人。"
              />
            ) : (
              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {overview.recentCandidates.map((candidate) => (
                  <Link
                    key={candidate.id}
                    to={`/hr/candidates/${candidate.id}`}
                    className="rounded-xl border p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate font-medium">
                        {candidate.fullName}
                      </span>
                      <span
                        className={`font-semibold ${scoreColor(candidate.overallScore)}`}
                      >
                        {candidate.overallScore ?? '—'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {STAGE_LABELS[candidate.stage]} · {candidate.source}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </section>
          <section className="rounded-2xl border bg-card p-4">
            <h3 className="font-medium">最近操作</h3>
            {activity.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                还没有阶段变更、信息更新、飞书同步或岗位生命周期操作
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {activity.map((item) => (
                  <div key={item.id} className="rounded-xl border p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate font-medium">
                        {item.summary}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                        <span className="rounded-full border bg-muted/50 px-2 py-0.5">
                          {ACTIVITY_SOURCE_LABELS[item.source]}
                        </span>
                        {new Date(item.createdAt).toLocaleString('zh-CN')}
                      </span>
                    </div>
                    {item.candidateId && (
                      <Link
                        className="mt-1 inline-block text-xs text-brand-600"
                        to={`/hr/candidates/${item.candidateId}`}
                      >
                        查看候选人
                      </Link>
                    )}
                    {item.jobId && !item.candidateId && (
                      <Link
                        className="mt-1 inline-block text-xs text-brand-600"
                        to={`/hr/jobs/${item.jobId}`}
                      >
                        查看岗位
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
          {cleanupDue.length > 0 && (
            <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <h3 className="font-medium">保留期到期候选人</h3>
              <p className="mt-1 text-sm text-amber-800">
                以下候选人已到保留期，请确认后进入候选人详情彻底删除。
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {cleanupDue.map((candidate) => (
                  <Link
                    key={candidate.id}
                    to={`/hr/candidates/${candidate.id}`}
                    className="rounded-lg border border-amber-300 bg-background px-3 py-2 text-sm"
                  >
                    {candidate.fullName}
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      ) : null}
    </HrShell>
  );
}
