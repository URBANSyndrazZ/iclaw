import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';

export const HR_STAGES = [
  'pending_tech_screen',
  'interview_1',
  'interview_2',
  'interview_3',
  'salary_discussion',
  'offer_sent',
  'closed_hired',
  'closed_rejected',
  'closed_withdrawn',
] as const;

export const STAGE_LABELS: Record<string, string> = {
  pending_tech_screen: '待技术初筛',
  interview_1: '一面',
  interview_2: '二面',
  interview_3: '三面',
  salary_discussion: '谈薪',
  offer_sent: '已发 Offer',
  closed_hired: '已入职',
  closed_rejected: '已淘汰',
  closed_withdrawn: '已放弃',
};

export type HrJob = {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  salaryRange: string | null;
  status: string;
  expiresAt: string | null;
  deletedAt: string | null;
  jdText: string;
};

export type HrJobStats = {
  total: number;
  pendingTechScreen: number;
  interviewing: number;
  offerSent: number;
  closedHired: number;
  closedRejected: number;
  closedWithdrawn: number;
};

export type HrCandidate = {
  id: string;
  jobId: string;
  fullName: string;
  source: string;
  stage: string;
  overallScore: number | null;
  overallScoreStandard?: 'legacy' | 'resume_scoring_v2';
  recommendation: string | null;
  summary: string | null;
  riskFlags: string[];
  talentPool: boolean;
  aiStatus: 'pending' | 'running' | 'completed' | 'failed';
  aiError: string | null;
  interviewer1: string | null;
  interviewer2: string | null;
  interviewer3: string | null;
  closedAt: string | null;
  retentionExpiresAt: string | null;
};

export type HrFeishuAccount = {
  id: string;
  name: string;
  provider: string;
};

export type HrFeishuConfigForm = {
  channel_account_id: string;
  app_token: string;
  table_id: string;
  field_mapping: Record<string, string>;
  enabled: boolean;
};

export const HR_FEISHU_FIELDS = [
  { key: 'candidate_id', label: '候选人ID' },
  { key: 'full_name', label: '候选人' },
  { key: 'job_title', label: '岗位' },
  { key: 'stage', label: '阶段' },
  { key: 'score', label: '评分' },
  { key: 'recommendation', label: '推荐结论' },
  { key: 'resume_url', label: '简历链接' },
  { key: 'source', label: '来源' },
  { key: 'interviewer_1', label: '一面面试官' },
  { key: 'interviewer_2', label: '二面面试官' },
  { key: 'interviewer_3', label: '三面面试官' },
  { key: 'updated_at', label: '更新时间' },
] as const;

export function defaultHrFeishuConfig(): HrFeishuConfigForm {
  return {
    channel_account_id: '',
    app_token: '',
    table_id: '',
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
}

export async function requestJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      ...(isFormData ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (payload as { error?: string }).error || '请求失败';
    throw new Error(`${message}（HTTP ${response.status}）`);
  }
  return payload as T;
}

export function scoreColor(score: number | null): string {
  if (score === null) return 'text-muted-foreground';
  if (score >= 80) return 'text-emerald-600';
  if (score >= 65) return 'text-blue-600';
  if (score >= 50) return 'text-amber-600';
  return 'text-rose-600';
}

export const AI_STATUS_LABELS: Record<HrCandidate['aiStatus'], string> = {
  pending: '待 AI 分析',
  running: 'AI 分析中',
  completed: 'AI 已分析',
  failed: 'AI 分析失败',
};

export type HrFeishuStatus = {
  configured: boolean;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastStatus: 'not_synced' | 'pending' | 'synced' | 'failed' | null;
  lastError: string | null;
};

