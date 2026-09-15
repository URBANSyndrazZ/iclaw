import type {
  HrAnalysisJob,
  HrCandidate,
  HrInterviewQuestion,
  HrInterviewRound,
  HrJob,
  HrStage,
} from './types.js';
import { HR_STAGES } from './types.js';

export interface HrJobStats {
  total: number;
  pendingTechScreen: number;
  interviewing: number;
  offerSent: number;
  closedHired: number;
  closedRejected: number;
  closedWithdrawn: number;
}

export interface HrOverview {
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
}

export interface HrStageCount {
  stage: HrStage;
  count: number;
  conversionFromPrevious: number | null;
}

export interface HrJobDiagnostic extends HrJobStats {
  job: HrJob;
  averageScore: number | null;
  aiFailed: number;
  topRisks: Array<{ reason: string; count: number }>;
}

export interface HrAnalytics {
  stageCounts: HrStageCount[];
  jobDiagnostics: HrJobDiagnostic[];
  sourceCounts: Array<{ source: string; count: number }>;
  feedbackOutcomes: Array<{ outcome: string; count: number }>;
  jdGaps: Array<{ text: string; count: number }>;
  newRequirements: Array<{ text: string; count: number }>;
  rejectionReasons: Array<{ reason: string; count: number }>;
  aiTasks: {
    total: number;
    byStatus: Array<{ status: string; count: number }>;
    byType: Array<{ type: string; count: number }>;
    failures: HrAnalysisJob[];
  };
}

export interface HrQuestionLibraryItem {
  question: HrInterviewQuestion;
  candidate: Pick<HrCandidate, 'id' | 'fullName' | 'stage'>;
  jobTitle: string;
}

function overviewCsvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function countBy<T extends string>(values: T[]): Array<{ value: T; count: number }> {
  return [...new Set(values)].map((value) => ({
    value,
    count: values.filter((item) => item === value).length,
  })).sort((left, right) => right.count - left.count);
}

export function buildOverviewExportRows(
  jobs: HrJob[],
  candidates: HrCandidate[],
  analysisJobs: HrAnalysisJob[],
): Array<{ section: string; label: string; value: string }> {
  const overview = buildOverview(jobs, candidates, analysisJobs);
  const rows: Array<{ section: string; label: string; value: string }> = [
    { section: '核心指标', label: '活跃岗位', value: String(overview.metrics.activeJobs) },
    { section: '核心指标', label: '候选人总数', value: String(overview.metrics.totalCandidates) },
    { section: '核心指标', label: '待技术初筛', value: String(overview.metrics.pendingTechScreen) },
    { section: '核心指标', label: '面试中', value: String(overview.metrics.interviewing) },
    { section: '核心指标', label: '已发 Offer', value: String(overview.metrics.offerSent) },
    { section: '核心指标', label: '人才库', value: String(overview.metrics.talentPool) },
    { section: '核心指标', label: 'AI 分析失败', value: String(overview.metrics.aiFailed) },
  ];
  for (const job of jobs) {
    const stats = buildJobStats(job.id, candidates);
    rows.push({
      section: '岗位汇总',
      label: [job.title, job.department, job.location].filter(Boolean).join(' / '),
      value: [
        `状态: ${job.status}`,
        `到期: ${job.expiresAt ?? '不限期'}`,
        `已过期: ${job.expiresAt && Date.parse(job.expiresAt) <= Date.now() ? '是' : '否'}`,
        `候选人: ${stats.total}`,
        `待初筛: ${stats.pendingTechScreen}`,
        `面试中: ${stats.interviewing}`,
        `Offer: ${stats.offerSent}`,
      ].join('；'),
    });
  }
  for (const { value, count } of countBy(analysisJobs.map((item) => item.status))) {
    rows.push({ section: 'AI 任务', label: `状态 ${value}`, value: String(count) });
  }
  for (const { value, count } of countBy(analysisJobs.map((item) => item.type))) {
    rows.push({ section: 'AI 任务', label: `类型 ${value}`, value: String(count) });
  }
  return rows;
}

