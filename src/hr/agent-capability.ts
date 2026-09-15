import fs from 'node:fs/promises';
import path from 'node:path';
import { buildJobStats } from './reports.js';
import { DATA_DIR, WEB_PORT } from '../config.js';
import {
  createHrInterviewRound,
  createHrAudit,
  archiveHrJobRulesForJob,
  expireHrJobs,
  getHrCandidate,
  getHrFeishuConfig,
  getHrFeishuSync,
  getHrAnalysisJob,
  getHrJob,
  getLatestHrMatch,
  listHrCandidates,
  listHrInterviewRounds,
  listHrJobRules,
  listHrJobs,
  softDeleteHrJob,
  restoreHrJob,
  updateHrCandidate,
  updateHrJob,
} from './store.js';
import { HrFeishuError, syncCandidateToFeishu } from './feishu.js';
import { analyzeJobQuality, analyzeResumePreview } from './ai.js';
import { HrFeedbackSchema, HrJobUpdateSchema } from './schemas.js';
import {
  HrCandidateAnalysisError,
  startCandidateAnalysisWithJob,
  startHrMarketAnalysis,
  runFeedbackAnalysis,
} from './analysis-service.js';
import {
  HR_STAGE_LABELS,
  type HrAnalysisType,
  type HrCandidate,
  type HrJob,
  type HrStage,
} from './types.js';
import {
  RESUME_SCORING_VERSION,
  scoreResumeAssessment,
  type ResumeScoreBreakdown,
} from './resume-scoring.js';
import { extractFileText } from '../file-text-extractor.js';

export type HrAgentCapabilityOperation =
  | 'list_jobs'
  | 'get_job'
  | 'get_job_stats'
  | 'analyze_job'
  | 'list_candidates'
  | 'get_candidate'
  | 'search_aggregate'
  | 'start_candidate_analysis'
  | 'start_job_analysis'
  | 'get_analysis_job'
  | 'update_candidate'
  | 'list_interview_rounds'
  | 'submit_interview_feedback'
  | 'sync_candidate_to_feishu'
  | 'update_job'
  | 'analyze_resume_preview'
  | 'delete_job'
  | 'restore_job';

export const HR_AGENT_OPERATIONS = new Set<HrAgentCapabilityOperation>([
  'list_jobs',
  'get_job',
  'get_job_stats',
  'analyze_job',
  'list_candidates',
  'get_candidate',
  'search_aggregate',
  'start_candidate_analysis',
  'start_job_analysis',
  'get_analysis_job',
  'update_candidate',
  'list_interview_rounds',
  'submit_interview_feedback',
  'sync_candidate_to_feishu',
  'update_job',
  'analyze_resume_preview',
  'delete_job',
  'restore_job',
]);

export class HrAgentCapabilityError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function isHrJobExpired(
  job: Pick<HrJob, 'expiresAt'>,
  now = new Date(),
): boolean {
  if (!job.expiresAt) return false;
  const expires = Date.parse(job.expiresAt);
  return Number.isFinite(expires) && expires <= now.getTime();
}

export function jobLifecycleSummary(job: HrJob) {
  return {
    id: job.id,
    title: job.title,
    department: job.department,
    location: job.location,
    level: job.level,
    salaryRange: job.salaryRange,
    status: job.status,
    expiresAt: job.expiresAt,
    expired: isHrJobExpired(job),
    deleted: Boolean(job.deletedAt),
  };
}