export type HrAnalysisJob = {
  id: string;
  type: string;
  targetId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'retrying';
  attempt: number;
  maxAttempt: number;
  error: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export type HrResume = {
  id: string;
  candidateId: string;
  jobId: string | null;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  sha256: string;
  parserVersion: string;
  parseStatus: 'pending' | 'parsed' | 'failed' | 'unsupported';
  createdAt: string;
};

export type HrMatch = {
  score: number;
  fitLevel: string;
  scoreStandard?: 'legacy' | 'resume_scoring_v2';
  scoreBreakdown?: {
    weights: {
      must_have: number;
      project_fit: number;
      evidence_quality: number;
      preferred: number;
    };
    adjusted_for_experience: boolean;
    dimensions: {
      must_have_score: number;
      project_fit_score: number;
      evidence_quality_score: number;
      preferred_score: number;
      risk_penalty: number;
    };
    must_have_requirements: Array<{
      requirement: string;
      status: string;
      critical: boolean;
      evidence: string;
    }>;
    preferred_requirements: Array<{
      requirement: string;
      status: string;
      critical: boolean;
      evidence: string;
    }>;
    risks: Array<{ type: string; description: string }>;
  } | null;
  dimensionScores: Record<string, number>;
  matchedRequirements: Array<{ requirement: string; evidence: string }>;
  missingRequirements: string[];
  contradictions: string[];
  rationale: string;
};

export type HrInterviewQuestion = {
  id: string;
  category: string;
  question: string;
  rationale: string;
  expectedSignal: string;
  priority: number;
};

export type HrInterviewRound = {
  id: string;
  stage: string;
  interviewer: string | null;
  feedbackText: string;
  score: number | null;
  analysis: Record<string, unknown> | null;
  createdAt: string;
};

export type HrJobRule = {
  id: string;
  ruleVersion: number;
  status: 'draft' | 'active' | 'archived' | 'discarded';
  summary: string;
  newRequirements: string[];
  jdGaps: string[];
  contradictions: string[];
  decisionSuggestion: string | null;
  createdAt: string;
};

export type HrFeishuSync = {
  candidateId: string;
  recordId: string | null;
  status: 'pending' | 'synced' | 'failed';
  error: string | null;
  lastSyncedAt: string | null;
};

export type HrCandidateDetail = {
  candidate: HrCandidate & {
    sourceUrl: string | null;
    email: string | null;
    phone: string | null;
  };
  resumes: HrResume[];
  match: HrMatch | null;
  questions: HrInterviewQuestion[];
  rounds: HrInterviewRound[];
  analysisJobs: HrAnalysisJob[];
  feishuSyncStatus: HrFeishuSync | null;
};

export type HrResumeImportResult = {
  candidate: HrCandidate & { sourceUrl: string | null };
  resume: HrResume;
  analysisError: string | null;
  duplicate: boolean;
};

export type HrResumePreview = {
  kind: 'pdf' | 'text';
  content: string | null;
  objectUrl: string | null;
};

export function feishuStatusView(status: HrFeishuStatus): {
  label: string;
  className: string;
} {
  if (!status.configured || !status.enabled)
    return {
      label: '飞书未配置',
      className: 'border-border bg-muted text-muted-foreground',
    };
  if (status.lastStatus === 'synced')
    return {
      label: '飞书已连接',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    };
  if (status.lastStatus === 'failed')
    return {
      label: '飞书同步失败',
      className: 'border-rose-200 bg-rose-50 text-rose-700',
    };
  return {
    label: '飞书已配置待验证',
    className: 'border-amber-200 bg-amber-50 text-amber-700',
  };
}

export function HrFeishuStatusBadge() {
  const [status, setStatus] = useState<HrFeishuStatus | null>(null);
  useEffect(() => {
    let mounted = true;
    requestJson<{ status: HrFeishuStatus }>('/api/hr/feishu/status')
      .then((data) => mounted && setStatus(data.status))
      .catch(() => mounted && setStatus(null));
    return () => {
      mounted = false;
    };
  }, []);
  const view = status
    ? feishuStatusView(status)
    : {
        label: '飞书状态加载中',
        className: 'border-border bg-muted text-muted-foreground',
      };
  return (
    <Link
      to="/hr/feishu"
      title="打开飞书多维表格绑定页"
      className={`rounded-full border px-2.5 py-1 text-xs transition-colors hover:opacity-80 ${view.className}`}
    >
      {view.label}
    </Link>
  );
}

export function HrShell({
  title,
  description,
  headerAction,
  children,
}: {
  title: string;
  description: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  const navigation = [
    { to: '/hr', label: '总览', end: true },
    { to: '/hr/jobs', label: '岗位库' },
    { to: '/hr/candidates', label: '候选人' },
    { to: '/hr/questions', label: '问题库' },
    { to: '/hr/analysis-jobs', label: 'AI 任务' },
    { to: '/hr/analytics', label: '诊断' },
    { to: '/hr/feishu', label: '飞书' },
  ];
  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:px-8">
      <header className="mb-5">
        <div>
          <h1 className="text-xl font-semibold">HR Agent 工作台</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
          <div className="mt-2">
            <HrFeishuStatusBadge />
          </div>
          <div className="mt-3">
            <Link
              to="/chat"
              className="inline-flex items-center rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-100"
            >
              打开 HR 助手
            </Link>
          </div>
        </div>
        <div className="mt-5 grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside>
            <nav className="flex flex-col gap-2 lg:sticky lg:top-4">
              {navigation.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `rounded-lg border px-3 py-2 text-sm transition-colors ${
                      isActive
                        ? 'border-brand-300 bg-brand-50 text-brand-700'
                        : 'border-border bg-card hover:bg-muted/50'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </aside>
          <div>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="min-w-0 truncate text-lg font-semibold">
                {title}
              </h2>
              {headerAction && <div className="shrink-0">{headerAction}</div>}
            </div>
            {children}
          </div>
        </div>
      </header>
    </div>
  );
}

export function HrNotice({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
      {error}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-dashed bg-card/50 p-8 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

export type HrPaginationMeta = {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  has_more: boolean;
};

export function hrPaginationState(
  data: Partial<HrPaginationMeta>,
  itemCount: number,
) {
  const pageSize = data.page_size ?? 20;
  const total = data.total ?? itemCount;
  return {
    page: data.page ?? 1,
    pageSize,
    total,
    totalPages: data.total_pages ?? Math.max(1, Math.ceil(total / pageSize)),
  };
}

export function HrPagination({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
  disabled = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm">
      <span className="text-muted-foreground">共 {total} 条</span>
      <div className="flex items-center gap-2">
        <select
          aria-label="每页条数"
          className="rounded-lg border bg-background px-2 py-1.5 text-sm"
          disabled={disabled}
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
        >
          {[10, 20, 50, 100].map((size) => (
            <option key={size} value={size}>
              {size} 条 / 页
            </option>
          ))}
        </select>
        <button
          className="rounded-lg border px-3 py-1.5 transition-colors hover:bg-muted/50 disabled:opacity-50"
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          上一页
        </button>
        <span className="min-w-[5rem] text-center text-muted-foreground">
          {page} / {totalPages}
        </span>
        <select
          aria-label="跳转到页码"
          className="rounded-lg border bg-background px-2 py-1.5 text-sm"
          disabled={disabled || totalPages <= 1}
          value={Math.min(page, totalPages)}
          onChange={(event) => onPageChange(Number(event.target.value))}
        >
          {Array.from({ length: totalPages }, (_, index) => index + 1).map(
            (pageNumber) => (
              <option key={pageNumber} value={pageNumber}>
                第 {pageNumber} 页
              </option>
            ),
          )}
        </select>
        <button
          className="rounded-lg border px-3 py-1.5 transition-colors hover:bg-muted/50 disabled:opacity-50"
          disabled={disabled || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}

export function isHrJobExpired(job: Pick<HrJob, 'expiresAt'>): boolean {
  if (!job.expiresAt) return false;
  const expires = Date.parse(job.expiresAt);
  return Number.isFinite(expires) && expires <= Date.now();
}

export function formatHrDate(value: string | null): string {
  if (!value) return '不限期';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '无效时间';
  return date.toLocaleString('zh-CN', { hour12: false });
}