export function buildOverviewExportCsv(
  jobs: HrJob[],
  candidates: HrCandidate[],
  analysisJobs: HrAnalysisJob[],
): string {
  const rows = buildOverviewExportRows(jobs, candidates, analysisJobs);
  const csv = [
    ['section', 'label', 'value'].join(','),
    ...rows.map((row) => [row.section, row.label, row.value].map(overviewCsvCell).join(',')),
  ].join('\r\n');
  return `\uFEFF${csv}`;
}

export function buildJobStats(jobId: string, candidates: HrCandidate[]): HrJobStats {
  const scoped = candidates.filter((candidate) => candidate.jobId === jobId);
  const count = (stage: HrStage) =>
    scoped.filter((candidate) => candidate.stage === stage).length;
  return {
    total: scoped.length,
    pendingTechScreen: count('pending_tech_screen'),
    interviewing: count('interview_1') + count('interview_2') + count('interview_3'),
    offerSent: count('offer_sent'),
    closedHired: count('closed_hired'),
    closedRejected: count('closed_rejected'),
    closedWithdrawn: count('closed_withdrawn'),
  };
}

export function buildOverview(
  jobs: HrJob[],
  candidates: HrCandidate[],
  analysisJobs: HrAnalysisJob[],
): HrOverview {
  const count = (stage: HrStage) =>
    candidates.filter((candidate) => candidate.stage === stage).length;
  const failedAnalyses = analysisJobs.filter((job) => job.status === 'failed');
  const pendingCandidates = candidates
    .filter((candidate) => candidate.stage === 'pending_tech_screen')
    .slice(0, 5);
  return {
    metrics: {
      activeJobs: jobs.filter((job) => job.status === 'active').length,
      totalCandidates: candidates.length,
      pendingTechScreen: count('pending_tech_screen'),
      interviewing:
        count('interview_1') + count('interview_2') + count('interview_3'),
      offerSent: count('offer_sent'),
      talentPool: candidates.filter((candidate) => candidate.talentPool).length,
      aiFailed: failedAnalyses.length,
    },
    activeJobs: jobs
      .filter((job) => job.status === 'active')
      .slice(0, 4)
      .map((job) => ({ job, stats: buildJobStats(job.id, candidates) })),
    upcomingJobs: jobs
      .filter((job) => {
        if (job.status !== 'active' || !job.expiresAt) return false;
        const expires = Date.parse(job.expiresAt);
        return (
          Number.isFinite(expires) &&
          expires > Date.now() &&
          expires <= Date.now() + 7 * 24 * 60 * 60 * 1000
        );
      })
      .slice(0, 4)
      .map((job) => ({ job, stats: buildJobStats(job.id, candidates) })),
    expiredJobs: jobs
      .filter((job) => {
        if (!job.expiresAt) return false;
        const expires = Date.parse(job.expiresAt);
        return Number.isFinite(expires) && expires <= Date.now();
      })
      .slice(0, 4)
      .map((job) => ({ job, stats: buildJobStats(job.id, candidates) })),
    recentCandidates: candidates.slice(0, 8),
    pendingItems: [
      ...pendingCandidates.map((candidate) => ({
        type: 'pending_tech_screen' as const,
        title: `${candidate.fullName} 待技术初筛`,
        detail: candidate.summary || '等待 AI 匹配结果或 HR 复核',
        targetId: candidate.id,
      })),
      ...failedAnalyses.slice(0, 5).map((job) => ({
        type: 'ai_failed' as const,
        title: `AI 任务失败：${job.type}`,
        detail: job.error || '模型输出或输入数据异常',
        targetId: job.targetId,
      })),
    ],
  };
}

function tally<T extends string>(
  values: Array<T | null | undefined>,
): Array<{ value: T; count: number }> {
  return [...new Set(values.filter((value): value is T => Boolean(value)))]
    .map((value) => ({
      value,
      count: values.filter((item) => item === value).length,
    }))
    .sort((left, right) => right.count - left.count);
}