function jobDetail(job: HrJob) {
  return {
    ...jobLifecycleSummary(job),
    jdText: job.jdText,
    keywords: job.keywords,
    responsibilities: job.responsibilities,
    requirements: job.requirements,
    preferred: job.preferred,
    techStack: job.techStack,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function jobRuleSummary(rule: ReturnType<typeof listHrJobRules>[number]) {
  return {
    id: rule.id,
    ruleVersion: rule.ruleVersion,
    status: rule.status,
    summary: rule.summary,
    newRequirements: rule.newRequirements,
    jdGaps: rule.jdGaps,
    contradictions: rule.contradictions,
    decisionSuggestion: rule.decisionSuggestion,
    createdAt: rule.createdAt,
    reviewedAt: rule.reviewedAt,
  };
}

function candidateSummary(job: HrJob | undefined, candidate: HrCandidate) {
  return {
    id: candidate.id,
    fullName: candidate.fullName,
    jobId: candidate.jobId,
    jobTitle: job?.title ?? null,
    stage: candidate.stage,
    stageLabel: HR_STAGE_LABELS[candidate.stage],
    talentPool: candidate.talentPool,
    score: candidate.overallScore,
    scoreStandard: candidate.overallScoreStandard,
    recommendation: candidate.recommendation,
    summary: sanitizeAgentSummary(candidate.summary),
    aiStatus: candidate.aiStatus,
    aiFailed: candidate.aiStatus === 'failed',
    updatedAt: candidate.updatedAt,
  };
}

const HR_AGENT_EMAIL_PATTERN = /[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
const HR_AGENT_PHONE_PATTERN = /(?<!\d)\d{7,}(?!\d)/g;

export function sanitizeAgentSummary(
  summary: string | null | undefined,
): string | null {
  if (!summary) return null;
  return summary
    .replace(HR_AGENT_EMAIL_PATTERN, '[联系方式已脱敏]')
    .replace(HR_AGENT_PHONE_PATTERN, '[联系方式已脱敏]');
}

function sanitizeScoreBreakdown(
  breakdown: ResumeScoreBreakdown,
): ResumeScoreBreakdown {
  const sanitizeAssessment = (
    item: ResumeScoreBreakdown['must_have_requirements'][number],
  ) => ({
    ...item,
    evidence: sanitizeAgentSummary(item.evidence) ?? '',
  });
  return {
    ...breakdown,
    must_have_requirements:
      breakdown.must_have_requirements.map(sanitizeAssessment),
    preferred_requirements:
      breakdown.preferred_requirements.map(sanitizeAssessment),
    risks: breakdown.risks.map((risk) => ({
      ...risk,
      description: sanitizeAgentSummary(risk.description) ?? risk.description,
    })),
    rationale: sanitizeAgentSummary(breakdown.rationale) ?? breakdown.rationale,
  };
}

function listJobs(
  ownerUserId: string,
  params: { status?: string; search?: string; limit?: number } = {},
) {
  const search = params.search?.trim().toLowerCase();
  const jobs = listHrJobs(ownerUserId)
    .filter((job) => !params.status || job.status === params.status)
    .filter(
      (job) =>
        !search ||
        job.title.toLowerCase().includes(search) ||
        (job.department ?? '').toLowerCase().includes(search) ||
        (job.location ?? '').toLowerCase().includes(search),
    )
    .slice(0, Math.min(params.limit ?? 50, 100))
    .map((job) => ({
      ...jobLifecycleSummary(job),
      candidateCount: listHrCandidates(ownerUserId, {
        jobId: job.id,
        limit: 500,
      }).length,
    }));
  return { jobs };
}

function resolveCandidatesByName(
  ownerUserId: string,
  fullName: string,
  jobId?: string | null,
) {
  const name = fullName.trim().toLowerCase();
  return listHrCandidates(ownerUserId, {
    jobId: jobId || undefined,
    limit: 500,
  }).filter((candidate) => candidate.fullName.trim().toLowerCase() === name);
}

function resolveCandidateForTool(
  ownerUserId: string,
  params: Record<string, unknown>,
):
  | HrCandidate
  | {
      status: 'requires_confirmation';
      reason: 'multiple_candidates';
      candidates: ReturnType<typeof candidateSummary>[];
    } {
  const candidateId =
    typeof params.candidate_id === 'string' ? params.candidate_id : null;
  const fullName =
    typeof params.full_name === 'string' ? params.full_name : null;
  const jobId = typeof params.job_id === 'string' ? params.job_id : null;
  if (candidateId) return requireCandidate(ownerUserId, candidateId);
  if (!fullName) {
    throw new HrAgentCapabilityError(
      'candidate_selector_required',
      'Provide candidate_id or full_name',
    );
  }
  const resolved = resolveCandidatesByName(ownerUserId, fullName, jobId);
  if (resolved.length === 0) {
    throw new HrAgentCapabilityError(
      'candidate_not_found',
      'Candidate not found',
    );
  }
  if (resolved.length > 1) {
    return {
      status: 'requires_confirmation',
      reason: 'multiple_candidates',
      candidates: resolved.map((item) =>
        candidateSummary(getHrJob(ownerUserId, item.jobId), item),
      ),
    };
  }
  return resolved[0]!;
}

function analysisJobSummary(
  ownerUserId: string,
  analysis: NonNullable<ReturnType<typeof getHrAnalysisJob>>,
) {
  const isCandidate = analysis.type === 'candidate_analysis';
  const isMarket = analysis.type === 'market_analysis';
  if (!isCandidate && !isMarket) {
    throw new HrAgentCapabilityError(
      'analysis_job_not_trackable',
      'Only candidate and market analysis jobs can be tracked',
    );
  }
  const candidate = isCandidate
    ? getHrCandidate(ownerUserId, analysis.targetId)
    : undefined;
  const job = getHrJob(ownerUserId, analysis.targetId);
  const result = analysis.result as { summary?: string } | null | undefined;
  return {
    id: analysis.id,
    type: analysis.type,
    status: analysis.status,
    attempt: analysis.attempt,
    maxAttempt: analysis.maxAttempt,
    error: analysis.error,
    lastError: analysis.lastError,
    nextRetryAt: analysis.nextRetryAt,
    startedAt: analysis.startedAt,
    finishedAt: analysis.finishedAt,
    createdAt: analysis.createdAt,
    candidate: candidate
      ? candidateSummary(getHrJob(ownerUserId, candidate.jobId), candidate)
      : null,
    job: isMarket && job ? jobLifecycleSummary(job) : null,
    resultSummary:
      analysis.status === 'completed' && typeof result?.summary === 'string'
        ? { summary: result.summary }
        : null,
  };
}

function requireCandidate(
  ownerUserId: string,
  candidateId: string,
): HrCandidate {
  const candidate = getHrCandidate(ownerUserId, candidateId);
  if (!candidate) {
    throw new HrAgentCapabilityError(
      'candidate_not_found',
      'Candidate not found',
    );
  }
  return candidate;
}

function requireJob(ownerUserId: string, jobId: string): HrJob {
  const job = getHrJob(ownerUserId, jobId);
  if (!job || job.deletedAt) {
    throw new HrAgentCapabilityError('job_not_found', 'Job not found');
  }
  return job;
}

function candidateDetail(ownerUserId: string, candidateId: string) {
  const candidate = requireCandidate(ownerUserId, candidateId);
  const job = getHrJob(ownerUserId, candidate.jobId);
  const match = getLatestHrMatch(ownerUserId, candidate.id);
  return {
    candidate: candidateSummary(job, candidate),
    job: job ? jobLifecycleSummary(job) : null,
    match: match
      ? {
          score: match.score,
          fitLevel: match.fitLevel,
          rationale: match.rationale,
          matchedRequirements: match.matchedRequirements,
          missingRequirements: match.missingRequirements,
          contradictions: match.contradictions,
          scoreStandard: match.scoreStandard,
          scoreBreakdown: match.scoreBreakdown
            ? sanitizeScoreBreakdown(match.scoreBreakdown)
            : null,
        }
      : null,
    interviewRounds: listHrInterviewRounds(ownerUserId, candidate.id)
      .slice(0, 10)
      .map((round) => ({
        stage: round.stage,
        stageLabel: HR_STAGE_LABELS[round.stage],
        interviewer: round.interviewer,
        scheduledAt: round.scheduledAt,
        completedAt: round.completedAt,
        outcome: round.outcome,
        score: round.score,
        createdAt: round.createdAt,
      })),
    feishuSync: getHrFeishuSync(ownerUserId, candidate.id)
      ? {
          status: getHrFeishuSync(ownerUserId, candidate.id)!.status,
          recordId: getHrFeishuSync(ownerUserId, candidate.id)!.recordId,
          lastSyncedAt: getHrFeishuSync(ownerUserId, candidate.id)!
            .lastSyncedAt,
          error: getHrFeishuSync(ownerUserId, candidate.id)!.error,
        }
      : null,
    piiNote: '联系方式和简历全文不通过 Agent 返回；请在候选人详情页查看。',
  };
}

function jobStats(ownerUserId: string, jobId: string) {
  const job = requireJob(ownerUserId, jobId);
  const candidates = listHrCandidates(ownerUserId, {
    jobId: job.id,
    limit: 500,
  });
  return {
    job: jobLifecycleSummary(job),
    stats: buildJobStats(job.id, candidates),
    aiStatusCounts: {
      pending: candidates.filter((item) => item.aiStatus === 'pending').length,
      running: candidates.filter((item) => item.aiStatus === 'running').length,
      completed: candidates.filter((item) => item.aiStatus === 'completed')
        .length,
      failed: candidates.filter((item) => item.aiStatus === 'failed').length,
    },
  };
}

function searchAggregate(ownerUserId: string, params: Record<string, unknown>) {
  const query =
    typeof params.query === 'string' ? params.query.trim().toLowerCase() : '';
  if (!query) {
    throw new HrAgentCapabilityError('query_required', 'query is required');
  }
  const scope = typeof params.scope === 'string' ? params.scope : 'all';
  if (!['all', 'jobs', 'candidates'].includes(scope)) {
    throw new HrAgentCapabilityError('invalid_scope', 'Invalid search scope');
  }
  const jobId = typeof params.job_id === 'string' ? params.job_id : null;
  const stage = typeof params.stage === 'string' ? params.stage : undefined;
  const talentPool =
    typeof params.talent_pool === 'boolean' ? params.talent_pool : undefined;
  const limit = Math.min(
    Math.max(
      typeof params.limit === 'number' && Number.isInteger(params.limit)
        ? params.limit
        : 20,
      1,
    ),
    50,
  );
  const includeJobs = scope === 'all' || scope === 'jobs';
  const includeCandidates = scope === 'all' || scope === 'candidates';
  const jobMatches = includeJobs
    ? listHrJobs(ownerUserId)
        .filter((job) => !jobId || job.id === jobId)
        .filter((job) =>
          [
            job.title,
            job.department,
            job.location,
            job.level,
            job.salaryRange,
          ].some((value) => value?.toLowerCase().includes(query)),
        )
    : [];
  const candidateJobs = new Map(
    listHrJobs(ownerUserId).map((job) => [job.id, job]),
  );
  const candidates = includeCandidates
    ? listHrCandidates(ownerUserId, {
        jobId: jobId || undefined,
        stage,
        talentPool,
        limit: 500,
      })
        .filter((candidate) => {
          const jobTitle = candidateJobs.get(candidate.jobId)?.title;
          return [
            candidate.fullName,
            jobTitle,
            candidate.summary,
            candidate.recommendation,
          ].some((value) => value?.toLowerCase().includes(query));
        })
        .map((candidate) =>
          candidateSummary(candidateJobs.get(candidate.jobId), candidate),
        )
    : [];
  const jobs = jobMatches.map((job) => ({
    ...jobLifecycleSummary(job),
    candidateCount: listHrCandidates(ownerUserId, {
      jobId: job.id,
      limit: 500,
    }).length,
  }));
  return {
    query,
    scope,
    jobs: jobs.slice(0, limit),
    candidates: candidates.slice(0, limit),
    totals: {
      jobs: jobs.length,
      candidates: candidates.length,
    },
    truncated: jobs.length > limit || candidates.length > limit,
  };
}

function feedbackSummary(round: {
  id: string;
  stage: HrStage;
  interviewer: string | null;
  scheduledAt: string | null;
  completedAt: string | null;
  outcome: string | null;
  score: number | null;
  feedbackText: string;
  createdAt: string;
}) {
  return {
    id: round.id,
    stage: round.stage,
    stageLabel: HR_STAGE_LABELS[round.stage],
    interviewer: round.interviewer,
    scheduledAt: round.scheduledAt,
    completedAt: round.completedAt,
    outcome: round.outcome,
    score: round.score,
    feedbackPreview:
      round.feedbackText.length > 240
        ? `${round.feedbackText.slice(0, 240)}...`
        : round.feedbackText,
    createdAt: round.createdAt,
  };
}

function jobInformation(ownerUserId: string, jobId: string) {
  const job = requireJob(ownerUserId, jobId);
  const candidates = listHrCandidates(ownerUserId, {
    jobId: job.id,
    limit: 500,
  });
  const rules = listHrJobRules(ownerUserId, job.id)
    .filter((rule) => rule.status !== 'discarded')
    .slice(0, 10)
    .map(jobRuleSummary);
  return {
    job: jobDetail(job),
    stats: buildJobStats(job.id, candidates),
    aiStatusCounts: {
      pending: candidates.filter((item) => item.aiStatus === 'pending').length,
      running: candidates.filter((item) => item.aiStatus === 'running').length,
      completed: candidates.filter((item) => item.aiStatus === 'completed')
        .length,
      failed: candidates.filter((item) => item.aiStatus === 'failed').length,
    },
    rules,
  };
}

async function syncCandidate(
  ownerUserId: string,
  candidateId: string,
  baseUrl: string,
) {
  const config = getHrFeishuConfig(ownerUserId);
  if (!config?.enabled) return { attempted: false, error: null };
  try {
    const result = await syncCandidateToFeishu({
      ownerUserId,
      actorId: ownerUserId,
      candidateId,
      baseUrl,
    });
    createHrAudit({
      ownerUserId,
      actorId: ownerUserId,
      action: 'feishu_synced',
      targetType: 'candidate',
      targetId: candidateId,
      detail: { record_id: result.recordId, source: 'agent_runtime' },
    });
    return {
      attempted: true,
      synced: result.synced,
      recordId: result.recordId,
      error: null,
    };
  } catch (error) {
    return {
      attempted: true,
      synced: false,
      recordId: null,
      error:
        error instanceof HrFeishuError ? error.message : 'Feishu sync failed',
    };
  }
}

function jdTextChanged(previous: HrJob, next: HrJob): boolean {
  return previous.jdText !== next.jdText;
}

const HR_JOB_UPDATE_PARAMS = [
  'title',
  'department',
  'location',
  'level',
  'salary_range',
  'jd_text',
  'keywords',
  'responsibilities',
  'requirements',
  'preferred',
  'tech_stack',
] as const;

async function updateJobFromAgent(
  ownerUserId: string,
  params: Record<string, unknown>,
  jobId: string,
  baseUrl: string,
) {
  if (params.confirmed !== true) {
    throw new HrAgentCapabilityError(
      'confirmation_required',
      'Job updates require explicit confirmation',
    );
  }
  const expectedUpdatedAt =
    typeof params.expected_updated_at === 'string'
      ? params.expected_updated_at
      : null;
  if (!expectedUpdatedAt) {
    throw new HrAgentCapabilityError(
      'expected_updated_at_required',
      'expected_updated_at is required to prevent concurrent overwrites',
    );
  }
  for (const key of ['status', 'expires_at', 'deleted_at', 'deleted_by']) {
    if (params[key] !== undefined) {
      throw new HrAgentCapabilityError(
        'unsupported_field',
        `${key} cannot be updated by the Agent`,
      );
    }
  }

  const job = requireJob(ownerUserId, jobId);
  if (job.updatedAt !== expectedUpdatedAt) {
    throw new HrAgentCapabilityError(
      'job_version_conflict',
      'Job was modified after it was read',
    );
  }

  const patchInput = Object.fromEntries(
    HR_JOB_UPDATE_PARAMS.filter((key) => params[key] !== undefined).map(
      (key) => [key, params[key]],
    ),
  );
  const parsed = HrJobUpdateSchema.safeParse(patchInput);
  if (!parsed.success) {
    throw new HrAgentCapabilityError(
      'invalid_job_patch',
      'Invalid job update fields',
      parsed.error.format(),
    );
  }
  const data = parsed.data;
  const patch: Parameters<typeof updateHrJob>[2] = {};
  if (patchInput.title !== undefined && data.title !== undefined)
    patch.title = data.title;
  if (patchInput.department !== undefined && data.department !== undefined)
    patch.department = data.department ?? null;
  if (patchInput.location !== undefined && data.location !== undefined)
    patch.location = data.location ?? null;
  if (patchInput.level !== undefined && data.level !== undefined)
    patch.level = data.level ?? null;
  if (patchInput.salary_range !== undefined && data.salary_range !== undefined)
    patch.salaryRange = data.salary_range ?? null;
  if (patchInput.jd_text !== undefined && data.jd_text !== undefined)
    patch.jdText = data.jd_text;
  if (patchInput.keywords !== undefined && data.keywords !== undefined)
    patch.keywords = data.keywords;
  if (
    patchInput.responsibilities !== undefined &&
    data.responsibilities !== undefined
  )
    patch.responsibilities = data.responsibilities;
  if (patchInput.requirements !== undefined && data.requirements !== undefined)
    patch.requirements = data.requirements;
  if (patchInput.preferred !== undefined && data.preferred !== undefined)
    patch.preferred = data.preferred;
  if (patchInput.tech_stack !== undefined && data.tech_stack !== undefined)
    patch.techStack = data.tech_stack;
  if (Object.keys(patch).length === 0) {
    throw new HrAgentCapabilityError(
      'patch_required',
      'No job fields to update',
    );
  }

  const updated = updateHrJob(ownerUserId, job.id, patch);
  if (!updated) {
    throw new HrAgentCapabilityError('job_not_found', 'Job not found');
  }
  const jdChanged = jdTextChanged(job, updated);
  if (jdChanged) {
    archiveHrJobRulesForJob(ownerUserId, job.id);
  }
  const titleChanged = job.title !== updated.title;
  const feishuSync = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    errors: [] as string[],
  };
  if (titleChanged) {
    let offset = 0;
    while (true) {
      const candidates = listHrCandidates(ownerUserId, {
        jobId: job.id,
        limit: 500,
        offset,
      });
      for (const candidate of candidates) {
        const sync = await syncCandidate(ownerUserId, candidate.id, baseUrl);
        if (!sync.attempted) continue;
        feishuSync.attempted += 1;
        if (sync.error) {
          feishuSync.failed += 1;
          feishuSync.errors.push(`${candidate.id}: ${sync.error}`);
        } else {
          feishuSync.succeeded += 1;
        }
      }
      if (candidates.length < 500) break;
      offset += candidates.length;
    }
  }
  createHrAudit({
    ownerUserId,
    actorId: ownerUserId,
    action: 'job_updated',
    targetType: 'job',
    targetId: job.id,
    detail: {
      fields: Object.keys(patchInput),
      title_changed: titleChanged,
      jd_changed: jdChanged,
      feishu_sync: feishuSync,
      source: 'agent_runtime',
    },
  });
  return {
    status: 'updated',
    job: jobDetail(updated),
    fields: Object.keys(patchInput),
    oldTitle: job.title,
    newTitle: updated.title,
    titleChanged,
    jdChanged,
    auditAction: 'job_updated',
    feishuSync,
  };
}

export async function executeHrAgentCapability(
  ownerUserId: string,
  operation: string,
  params: Record<string, unknown>,
  baseUrl: string,
): Promise<Record<string, unknown>> {
  if (!ownerUserId) {
    throw new HrAgentCapabilityError('not_found', 'Candidate not found');
  }
  if (!HR_AGENT_OPERATIONS.has(operation as HrAgentCapabilityOperation)) {
    throw new HrAgentCapabilityError(
      'unknown_operation',
      'Unknown HR operation',
    );
  }

  const candidateId =
    typeof params.candidate_id === 'string' ? params.candidate_id : null;
  const fullName =
    typeof params.full_name === 'string' ? params.full_name : null;
  const jobId = typeof params.job_id === 'string' ? params.job_id : null;

  switch (operation as HrAgentCapabilityOperation) {
    case 'list_jobs':
      return listJobs(ownerUserId, {
        status: typeof params.status === 'string' ? params.status : undefined,
        search: typeof params.search === 'string' ? params.search : undefined,
        limit: typeof params.limit === 'number' ? params.limit : undefined,
      });

    case 'get_job': {
      if (!jobId) {
        throw new HrAgentCapabilityError(
          'job_id_required',
          'job_id is required',
        );
      }
      return jobInformation(ownerUserId, jobId);
    }

    case 'get_job_stats': {
      if (!jobId) {
        throw new HrAgentCapabilityError(
          'job_id_required',
          'job_id is required',
        );
      }
      return jobStats(ownerUserId, jobId);
    }

    case 'analyze_job': {
      if (!jobId) {
        throw new HrAgentCapabilityError(
          'job_id_required',
          'job_id is required',
        );
      }
      const job = requireJob(ownerUserId, jobId);
      const analysis = await analyzeJobQuality(job);
      createHrAudit({
        ownerUserId,
        actorId: ownerUserId,
        action: 'job_analyzed',
        targetType: 'job',
        targetId: job.id,
        detail: {
          quality_score: analysis.quality_score,
          source: 'agent_runtime',
        },
      });
      return {
        status: 'analyzed',
        job: jobLifecycleSummary(job),
        analysis,
      };
    }

    case 'list_candidates': {
      const candidates = listHrCandidates(ownerUserId, {
        jobId: jobId || undefined,
        stage: typeof params.stage === 'string' ? params.stage : undefined,
        talentPool:
          typeof params.talent_pool === 'boolean'
            ? params.talent_pool
            : undefined,
        search: typeof params.search === 'string' ? params.search : undefined,
        limit: typeof params.limit === 'number' ? params.limit : undefined,
      }).map((candidate) =>
        candidateSummary(getHrJob(ownerUserId, candidate.jobId), candidate),
      );
      return { candidates };
    }

    case 'get_candidate': {
      if (candidateId) return candidateDetail(ownerUserId, candidateId);
      if (fullName) {
        const resolved = resolveCandidatesByName(ownerUserId, fullName, jobId);
        if (resolved.length === 0) {
          throw new HrAgentCapabilityError(
            'candidate_not_found',
            'Candidate not found',
          );
        }
        if (resolved.length > 1) {
          return {
            status: 'requires_confirmation',
            reason: 'multiple_candidates',
            candidates: resolved.map((candidate) =>
              candidateSummary(
                getHrJob(ownerUserId, candidate.jobId),
                candidate,
              ),
            ),
          };
        }
        return candidateDetail(ownerUserId, resolved[0]!.id);
      }
      throw new HrAgentCapabilityError(
        'candidate_selector_required',
        'Provide candidate_id or full_name',
      );
    }

    case 'search_aggregate':
      return searchAggregate(ownerUserId, params);

    case 'start_candidate_analysis': {
      const resolved = resolveCandidateForTool(ownerUserId, params);
      if (!('id' in resolved)) return resolved;
      const job = requireJob(ownerUserId, resolved.jobId);
      const started = startCandidateAnalysisWithJob(ownerUserId, resolved.id);
      createHrAudit({
        ownerUserId,
        actorId: ownerUserId,
        action: 'candidate_analysis_started',
        targetType: 'candidate',
        targetId: resolved.id,
        detail: {
          analysis_job_id: started.analysisJobId,
          job_id: job.id,
          source: 'agent_runtime',
        },
      });
      return {
        status: 'started',
        candidate: candidateSummary(job, started.candidate),
        analysisJobId: started.analysisJobId,
        analysisStatus: started.candidate.aiStatus,
      };
    }

    case 'start_job_analysis': {
      if (!jobId) {
        throw new HrAgentCapabilityError(
          'job_id_required',
          'job_id is required',
        );
      }
      const job = requireJob(ownerUserId, jobId);
      const analysis = startHrMarketAnalysis(ownerUserId, job.id);
      createHrAudit({
        ownerUserId,
        actorId: ownerUserId,
        action: 'job_analysis_started',
        targetType: 'job',
        targetId: job.id,
        detail: {
          analysis_job_id: analysis.id,
          analysis_type: analysis.type,
          source: 'agent_runtime',
        },
      });
      return {
        status: 'started',
        job: jobLifecycleSummary(job),
        analysisJobId: analysis.id,
        analysisStatus: analysis.status,
      };
    }

    case 'get_analysis_job': {
      const analysisJobId =
        typeof params.analysis_job_id === 'string'
          ? params.analysis_job_id.trim()
          : '';
      if (!analysisJobId) {
        throw new HrAgentCapabilityError(
          'analysis_job_id_required',
          'analysis_job_id is required',
        );
      }
      const analysis = getHrAnalysisJob(ownerUserId, analysisJobId);
      if (!analysis) {
        throw new HrAgentCapabilityError(
          'analysis_job_not_found',
          'Analysis job not found',
        );
      }
      return { analysisJob: analysisJobSummary(ownerUserId, analysis) };
    }

    case 'update_candidate': {
      if (params.confirmed !== true) {
        throw new HrAgentCapabilityError(
          'confirmation_required',
          'Candidate updates require explicit confirmation',
        );
      }
      const expectedUpdatedAt =
        typeof params.expected_updated_at === 'string'
          ? params.expected_updated_at
          : null;
      if (!expectedUpdatedAt) {
        throw new HrAgentCapabilityError(
          'expected_updated_at_required',
          'expected_updated_at is required to prevent concurrent overwrites',
        );
      }
      const fullNameInput =
        typeof params.full_name === 'string'
          ? params.full_name.trim()
          : undefined;
      const stageInput =
        typeof params.stage === 'string' ? params.stage : undefined;
      const talentPoolInput =
        typeof params.talent_pool === 'boolean'
          ? params.talent_pool
          : undefined;
      const hasSummaryInput = Object.prototype.hasOwnProperty.call(
        params,
        'summary',
      );
      const summaryInput =
        params.summary === null
          ? null
          : typeof params.summary === 'string'
            ? params.summary.trim()
            : undefined;
      if (
        summaryInput !== undefined &&
        summaryInput !== null &&
        !summaryInput
      ) {
        throw new HrAgentCapabilityError(
          'invalid_candidate_patch',
          'Summary must be a non-empty string or null',
        );
      }
      if (summaryInput && summaryInput.length > 4000) {
        throw new HrAgentCapabilityError(
          'invalid_candidate_patch',
          'Summary cannot exceed 4000 characters',
        );
      }
      if (stageInput !== undefined && !(stageInput in HR_STAGE_LABELS)) {
        throw new HrAgentCapabilityError(
          'invalid_stage',
          'Invalid candidate stage',
        );
      }
      if (
        !fullNameInput &&
        stageInput === undefined &&
        talentPoolInput === undefined &&
        !hasSummaryInput
      ) {
        throw new HrAgentCapabilityError(
          'patch_required',
          'No candidate fields to update',
        );
      }
      const resolved = resolveCandidateForTool(ownerUserId, params);
      if (!('id' in resolved)) return resolved;
      if (expectedUpdatedAt !== resolved.updatedAt) {
        throw new HrAgentCapabilityError(
          'candidate_version_conflict',
          'Candidate was modified after it was read',
        );
      }
      const job = requireJob(ownerUserId, resolved.jobId);
      const previousName = resolved.fullName;
      const previousStage = resolved.stage;
      const nameChanged = Boolean(
        fullNameInput && fullNameInput !== previousName,
      );
      const stageChanged = Boolean(stageInput && stageInput !== previousStage);
      const talentPoolChanged =
        talentPoolInput !== undefined &&
        talentPoolInput !== resolved.talentPool;
      const summaryChanged =
        hasSummaryInput && summaryInput !== resolved.summary;
      if (nameChanged && fullNameInput) {
        const duplicate = listHrCandidates(ownerUserId, {
          jobId: job.id,
          limit: 500,
        }).find(
          (item) =>
            item.id !== resolved.id &&
            item.fullName.trim().toLowerCase() === fullNameInput.toLowerCase(),
        );
        if (duplicate) {
          throw new HrAgentCapabilityError(
            'duplicate_candidate_name',
            'Another candidate already uses this name for the job',
          );
        }
      }
      if (
        !nameChanged &&
        !stageChanged &&
        !talentPoolChanged &&
        !summaryChanged
      ) {
        return {
          status: 'updated',
          candidate: candidateSummary(job, resolved),
          oldName: previousName,
          newName: previousName,
          oldStage: previousStage,
          newStage: previousStage,
          oldTalentPool: resolved.talentPool,
          newTalentPool: resolved.talentPool,
          oldSummary: sanitizeAgentSummary(resolved.summary),
          newSummary: sanitizeAgentSummary(resolved.summary),
          auditActions: [],
          feishuSync: {
            attempted: false,
            synced: false,
            recordId: null,
            error: null,
          },
        };
      }
      const patch: Parameters<typeof updateHrCandidate>[2] = {};
      if (nameChanged && fullNameInput) {
        patch.fullName = fullNameInput;
        patch.fullNameSource = 'manual';
      }
      if (stageChanged && stageInput) patch.stage = stageInput as HrStage;
      if (talentPoolChanged && talentPoolInput !== undefined) {
        patch.talentPool = talentPoolInput;
      }
      if (summaryChanged) patch.summary = summaryInput ?? null;
      const updated = updateHrCandidate(ownerUserId, resolved.id, patch);
      if (!updated) {
        throw new HrAgentCapabilityError(
          'candidate_not_found',
          'Candidate not found',
        );
      }
      const auditActions: string[] = [];
      if (nameChanged) {
        auditActions.push('candidate_name_updated');
        createHrAudit({
          ownerUserId,
          actorId: ownerUserId,
          action: 'candidate_name_updated',
          targetType: 'candidate',
          targetId: resolved.id,
          detail: {
            old_full_name: previousName,
            new_full_name: fullNameInput,
            job_id: job.id,
            source: 'agent_runtime',
          },
        });
      }
      if (stageChanged) {
        auditActions.push('candidate_stage_updated');
        createHrAudit({
          ownerUserId,
          actorId: ownerUserId,
          action: 'candidate_stage_updated',
          targetType: 'candidate',
          targetId: resolved.id,
          detail: {
            old_stage: previousStage,
            new_stage: stageInput,
            job_id: job.id,
            source: 'agent_runtime',
          },
        });
      }
      if (talentPoolChanged) {
        auditActions.push('candidate_talent_pool_updated');
        createHrAudit({
          ownerUserId,
          actorId: ownerUserId,
          action: 'candidate_talent_pool_updated',
          targetType: 'candidate',
          targetId: resolved.id,
          detail: {
            old_talent_pool: resolved.talentPool,
            new_talent_pool: updated.talentPool,
            job_id: job.id,
            source: 'agent_runtime',
          },
        });
      }
      if (summaryChanged) {
        auditActions.push('candidate_summary_updated');
        createHrAudit({
          ownerUserId,
          actorId: ownerUserId,
          action: 'candidate_summary_updated',
          targetType: 'candidate',
          targetId: resolved.id,
          detail: {
            old_summary: sanitizeAgentSummary(resolved.summary),
            new_summary: sanitizeAgentSummary(updated.summary),
            job_id: job.id,
            source: 'agent_runtime',
          },
        });
      }
      const feishuSync = await syncCandidate(ownerUserId, resolved.id, baseUrl);
      return {
        status: 'updated',
        candidate: candidateSummary(job, updated),
        oldName: previousName,
        newName: updated.fullName,
        oldStage: previousStage,
        newStage: updated.stage,
        newStageLabel: HR_STAGE_LABELS[updated.stage],
        oldTalentPool: resolved.talentPool,
        newTalentPool: updated.talentPool,
        oldSummary: sanitizeAgentSummary(resolved.summary),
        newSummary: sanitizeAgentSummary(updated.summary),
        auditActions,
        auditAction: auditActions[0] ?? null,
        feishuSync,
      };
    }

    case 'list_interview_rounds': {
      const resolved = resolveCandidateForTool(ownerUserId, params);
      if (!('id' in resolved)) return resolved;
      const rounds = listHrInterviewRounds(ownerUserId, resolved.id)
        .slice(0, 50)
        .map(feedbackSummary);
      return {
        candidate: candidateSummary(
          getHrJob(ownerUserId, resolved.jobId),
          resolved,
        ),
        rounds,
      };
    }

    case 'submit_interview_feedback': {
      if (params.confirmed !== true) {
        throw new HrAgentCapabilityError(
          'confirmation_required',
          'Interview feedback submission requires explicit confirmation',
        );
      }
      const parsed = HrFeedbackSchema.safeParse({
        stage: params.stage,
        interviewer: params.interviewer,
        scheduled_at: params.scheduled_at,
        completed_at: params.completed_at,
        outcome: params.outcome,
        feedback_text: params.feedback_text,
      });
      if (!parsed.success) {
        throw new HrAgentCapabilityError(
          'invalid_feedback',
          'Invalid interview feedback fields',
          parsed.error.format(),
        );
      }
      const resolved = resolveCandidateForTool(ownerUserId, params);
      if (!('id' in resolved)) return resolved;
      const job = requireJob(ownerUserId, resolved.jobId);
      const round = createHrInterviewRound({
        ownerUserId,
        jobId: job.id,
        candidateId: resolved.id,
        stage: parsed.data.stage,
        interviewer: parsed.data.interviewer ?? null,
        scheduledAt: parsed.data.scheduled_at ?? null,
        completedAt: parsed.data.completed_at ?? null,
        outcome: parsed.data.outcome ?? null,
        feedbackText: parsed.data.feedback_text,
        score: null,
      });
      updateHrCandidate(ownerUserId, resolved.id, { stage: parsed.data.stage });
      createHrAudit({
        ownerUserId,
        actorId: ownerUserId,
        action: 'interview_feedback_submitted',
        targetType: 'candidate',
        targetId: resolved.id,
        detail: {
          round_id: round.id,
          stage: parsed.data.stage,
          job_id: job.id,
          source: 'agent_runtime',
        },
      });
      let analysisStatus: 'completed' | 'failed' = 'completed';
      let analysisError: string | null = null;
      let jobRule: ReturnType<typeof jobRuleSummary> | undefined;
      try {
        const rule = await runFeedbackAnalysis(
          ownerUserId,
          resolved.id,
          round.id,
        );
        jobRule = rule ? jobRuleSummary(rule) : undefined;
      } catch (error) {
        analysisStatus = 'failed';
        analysisError =
          error instanceof HrCandidateAnalysisError
            ? error.message
            : 'Feedback analysis failed';
      }
      const freshCandidate = getHrCandidate(ownerUserId, resolved.id)!;
      const freshRound = listHrInterviewRounds(ownerUserId, resolved.id).find(
        (item) => item.id === round.id,
      )!;
      const feishuSync = await syncCandidate(ownerUserId, resolved.id, baseUrl);
      return {
        status:
          analysisStatus === 'completed'
            ? 'recorded'
            : 'recorded_with_analysis_failure',
        candidate: candidateSummary(job, freshCandidate),
        round: feedbackSummary(freshRound),
        analysisStatus,
        analysisError,
        jobRule: jobRule ?? null,
        feishuSync,
      };
    }

    case 'sync_candidate_to_feishu': {
      const candidate = candidateId
        ? requireCandidate(ownerUserId, candidateId)
        : undefined;
      if (!candidate) {
        throw new HrAgentCapabilityError(
          'candidate_not_found',
          'Candidate not found',
        );
      }
      const config = getHrFeishuConfig(ownerUserId);
      if (!config?.enabled) {
        throw new HrAgentCapabilityError(
          'feishu_not_configured',
          'Feishu sync is not configured',
        );
      }
      const result = await syncCandidate(ownerUserId, candidate.id, baseUrl);
      if (result.error) {
        return { status: 'failed', ...result };
      }
      return { status: 'synced', ...result };
    }

    case 'update_job': {
      if (!jobId) {
        throw new HrAgentCapabilityError(
          'job_id_required',
          'job_id is required',
        );
      }
      return await updateJobFromAgent(ownerUserId, params, jobId, baseUrl);
    }

    case 'analyze_resume_preview':
      return await analyzeResumePreviewFromAttachment(ownerUserId, params);

    case 'delete_job':
    case 'restore_job': {
      if (params.confirmed !== true) {
        throw new HrAgentCapabilityError(
          'confirmation_required',
          'JD lifecycle changes require explicit confirmation',
        );
      }
      if (!jobId) {
        throw new HrAgentCapabilityError(
          'job_id_required',
          'job_id is required',
        );
      }
      const changed =
        operation === 'delete_job'
          ? softDeleteHrJob(ownerUserId, jobId, ownerUserId)
          : restoreHrJob(ownerUserId, jobId);
      if (!changed) {
        throw new HrAgentCapabilityError('job_not_found', 'Job not found');
      }
      createHrAudit({
        ownerUserId,
        actorId: ownerUserId,
        action:
          operation === 'delete_job' ? 'job_soft_deleted' : 'job_restored',
        targetType: 'job',
        targetId: jobId,
        detail: { source: 'agent_runtime' },
      });
      return {
        status: 'updated',
        job: jobLifecycleSummary(changed),
      };
    }

    default:
      throw new HrAgentCapabilityError(
        'unknown_operation',
        'Unknown HR operation',
      );
  }
}

export function runHrJobExpiryScan(): number {
  return expireHrJobs().length;
}

const CHAT_RESUME_ATTACHMENT_RE = /^[0-9a-f-]{36}\.(pdf|doc|docx|txt|md)$/;

function chatResumeAttachmentPath(
  ownerUserId: string,
  attachmentId: string,
): string {
  if (!CHAT_RESUME_ATTACHMENT_RE.test(attachmentId)) {
    throw new HrAgentCapabilityError(
      'attachment_not_found',
      'Resume attachment not found',
    );
  }
  const root = path.resolve(DATA_DIR, 'hr', 'chat-documents', ownerUserId);
  const filePath = path.resolve(root, attachmentId);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    throw new HrAgentCapabilityError(
      'attachment_not_found',
      'Resume attachment not found',
    );
  }
  return filePath;
}

async function analyzeResumePreviewFromAttachment(
  ownerUserId: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const attachmentId =
    typeof params.attachment_id === 'string' ? params.attachment_id : '';
  const jdText =
    typeof params.jd_text === 'string' ? params.jd_text.trim() : '';
  if (!attachmentId) {
    throw new HrAgentCapabilityError(
      'attachment_id_required',
      'attachment_id is required',
    );
  }
  if (jdText.length < 20) {
    throw new HrAgentCapabilityError(
      'jd_text_required',
      'A JD description of at least 20 characters is required',
    );
  }
  const filePath = chatResumeAttachmentPath(ownerUserId, attachmentId);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new HrAgentCapabilityError(
      'attachment_not_found',
      'Resume attachment not found or expired',
    );
  }
  const extracted = await extractFileText(filePath);
  if (!extracted?.text.trim()) {
    throw new HrAgentCapabilityError(
      'resume_text_unavailable',
      'Resume text could not be extracted',
    );
  }
  try {
    const assessment = await analyzeResumePreview(jdText, extracted.text);
    const breakdown = scoreResumeAssessment(assessment);
    const safeBreakdown = sanitizeScoreBreakdown(breakdown);
    createHrAudit({
      ownerUserId,
      actorId: ownerUserId,
      action: 'resume_preview_analyzed',
      targetType: 'chat_attachment',
      targetId: attachmentId,
      detail: {
        score_standard: RESUME_SCORING_VERSION,
        score: breakdown.total_score,
        fit_level: breakdown.fit_level,
        size_bytes: stat.size,
        source: 'agent_runtime',
      },
    });
    return {
      status: 'analyzed',
      score_standard: RESUME_SCORING_VERSION,
      score: breakdown.total_score,
      fit_level: breakdown.fit_level,
      breakdown: safeBreakdown,
      persistence: {
        job_created: false,
        candidate_created: false,
        resume_created: false,
        analysis_job_created: false,
        feishu_synced: false,
      },
      piiNote: '临时分析不保存简历；联系方式和简历全文不会返回。',
    };
  } finally {
    await fs.rm(filePath, { force: true });
  }
}

export function scanExpiredHrJobs(): number {
  const expired = expireHrJobs();
  for (const { ownerUserId, job } of expired) {
    createHrAudit({
      ownerUserId,
      actorId: ownerUserId,
      action: 'job_expired',
      targetType: 'job',
      targetId: job.id,
      detail: { expires_at: job.expiresAt, title: job.title, source: 'system' },
    });
  }
  return expired.length;
}

export function hrAgentBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${WEB_PORT}`;
}
