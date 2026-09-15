import { useEffect, useState, type ReactNode } from 'react';
import { hrApi } from './api';
import { EmptyState, HrNotice, HrShell, MetricCard, STAGE_LABELS, type HrJob, type HrJobStats } from './shared';

type Analytics = {
  stageCounts: Array<{ stage: keyof typeof STAGE_LABELS; count: number; conversionFromPrevious: number | null }>;
  jobDiagnostics: Array<HrJobStats & { job: HrJob; averageScore: number | null; aiFailed: number; topRisks: Array<{ reason: string; count: number }> }>;
  sourceCounts: Array<{ source: string; count: number }>;
  feedbackOutcomes: Array<{ outcome: string; count: number }>;
  jdGaps: Array<{ text: string; count: number }>;
  newRequirements: Array<{ text: string; count: number }>;
  rejectionReasons: Array<{ reason: string; count: number }>;
  aiTasks: {
    total: number;
    byStatus: Array<{ status: string; count: number }>;
    byType: Array<{ type: string; count: number }>;
    failures: Array<{ id: string; type: string; error: string | null }>;
  };
};

function ListCard({ title, empty, children }: { title: string; empty: boolean; children?: ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card p-4">
      <h3 className="font-medium">{title}</h3>
      {empty ? <p className="mt-2 text-sm text-muted-foreground">暂无数据</p> : <div className="mt-3 space-y-2 text-sm">{children}</div>}
    </section>
  );
}

export function HrAnalyticsPage() {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hrApi.analytics<Analytics>()
      .then((data) => setAnalytics(data.analytics))
      .catch((err) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  return (
    <HrShell title="诊断看板" description="分析漏斗、JD 缺口、反馈偏差、风险和 AI 任务健康度">
      <HrNotice error={error} />
      {!analytics && !error ? (
        <div className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">正在加载…</div>
      ) : analytics ? (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="AI 任务" value={analytics.aiTasks.total} />
            <MetricCard label="失败任务" value={analytics.aiTasks.byStatus.find((item) => item.status === 'failed')?.count ?? 0} />
            <MetricCard label="反馈轮次" value={analytics.feedbackOutcomes.reduce((sum, item) => sum + item.count, 0)} />
            <MetricCard label="JD 覆盖缺口" value={analytics.jdGaps.length} />
          </div>
          <section className="rounded-2xl border bg-card p-4">
            <h3 className="font-medium">阶段漏斗</h3>
            <div className="mt-3 space-y-2">
              {analytics.stageCounts.map((item) => (
                <div key={item.stage} className="flex items-center gap-3">
                  <span className="w-24 text-sm">{STAGE_LABELS[item.stage]}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.min(100, item.count * 10)}%` }} />
                  </div>
                  <span className="w-24 text-right text-sm text-muted-foreground">
                    {item.count} 人{item.conversionFromPrevious === null ? '' : ` · ${item.conversionFromPrevious}%`}
                  </span>
                </div>
              ))}
            </div>
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <ListCard title="岗位诊断" empty={analytics.jobDiagnostics.length === 0}>
              {analytics.jobDiagnostics.map((item) => (
                <div key={item.job.id} className="rounded-xl border p-3">
                  <div className="flex items-center justify-between"><strong>{item.job.title}</strong><span>{item.averageScore ?? '—'}</span></div>
                  <p className="mt-1 text-xs text-muted-foreground">候选人 {item.total} · 失败 {item.aiFailed} · 拒绝 {item.closedRejected}</p>
                  <p className="mt-1 text-xs">{item.topRisks.map((risk) => `${risk.reason}（${risk.count}）`).join('、') || '暂无风险标记'}</p>
                </div>
              ))}
            </ListCard>
            <ListCard title="JD 覆盖缺口" empty={analytics.jdGaps.length === 0}>
              {analytics.jdGaps.map((item) => <div key={item.text}>{item.text} · {item.count} 次</div>)}
            </ListCard>
            <ListCard title="面试新增要求" empty={analytics.newRequirements.length === 0}>
              {analytics.newRequirements.map((item) => <div key={item.text}>{item.text} · {item.count} 次</div>)}
            </ListCard>
            <ListCard title="拒绝原因" empty={analytics.rejectionReasons.length === 0}>
              {analytics.rejectionReasons.map((item) => <div key={item.reason}>{item.reason} · {item.count} 次</div>)}
            </ListCard>
            <ListCard title="AI 任务状态" empty={analytics.aiTasks.byStatus.length === 0}>
              {analytics.aiTasks.byStatus.map((item) => <div key={item.status}>{item.status} · {item.count}</div>)}
            </ListCard>
            <ListCard title="最近失败原因" empty={analytics.aiTasks.failures.length === 0}>
              {analytics.aiTasks.failures.map((item) => <div key={item.id}>{item.type}: {item.error || '未知错误'}</div>)}
            </ListCard>
          </div>
        </div>
      ) : <EmptyState title="暂无诊断数据" description="导入简历并完成 AI 分析后可查看诊断。" />}
    </HrShell>
  );
}