function tallyText(values: Array<string | null | undefined>) {
  return tally(values.map((value) => value?.trim() ?? ''))
    .filter((item) => item.value)
    .map((item) => ({ text: item.value, count: item.count }));
}

export function buildAnalytics(
  jobs: HrJob[],
  candidates: HrCandidate[],
  rounds: HrInterviewRound[],
  analysisJobs: HrAnalysisJob[],
): HrAnalytics {
  const total = candidates.length || 1;
  let previous = 0;
  const stageCounts = HR_STAGES.map((stage) => {
    const value = candidates.filter((candidate) => candidate.stage === stage).length;
    const conversionFromPrevious =
      stage === HR_STAGES[0] ? null : previous === 0 ? 0 : Math.round((value / previous) * 100);
    previous = value;
    return { stage, count: value, conversionFromPrevious };
  });
  const feedbackResults = analysisJobs
    .filter((job) => job.type === 'feedback_analysis' && job.result)
    .map((job) => job.result as {
      jd_gaps?: string[];
      new_requirements?: string[];
      decision_suggestion?: string;
    });
  const jobDiagnostics = jobs.map((job) => {
    const scoped = candidates.filter((candidate) => candidate.jobId === job.id);
    const scored = scoped.filter((candidate) => candidate.overallScore !== null);
    const stats = buildJobStats(job.id, candidates);
    const riskCounts = new Map<string, number>();
    for (const candidate of scoped) {
      for (const risk of candidate.riskFlags) {
        riskCounts.set(risk, (riskCounts.get(risk) ?? 0) + 1);
      }
    }
    return {
      job,
      ...stats,
      averageScore: scored.length
        ? Math.round(
            scored.reduce((sum, candidate) => sum + (candidate.overallScore ?? 0), 0) /
              scored.length,
          )
        : null,
      aiFailed: analysisJobs.filter((jobItem) =>
        scoped.some((candidate) => candidate.id === jobItem.targetId),
      ).length,
      topRisks: [...riskCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 5),
    };
  });
  return {
    stageCounts,
    jobDiagnostics,
    sourceCounts: tally(candidates.map((candidate) => candidate.source)).map(
      ({ value, count }) => ({ source: value, count }),
    ),
    feedbackOutcomes: tally(rounds.map((round) => round.outcome ?? 'pending')).map(
      ({ value, count }) => ({ outcome: value, count }),
    ),
    jdGaps: tallyText(feedbackResults.flatMap((result) => result.jd_gaps ?? [])),
    newRequirements: tallyText(
      feedbackResults.flatMap((result) => result.new_requirements ?? []),
    ),
    rejectionReasons: tallyText(
      candidates
        .filter((candidate) => candidate.stage === 'closed_rejected')
        .flatMap((candidate) => candidate.riskFlags),
    ).map((item) => ({ reason: item.text, count: item.count })),
    aiTasks: {
      total: analysisJobs.length,
      byStatus: tally(analysisJobs.map((job) => job.status)).map(
        ({ value, count }) => ({ status: value, count }),
      ),
      byType: tally(analysisJobs.map((job) => job.type)).map(
        ({ value, count }) => ({ type: value, count }),
      ),
      failures: analysisJobs.filter((job) => job.status === 'failed').slice(0, 10),
    },
  };
}

export function buildQuestionLibrary(
  jobs: HrJob[],
  candidates: HrCandidate[],
  questions: HrInterviewQuestion[],
): HrQuestionLibraryItem[] {
  return questions
    .map((question) => {
      const candidate = candidates.find((item) => item.id === question.candidateId);
      const job = jobs.find((item) => item.id === question.jobId);
      if (!candidate || !job) return null;
      return {
        question,
        candidate: {
          id: candidate.id,
          fullName: candidate.fullName,
          stage: candidate.stage,
        },
        jobTitle: job.title,
      };
    })
    .filter((item): item is HrQuestionLibraryItem => item !== null)
    .sort(
      (left, right) =>
        new Date(right.question.createdAt).getTime() -
        new Date(left.question.createdAt).getTime(),
    );
}
