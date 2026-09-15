import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import {
  HrCandidateHardDeleteSchema,
  HrCandidateUpdateSchema,
  HrFeishuConfigSchema,
  HrFeedbackSchema,
  HrJobCreateSchema,
  HrJobUpdateSchema,
  HrResumeLinkImportSchema,
} from '../hr/schemas.js';
import { DATA_DIR } from '../config.js';
import {
  HrImportError,
  HR_RESUME_MAX_BYTES,
  importResumeFromLink,
  ingestResume,
} from '../hr/import.js';
import { hrResumeUploadBodyLimit } from '../http-upload-policy.js';
import {
  HrCandidateAnalysisError,
  analyzePendingCandidates,
  retryHrAnalysisJob,
  runFeedbackAnalysis,
  runMarketAnalysis,
  startCandidateAnalysisWithJob,
} from '../hr/analysis-service.js';
import {
  HrFeishuError,
  syncCandidateToFeishu,
  deleteFeishuCandidateRecord,
  testFeishuConfig,
} from '../hr/feishu.js';
import {
  createHrAudit,
  createHrCandidate,
  createHrInterviewRound,
  createHrJob,
  deleteHrResume,
  getHrCandidate,
  getHrFeishuConfig,
  getHrJob,
  getActiveHrJobRule,
  listHrAuditByActions,
  getHrJobRule,
  getHrResume,
  getLatestHrMatch,
  hardDeleteHrCandidate,
  listHrAnalysisJobs,
  listHrAnalysisJobsPaged,
  listAllHrInterviewRounds,
  listAllHrQuestions,
  listHrCandidates,
  listHrCandidatesForJobs,
  listHrCandidatesPaged,
  listHrInterviewRounds,
  listHrJobs,
  listHrJobsPaged,
  listHrJobRules,
  listHrQuestions,
  listHrQuestionsPaged,
  listLatestHrFeishuSync,
  listHrResumesForCandidate,
  getHrFeishuSync,
  restoreHrJob,
  softDeleteHrJob,
  upsertHrFeishuConfig,
  archiveHrJobRulesForJob,
  setHrJobRuleStatus,
  updateHrCandidate,
  updateHrJob,
} from '../hr/store.js';
import {
  buildAnalytics,
  buildOverview,
  buildOverviewExportCsv,
  buildQuestionLibrary,
  buildJobStats,
} from '../hr/reports.js';
import { getChannelAccountForUser } from '../db.js';
import { HR_STAGE_LABELS } from '../hr/types.js';

const hrRoutes = new Hono<{ Variables: Variables }>();

export default hrRoutes;

function validationBody(error: { format: () => unknown }) {
  return { error: 'Invalid request body', details: error.format() };
}

const HR_PAGE_SIZES = new Set([10, 20, 50, 100]);

const CHAT_RESUME_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.txt',
  '.md',
]);

function chatResumeUploadDir(ownerUserId: string): string {
  return path.join(DATA_DIR, 'hr', 'chat-documents', ownerUserId);
}

async function reapExpiredChatResumeUploads(
  ownerUserId: string,
): Promise<void> {
  const dir = chatResumeUploadDir(ownerUserId);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const entries = await fs.promises.readdir(dir).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(dir, entry);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < cutoff) {
        await fs.promises.rm(filePath, { force: true });
      }
    }),
  );
}

function parsePagination(c: {
  req: { query: (name: string) => string | undefined };
}):
  | { enabled: false }
  | { enabled: true; page: number; pageSize: number }
  | { enabled: false; error: string } {
  const rawPage = c.req.query('page');
  if (!rawPage) return { enabled: false };
  const page = Number.parseInt(rawPage, 10);
  if (!Number.isInteger(page) || page < 1) {
    return { enabled: false, error: 'Invalid page' };
  }
  const rawPageSize = c.req.query('page_size') ?? '20';
  const pageSize = Number.parseInt(rawPageSize, 10);
  if (!HR_PAGE_SIZES.has(pageSize)) {
    return { enabled: false, error: 'Invalid page size' };
  }
  return { enabled: true, page, pageSize };
}

function paginationMeta(page: number, pageSize: number, total: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    page,
    page_size: pageSize,
    total,
    total_pages: totalPages,
    has_more: page < totalPages,
  };
}

function publicResume(resume: ReturnType<typeof getHrResume>) {
  if (!resume) return null;
  return {
    id: resume.id,
    candidateId: resume.candidateId,
    jobId: resume.jobId,
    fileName: resume.fileName,
    mimeType: resume.mimeType,
    sizeBytes: resume.sizeBytes,
    sha256: resume.sha256,
    parserVersion: resume.parserVersion,
    parseStatus: resume.parseStatus,
    createdAt: resume.createdAt,
  };
}

function publicFeishuConfig(config: ReturnType<typeof getHrFeishuConfig>) {
  if (!config) return null;
  return {
    channel_account_id: config.channelAccountId,
    app_token: config.appToken,
    table_id: config.tableId,
    field_mapping: config.fieldMapping ?? {},
    enabled: config.enabled,
  };
}

function buildAgentActivity(
  ownerUserId: string,
  audits: ReturnType<typeof listHrAuditByActions>,
) {
  return audits.map((audit) => {
    const detail = audit.detail
      ? (JSON.parse(audit.detail) as Record<string, unknown>)
      : {};
    const candidate =
      audit.targetType === 'candidate' && audit.targetId
        ? getHrCandidate(ownerUserId, audit.targetId)
        : undefined;
    const jobId =
      candidate?.jobId ||
      (typeof detail.job_id === 'string' ? detail.job_id : null);
    const job = jobId ? getHrJob(ownerUserId, jobId) : undefined;
    const stage = (value: unknown) =>
      typeof value === 'string' && value in HR_STAGE_LABELS
        ? HR_STAGE_LABELS[value as keyof typeof HR_STAGE_LABELS]
        : null;

    let summary = '';
    if (audit.action === 'candidate_stage_updated') {
      summary = `${candidate?.fullName ?? '候选人'} ${stage(detail.old_stage) ?? detail.old_stage ?? ''} → ${stage(detail.new_stage) ?? detail.new_stage ?? ''}`;
    } else if (audit.action === 'candidate_talent_pool_updated') {
      summary = `${candidate?.fullName ?? '候选人'} 人才库状态：${detail.old_talent_pool ? '已标记' : '未标记'} → ${detail.new_talent_pool ? '已标记' : '未标记'}`;
    } else if (audit.action === 'candidate_summary_updated') {
      summary = `${candidate?.fullName ?? '候选人'} 摘要已更新`;
    } else if (audit.action === 'candidate_name_updated') {
      summary = `候选人姓名已更新：${typeof detail.old_full_name === 'string' ? detail.old_full_name : (candidate?.fullName ?? '候选人')} → ${typeof detail.new_full_name === 'string' ? detail.new_full_name : (candidate?.fullName ?? '候选人')}`;
    } else if (audit.action === 'interview_feedback_submitted') {
      summary = `${candidate?.fullName ?? '候选人'} 已记录${stage(detail.stage) ?? detail.stage ?? '面试'}反馈`;
    } else if (audit.action === 'candidate_analysis_started') {
      summary = `${candidate?.fullName ?? '候选人'} 已启动 AI 匹配分析`;
    } else if (audit.action === 'job_analysis_started') {
      summary = `岗位已启动漏斗/市场分析：${job?.title ?? jobId ?? ''}`;
    } else if (audit.action === 'feishu_synced') {
      summary = `${candidate?.fullName ?? '候选人'} 已同步飞书`;
    } else if (audit.action === 'job_expired') {
      summary = `岗位已到期：${typeof detail.title === 'string' ? detail.title : (job?.title ?? jobId ?? '')}`;
    } else if (audit.action === 'job_soft_deleted') {
      summary = `岗位已软删除：${typeof detail.title === 'string' ? detail.title : (job?.title ?? audit.targetId ?? '')}`;
    } else if (audit.action === 'job_restored') {
      summary = `岗位已恢复：${typeof detail.title === 'string' ? detail.title : (job?.title ?? audit.targetId ?? '')}`;
    } else if (audit.action === 'overview_exported') {
      summary = '工作台总览已导出 CSV';
    } else if (audit.action === 'candidate_updated') {
      summary = `候选人信息已更新：${candidate?.fullName ?? '候选人'}`;
    } else if (audit.action === 'candidate_hard_deleted') {
      summary = '候选人已彻底删除';
    }

    return {
      id: audit.id,
      action: audit.action,
      targetId: audit.targetId,
      jobId,
      jobTitle: job?.title ?? null,
      candidateId: candidate?.id ?? null,
      candidateName: candidate?.fullName ?? null,
      summary: summary || audit.action,
      source:
        detail.source === 'agent_runtime' && audit.action !== 'job_expired'
          ? 'agent_runtime'
          : detail.source === 'system'
            ? 'system'
            : detail.source === 'web'
              ? 'web'
              : audit.action === 'job_expired'
                ? 'system'
                : 'unknown',
      createdAt: audit.createdAt,
    };
  });
}

function resumeFileResponse(
  resume: NonNullable<ReturnType<typeof getHrResume>>,
  mode: 'view' | 'download',
) {
  const extension = path.extname(resume.fileName).toLowerCase();
  const contentType =
    extension === '.pdf'
      ? 'application/pdf'
      : extension === '.txt' || extension === '.md'
        ? 'text/plain; charset=utf-8'
        : resume.mimeType || 'application/octet-stream';
  const inline =
    mode === 'view' &&
    (extension === '.pdf' || extension === '.txt' || extension === '.md');
  const disposition = inline ? 'inline' : 'attachment';
  const stat = fs.statSync(resume.filePath);
  const stream = Readable.toWeb(
    fs.createReadStream(resume.filePath),
  ) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: {
      'content-type': contentType,
      'content-length': String(stat.size),
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(resume.fileName)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
}

async function removeResumeFile(
  resume: NonNullable<ReturnType<typeof getHrResume>>,
) {
  const storageDir = path.resolve(
    DATA_DIR,
    'hr',
    'resumes',
    resume.ownerUserId,
    resume.candidateId,
  );
  const filePath = path.resolve(resume.filePath);
  if (
    filePath !== storageDir &&
    !filePath.startsWith(`${storageDir}${path.sep}`)
  ) {
    throw new HrImportError('Resume file path is outside protected storage');
  }
  await fs.promises.rm(filePath, { force: true });
  deleteHrResume(resume.ownerUserId, resume.id);
}

async function trySyncCandidate(
  ownerUserId: string,
  actorId: string,
  candidateId: string,
  baseUrl: string,
): Promise<{ attempted: boolean; error?: string }> {
  const config = getHrFeishuConfig(ownerUserId);
  if (!config?.enabled) return { attempted: false };
  try {
    await syncCandidateToFeishu({ ownerUserId, actorId, candidateId, baseUrl });
    return { attempted: true };
  } catch (error) {
    return {
      attempted: true,
      error: error instanceof Error ? error.message : 'Feishu sync failed',
    };
  }
}

hrRoutes.use('*', authMiddleware);

hrRoutes.get('/jobs', (c) => {
  const user = c.get('user') as AuthUser;
  const pagination = parsePagination(c);
  if ('error' in pagination) return c.json({ error: pagination.error }, 400);
  if (pagination.enabled) {
    const offset = (pagination.page - 1) * pagination.pageSize;
    const page = listHrJobsPaged(user.id, {
      search: c.req.query('search') || undefined,
      lifecycle: c.req.query('lifecycle') as never,
      limit: pagination.pageSize,
      offset,
    });
    let jobs = page.items;
    if (c.req.query('with_stats') === 'true') {
      const candidates = listHrCandidatesForJobs(
        user.id,
        jobs.map((job) => job.id),
      );
      jobs = jobs.map((job) => ({
        ...job,
        stats: buildJobStats(job.id, candidates),
      }));
    }
    return c.json({
      jobs,
      ...paginationMeta(pagination.page, pagination.pageSize, page.total),
    });
  }
  const jobs = listHrJobs(user.id, {
    includeDeleted: c.req.query('include_deleted') === 'true',
  });
  if (c.req.query('with_stats') !== 'true') return c.json({ jobs });
  const candidates = listHrCandidates(user.id, { limit: 500 });
  return c.json({
    jobs: jobs.map((job) => ({
      ...job,
      stats: buildJobStats(job.id, candidates),
    })),
  });
});

hrRoutes.get('/overview', (c) => {
  const user = c.get('user') as AuthUser;
  const jobs = listHrJobs(user.id);
  const candidates = listHrCandidates(user.id, { limit: 500 });
  const analysisJobs = listHrAnalysisJobs(user.id, undefined, 2000);
  return c.json({
    overview: buildOverview(jobs, candidates, analysisJobs),
  });
});

hrRoutes.get('/overview/export.csv', (c) => {
  const user = c.get('user') as AuthUser;
  const jobs = listHrJobs(user.id);
  const candidates = listHrCandidates(user.id, { limit: 500 });
  const analysisJobs = listHrAnalysisJobs(user.id, undefined, 2000);
  createHrAudit({
    ownerUserId: user.id,
    actorId: user.id,
    action: 'overview_exported',
    targetType: 'overview',
    targetId: user.id,
    detail: { source: 'web' },
  });
  const exportedAt = new Date().toISOString().slice(0, 10);
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header(
    'Content-Disposition',
    `attachment; filename="iclaw-hr-overview-${exportedAt}.csv"`,
  );
  return c.body(buildOverviewExportCsv(jobs, candidates, analysisJobs));
});

hrRoutes.get('/agent-activity', (c) => {
  const user = c.get('user') as AuthUser;
  const audits = listHrAuditByActions(
    user.id,
    [
      'candidate_stage_updated',
      'candidate_talent_pool_updated',
      'candidate_summary_updated',
      'candidate_name_updated',
      'candidate_updated',
      'interview_feedback_submitted',
      'candidate_analysis_started',
      'job_analysis_started',
      'candidate_hard_deleted',
      'job_expired',
      'job_soft_deleted',
      'job_restored',
      'overview_exported',
      'feishu_synced',
    ],
    20,
  );
  return c.json({ activity: buildAgentActivity(user.id, audits) });
});

hrRoutes.get('/analysis-jobs', (c) => {
  const user = c.get('user') as AuthUser;
  const pagination = parsePagination(c);
  if ('error' in pagination) return c.json({ error: pagination.error }, 400);
  if (pagination.enabled) {
    const status = c.req.query('status');
    const page = listHrAnalysisJobsPaged(user.id, {
      candidateId: c.req.query('candidateId') || undefined,
      status: status as Parameters<typeof listHrAnalysisJobs>[3],
      limit: pagination.pageSize,
      offset: (pagination.page - 1) * pagination.pageSize,
    });
    return c.json({
      jobs: page.items,
      ...paginationMeta(pagination.page, pagination.pageSize, page.total),
    });
  }
  const status = c.req.query('status');
  const jobs = listHrAnalysisJobs(
    user.id,
    c.req.query('candidateId') || undefined,
    Number(c.req.query('limit') ?? 100),
    status as Parameters<typeof listHrAnalysisJobs>[3],
  );
  return c.json({ jobs });
});

hrRoutes.post('/analysis-jobs/:jobId/retry', (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const candidate = retryHrAnalysisJob(user.id, c.req.param('jobId'));
    return c.json({ candidate, analysis_status: 'queued' }, 202);
  } catch (error) {
    if (error instanceof HrCandidateAnalysisError)
      return c.json({ error: error.message }, 404);
    return c.json({ error: 'Analysis retry failed' }, 500);
  }
});

hrRoutes.post('/jobs/:jobId/analyze-pending', (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const queued = analyzePendingCandidates(user.id, c.req.param('jobId'));
    return c.json({ queued }, 202);
  } catch (error) {
    if (error instanceof HrCandidateAnalysisError)
      return c.json({ error: error.message }, 404);
    return c.json({ error: 'Batch analysis failed' }, 500);
  }
});

hrRoutes.post('/jobs', async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = HrJobCreateSchema.safeParse(body);
  if (!parsed.success) return c.json(validationBody(parsed.error), 400);
  const job = createHrJob({
    ownerUserId: user.id,
    title: parsed.data.title,
    department: parsed.data.department ?? null,
    location: parsed.data.location ?? null,
    level: parsed.data.level ?? null,
    salaryRange: parsed.data.salary_range ?? null,
    status: parsed.data.status,
    expiresAt: parsed.data.expires_at ?? null,
    jdText: parsed.data.jd_text,
    keywords: parsed.data.keywords,
    responsibilities: parsed.data.responsibilities,
    requirements: parsed.data.requirements,
    preferred: parsed.data.preferred,
    techStack: parsed.data.tech_stack,
  });
  createHrAudit({
    ownerUserId: user.id,
    actorId: user.id,
    action: 'job_created',
    targetType: 'job',
    targetId: job.id,
    detail: { title: job.title, source: 'web' },
  });
  return c.json({ job }, 201);
});

hrRoutes.get('/jobs/:jobId', (c) => {
  const user = c.get('user') as AuthUser;
  const job = getHrJob(user.id, c.req.param('jobId'));
  if (!job) return c.json({ error: 'Job not found' }, 404);
  return c.json({ job });
});

hrRoutes.delete('/jobs/:jobId', (c) => {
  const user = c.get('user') as AuthUser;
  const job = softDeleteHrJob(user.id, c.req.param('jobId'), user.id);
  if (!job) return c.json({ error: 'Job not found' }, 404);
  createHrAudit({
    ownerUserId: user.id,
    actorId: user.id,
    action: 'job_soft_deleted',
    targetType: 'job',
    targetId: job.id,
    detail: { title: job.title, source: 'web' },
  });
  return c.json({ job });
});

hrRoutes.post('/jobs/:jobId/restore', (c) => {
  const user = c.get('user') as AuthUser;
  const job = restoreHrJob(user.id, c.req.param('jobId'));
  if (!job) return c.json({ error: 'Deleted job not found' }, 404);
  createHrAudit({
    ownerUserId: user.id,
    actorId: user.id,
    action: 'job_restored',
    targetType: 'job',
    targetId: job.id,
    detail: { title: job.title, source: 'web' },
  });
  return c.json({ job });
});

hrRoutes.get('/jobs/:jobId/rules', (c) => {
  const user = c.get('user') as AuthUser;
  const jobId = c.req.param('jobId');
  if (!getHrJob(user.id, jobId)) return c.json({ error: 'Job not found' }, 404);
  return c.json({
    rules: listHrJobRules(user.id, jobId),
    activeRule: getActiveHrJobRule(user.id, jobId) ?? null,
  });
});

hrRoutes.post('/jobs/:jobId/rules/:ruleId/activate', (c) => {
  const user = c.get('user') as AuthUser;
  const jobId = c.req.param('jobId');
  const rule = getHrJobRule(user.id, c.req.param('ruleId'));
  if (!rule || rule.jobId !== jobId || !getHrJob(user.id, jobId))
    return c.json({ error: 'Job rule not found' }, 404);
  const updated = setHrJobRuleStatus(user.id, rule.id, 'active');
  createHrAudit({
    ownerUserId: user.id,
    actorId: user.id,
    action: 'job_rule_activated',
    targetType: 'job_rule',
    targetId: rule.id,
    detail: { job_id: jobId, rule_version: rule.ruleVersion },
  });
  return c.json({ rule: updated });
});

hrRoutes.post('/jobs/:jobId/rules/:ruleId/discard', (c) => {
  const user = c.get('user') as AuthUser;
  const jobId = c.req.param('jobId');
  const rule = getHrJobRule(user.id, c.req.param('ruleId'));
  if (!rule || rule.jobId !== jobId || !getHrJob(user.id, jobId))
    return c.json({ error: 'Job rule not found' }, 404);
  const updated = setHrJobRuleStatus(user.id, rule.id, 'discarded');
  createHrAudit({
    ownerUserId: user.id,
    actorId: user.id,
    action: 'job_rule_discarded',
    targetType: 'job_rule',
    targetId: rule.id,
    detail: { job_id: jobId, rule_version: rule.ruleVersion },
  });
  return c.json({ rule: updated });
});

hrRoutes.put('/jobs/:jobId', async (c) => {
  const user = c.get('user') as AuthUser;
  const existingBeforeParse = getHrJob(user.id, c.req.param('jobId'));
  if (!existingBeforeParse || existingBeforeParse.deletedAt) {
    return c.json({ error: 'Job not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const parsed = HrJobUpdateSchema.safeParse(body);
  if (!parsed.success) return c.json(validationBody(parsed.error), 400);
  const patch: Parameters<typeof updateHrJob>[2] = {};
  if (body.title !== undefined) patch.title = parsed.data.title;
  if (body.department !== undefined)
    patch.department = parsed.data.department ?? null;
  if (body.location !== undefined)
    patch.location = parsed.data.location ?? null;
  if (body.level !== undefined) patch.level = parsed.data.level ?? null;
  if (body.salary_range !== undefined)
    patch.salaryRange = parsed.data.salary_range ?? null;
  if (body.status !== undefined) patch.status = parsed.data.status;
  if (body.expires_at !== undefined)
    patch.expiresAt = parsed.data.expires_at ?? null;
  if (body.jd_text !== undefined) patch.jdText = parsed.data.jd_text;
  if (body.keywords !== undefined) patch.keywords = parsed.data.keywords;
  if (body.responsibilities !== undefined)
    patch.responsibilities = parsed.data.responsibilities;
  if (body.requirements !== undefined)
    patch.requirements = parsed.data.requirements;
  if (body.preferred !== undefined) patch.preferred = parsed.data.preferred;
  if (body.tech_stack !== undefined) patch.techStack = parsed.data.tech_stack;
  const existingJob = existingBeforeParse;
  const job = updateHrJob(user.id, c.req.param('jobId'), patch);
  if (!job) return c.json({ error: 'Job not found' }, 404);
  if (existingJob && existingJob.jdText !== job.jdText)
    archiveHrJobRulesForJob(user.id, job.id);
  const titleChanged = Boolean(
    existingJob && body.title !== undefined && existingJob.title !== job.title,
  );
  const feishuSync = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    errors: [] as string[],
  };
  if (titleChanged) {
    let offset = 0;
    while (true) {
      const candidates = listHrCandidates(user.id, {
        jobId: job.id,
        limit: 500,
        offset,
      });
      for (const candidate of candidates) {
        const sync = await trySyncCandidate(
          user.id,
          user.id,
          candidate.id,
          new URL(c.req.url).origin,
        );
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
    ownerUserId: user.id,
    actorId: user.id,
    action: 'job_updated',
    targetType: 'job',
    targetId: job.id,
    detail: {
      fields: Object.keys(parsed.data),
      title_changed: titleChanged,
      feishu_sync: feishuSync,
      source: 'web',
    },
  });
  return c.json({ job, feishu_sync: feishuSync });
});

hrRoutes.get('/candidates', (c) => {
  const user = c.get('user') as AuthUser;
  const pagination = parsePagination(c);
  if ('error' in pagination) return c.json({ error: pagination.error }, 400);
  if (pagination.enabled) {
    const page = listHrCandidatesPaged(user.id, {
      search: c.req.query('search') || undefined,
      jobId: c.req.query('job_id') || c.req.query('jobId') || undefined,
      stage: c.req.query('stage') || undefined,
      source: c.req.query('source') || undefined,
      talentPool:
        c.req.query('talent_pool') === 'true'
          ? true
          : c.req.query('talent_pool') === 'false'
            ? false
            : undefined,
      cleanupDue: c.req.query('cleanup_due') === 'true',
      limit: pagination.pageSize,
      offset: (pagination.page - 1) * pagination.pageSize,
    });
    return c.json({
      candidates: page.items,
      sources: page.sources,
      ...paginationMeta(pagination.page, pagination.pageSize, page.total),
    });
  }
  const candidates = listHrCandidates(user.id, {
    jobId: c.req.query('jobId') || undefined,
    stage: c.req.query('stage') || undefined,
    talentPool:
      c.req.query('talentPool') === 'true'
        ? true
        : c.req.query('talentPool') === 'false'
          ? false
          : undefined,
    cleanupDue: c.req.query('cleanup_due') === 'true',
    search: c.req.query('search') || undefined,
    limit: Number(c.req.query('limit') ?? 100),
    offset: Number(c.req.query('offset') ?? 0),
  });
  return c.json({
    candidates,
    sources: [...new Set(candidates.map((candidate) => candidate.source))],
  });
});

hrRoutes.post('/chat-resume-uploads', hrResumeUploadBodyLimit, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) {
    return c.json({ error: 'A resume file is required' }, 400);
  }
  if (file.size === 0 || file.size > HR_RESUME_MAX_BYTES) {
    return c.json({ error: 'Resume file exceeds 10MB or is empty' }, 400);
  }
  const extension = path.extname(file.name).toLowerCase();
  if (!CHAT_RESUME_EXTENSIONS.has(extension)) {
    return c.json({ error: 'Unsupported resume file type' }, 400);
  }
  const mimeType = file.type.split(';', 1)[0]?.toLowerCase();
  const allowedMimeTypes: Record<string, string[]> = {
    '.pdf': ['application/pdf'],
    '.doc': ['application/msword'],
    '.docx': [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    '.txt': ['text/plain'],
    '.md': ['text/markdown', 'text/plain'],
  };
  if (mimeType && !allowedMimeTypes[extension]?.includes(mimeType)) {
    return c.json(
      { error: 'Resume content type does not match file name' },
      400,
    );
  }
  const content = Buffer.from(await file.arrayBuffer());
  if (
    extension === '.pdf' &&
    !content.subarray(0, 5).toString('latin1').startsWith('%PDF')
  ) {
    return c.json(
      { error: 'Resume content type does not match file name' },
      400,
    );
  }
  if (
    extension === '.doc' &&
    content.subarray(0, 4).toString('hex') !== 'd0cf11e0'
  ) {
    return c.json(
      { error: 'Resume content type does not match file name' },
      400,
    );
  }
  if (
    extension === '.docx' &&
    content.subarray(0, 2).toString('latin1') !== 'PK'
  ) {
    return c.json(
      { error: 'Resume content type does not match file name' },
      400,
    );
  }
  await reapExpiredChatResumeUploads(user.id);
  const attachmentId = `${crypto.randomUUID()}${extension}`;
  const dir = chatResumeUploadDir(user.id);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, attachmentId);
  await fs.promises.writeFile(filePath, content, { mode: 0o600 });
  return c.json(
    {
      attachment_id: attachmentId,
      file_name: file.name,
      mime_type: mimeType || null,
      size_bytes: file.size,
      expires_in_hours: 24,
    },
    201,
  );
});

hrRoutes.post('/candidates/import', hrResumeUploadBodyLimit, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.parseBody();
  const file = body.file;
  const jobId = typeof body.job_id === 'string' ? body.job_id : '';
  const fullName =
    typeof body.full_name === 'string' && body.full_name.trim()
      ? body.full_name.trim()
      : undefined;
  const job = getHrJob(user.id, jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);
  if (job.deletedAt) return c.json({ error: 'Job not found' }, 404);
  if (!(file instanceof File))
    return c.json({ error: 'A resume file is required' }, 400);
  if (file.size > HR_RESUME_MAX_BYTES)
    return c.json({ error: 'Resume file exceeds 10MB' }, 400);
  const content = Buffer.from(await file.arrayBuffer());
  try {
    const result = await ingestResume({
      ownerUserId: user.id,
      actorId: user.id,
      job,
      fileName: file.name,
      mimeType: file.type || null,
      content,
      source: 'upload',
      candidate: fullName ? { full_name: fullName } : undefined,
    });
    createHrAudit({
      ownerUserId: user.id,
      actorId: user.id,
      action: 'resume_uploaded',
      targetType: 'candidate',
      targetId: result.candidate.id,
      detail: { fileName: result.resume.fileName, source: 'upload' },
    });
    return c.json(
      {
        candidate: result.candidate,
        resume: publicResume(result.resume),
        analysisError: result.analysisError,
        duplicate: result.duplicate ?? false,
      },
      201,
    );
  } catch (error) {
    if (error instanceof HrImportError)
      return c.json({ error: error.message }, 400);
    return c.json({ error: 'Resume import failed' }, 500);
  }
});

hrRoutes.post('/candidates/import/link', async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = HrResumeLinkImportSchema.safeParse(body);
  if (!parsed.success) return c.json(validationBody(parsed.error), 400);
  const job = getHrJob(user.id, parsed.data.job_id);
  if (!job) return c.json({ error: 'Job not found' }, 404);
  if (job.deletedAt) return c.json({ error: 'Job not found' }, 404);
  try {
    const result = await importResumeFromLink(
      user.id,
      user.id,
      job,
      parsed.data,
    );
    createHrAudit({
      ownerUserId: user.id,
      actorId: user.id,
      action: 'resume_imported_link',
      targetType: 'candidate',
      targetId: result.candidate.id,
      detail: { fileName: result.resume.fileName, source: 'link' },
    });
    return c.json(
      {
        candidate: result.candidate,
        resume: publicResume(result.resume),
        analysisError: result.analysisError,
        duplicate: result.duplicate ?? false,
      },
      201,
    );
  } catch (error) {
    if (error instanceof HrImportError)
      return c.json({ error: error.message }, 400);
    if (error instanceof HrCandidateAnalysisError)
      return c.json({ error: error.message }, 502);
    return c.json({ error: 'Resume link import failed' }, 500);
  }
});

hrRoutes.get('/candidates/:candidateId', (c) => {
  const user = c.get('user') as AuthUser;
  const candidateId = c.req.param('candidateId');
  const candidate = getHrCandidate(user.id, candidateId);
  if (!candidate) return c.json({ error: 'Candidate not found' }, 404);
  return c.json({
    candidate,
    resumes: listHrResumesForCandidate(user.id, candidateId).map(publicResume),
    match: getLatestHrMatch(user.id, candidateId) ?? null,
    questions: listHrQuestions(user.id, candidateId),
    rounds: listHrInterviewRounds(user.id, candidateId),
    analysisJobs: listHrAnalysisJobs(user.id, candidateId),
    feishuSyncStatus: getHrFeishuSync(user.id, candidateId) ?? null,
  });
});

hrRoutes.patch('/candidates/:candidateId', async (c) => {
  const user = c.get('user') as AuthUser;
  const candidateId = c.req.param('candidateId');
  const body = await c.req.json().catch(() => ({}));
  const parsed = HrCandidateUpdateSchema.safeParse(body);
  if (!parsed.success) return c.json(validationBody(parsed.error), 400);
  const patch: Parameters<typeof updateHrCandidate>[2] = {};
  const existingCandidate = getHrCandidate(user.id, candidateId);
  if (body.full_name !== undefined) patch.fullName = parsed.data.full_name!;
  if (body.email !== undefined) patch.email = parsed.data.email;
  if (body.phone !== undefined) patch.phone = parsed.data.phone;
  if (body.location !== undefined) patch.location = parsed.data.location;
  if (body.stage !== undefined) patch.stage = parsed.data.stage;
  if (body.talent_pool !== undefined)
    patch.talentPool = parsed.data.talent_pool;
  if (body.source_url !== undefined) patch.sourceUrl = parsed.data.source_url;
  if (body.interviewer_1 !== undefined)
    patch.interviewer1 = parsed.data.interviewer_1;
  if (body.interviewer_2 !== undefined)
    patch.interviewer2 = parsed.data.interviewer_2;
  if (body.interviewer_3 !== undefined)
    patch.interviewer3 = parsed.data.interviewer_3;
  if (body.retention_expires_at !== undefined)
    patch.retentionExpiresAt = parsed.data.retention_expires_at;
  if (
    body.full_name !== undefined &&
    existingCandidate &&
    parsed.data.full_name !== existingCandidate.fullName
  ) {
    patch.fullNameSource = 'manual';
  }
  if (
    body.retention_expires_at !== undefined &&
    existingCandidate &&
    !['closed_hired', 'closed_rejected', 'closed_withdrawn'].includes(
      existingCandidate.stage,
    ) &&
    !['closed_hired', 'closed_rejected', 'closed_withdrawn'].includes(
      patch.stage as string,
    )
  ) {
    return c.json(
      { error: 'Retention expires can only be set for closed candidates' },
      400,
    );
  }
  const candidate = updateHrCandidate(user.id, candidateId, patch);
  if (!candidate) return c.json({ error: 'Candidate not found' }, 404);
  createHrAudit({
    ownerUserId: user.id,
    actorId: user.id,
    action: 'candidate_updated',
    targetType: 'candidate',
    targetId: candidate.id,
    detail: { fields: Object.keys(parsed.data), source: 'web' },
  });
  const sync = await trySyncCandidate(
    user.id,
    user.id,
    candidate.id,
    new URL(c.req.url).origin,
  );
  return c.json({ candidate, feishu_sync: sync });
});

hrRoutes.post('/candidates/:candidateId/hard-delete', async (c) => {
  const user = c.get('user') as AuthUser;
  const candidateId = c.req.param('candidateId');
  const candidate = getHrCandidate(user.id, candidateId);
  if (!candidate) return c.json({ error: 'Candidate not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = HrCandidateHardDeleteSchema.safeParse(body);
  if (!parsed.success) return c.json(validationBody(parsed.error), 400);
  if (parsed.data.confirm_full_name !== candidate.fullName) {
    return c.json({ error: 'Confirmation name does not match' }, 400);
  }
  try {
    await deleteFeishuCandidateRecord({
      ownerUserId: user.id,
      candidateId: candidate.id,
    });
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error && error.message
            ? 'Feishu record deletion failed; local data was preserved'
            : 'Feishu record deletion failed; local data was preserved',
      },
      400,
    );
  }
  const resumeDir = path.resolve(
    DATA_DIR,
    'hr',
    'resumes',
    candidate.ownerUserId,
    candidate.id,
  );
  await fs.promises.rm(resumeDir, { recursive: true, force: true });
  const deleted = hardDeleteHrCandidate(user.id, candidate.id);
  createHrAudit({
    ownerUserId: user.id,
    actorId: user.id,
    action: 'candidate_hard_deleted',
    targetType: 'candidate',
    targetId: candidate.id,
    detail: {
      ...deleted,
      source: 'web',
      deleted_at: new Date().toISOString(),
    },
  });
  return c.json({ deleted: true });
});

hrRoutes.post('/candidates/:candidateId/reanalyze', async (c) => {
  const user = c.get('user') as AuthUser;
  const candidateId = c.req.param('candidateId');
  if (!getHrCandidate(user.id, candidateId))
    return c.json({ error: 'Candidate not found' }, 404);
  try {
    const started = startCandidateAnalysisWithJob(user.id, candidateId);
    const candidate = started.candidate;
    return c.json(
      {
        candidate,
        analysis_job_id: started.analysisJobId,
        analysis_status:
          candidate.aiStatus === 'running' ? 'running' : 'queued',
      },
      202,
    );
  } catch (error) {
    if (error instanceof HrCandidateAnalysisError)
      return c.json({ error: error.message }, 502);
    return c.json({ error: 'Analysis failed' }, 500);
  }
});

hrRoutes.post('/candidates/:candidateId/feedback', async (c) => {
  const user = c.get('user') as AuthUser;
  const candidateId = c.req.param('candidateId');
  const body = await c.req.json().catch(() => ({}));
  const parsed = HrFeedbackSchema.safeParse(body);
  if (!parsed.success) return c.json(validationBody(parsed.error), 400);
  const candidate = getHrCandidate(user.id, candidateId);
  if (!candidate) return c.json({ error: 'Candidate not found' }, 404);
  const round = createHrInterviewRound({
    ownerUserId: user.id,
    jobId: candidate.jobId,
    candidateId: candidate.id,
    stage: parsed.data.stage,
    interviewer: parsed.data.interviewer ?? null,
    scheduledAt: parsed.data.scheduled_at ?? null,
    completedAt: parsed.data.completed_at ?? null,
    outcome: parsed.data.outcome ?? null,
    feedbackText: parsed.data.feedback_text,
    score: null,
  });
  updateHrCandidate(user.id, candidateId, { stage: parsed.data.stage });
  let jobRule = null;
  try {
    jobRule = await runFeedbackAnalysis(user.id, candidateId, round.id);
  } catch (error) {
    if (error instanceof HrCandidateAnalysisError)
      return c.json({ error: error.message, round_id: round.id }, 502);
    return c.json(
      { error: 'Feedback analysis failed', round_id: round.id },
      500,
    );
  }
  const freshCandidate = getHrCandidate(user.id, candidateId)!;
  const sync = await trySyncCandidate(
    user.id,
    user.id,
    candidateId,
    new URL(c.req.url).origin,
  );
  return c.json(
    {
      round,
      candidate: freshCandidate,
      job_rule: jobRule,
      feishu_sync: sync,
    },
    201,
  );
});

hrRoutes.post(
  '/candidates/:candidateId/resumes/:resumeId/replace',
  hrResumeUploadBodyLimit,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const candidateId = c.req.param('candidateId');
    const resumeId = c.req.param('resumeId');
    const candidate = getHrCandidate(user.id, candidateId);
    const oldResume = getHrResume(user.id, resumeId);
    if (!candidate || !oldResume || oldResume.candidateId !== candidate.id)
      return c.json({ error: 'Resume not found' }, 404);
    const job = getHrJob(user.id, candidate.jobId);
    if (!job) return c.json({ error: 'Job not found' }, 404);
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File))
      return c.json({ error: 'A resume file is required' }, 400);
    if (file.size > HR_RESUME_MAX_BYTES)
      return c.json({ error: 'Resume file exceeds 10MB' }, 400);
    const content = Buffer.from(await file.arrayBuffer());
    try {
      const result = await ingestResume({
        ownerUserId: user.id,
        actorId: user.id,
        job,
        fileName: file.name,
        mimeType: file.type || null,
        content,
        source: candidate.source,
        sourceUrl: candidate.sourceUrl,
        candidateId: candidate.id,
      });
      await removeResumeFile(oldResume);
      const updatedCandidate = updateHrCandidate(user.id, candidate.id, {
        aiStatus: 'pending',
        aiError: null,
      });
      if (!updatedCandidate)
        return c.json({ error: 'Candidate not found' }, 404);
      createHrAudit({
        ownerUserId: user.id,
        actorId: user.id,
        action: 'resume_replaced',
        targetType: 'candidate',
        targetId: candidate.id,
        detail: {
          old_resume_id: oldResume.id,
          new_resume_id: result.resume.id,
        },
      });
      const sync = await trySyncCandidate(
        user.id,
        user.id,
        candidate.id,
        new URL(c.req.url).origin,
      );
      return c.json(
        {
          candidate: updatedCandidate,
          resume: publicResume(result.resume),
          feishu_sync: sync,
        },
        201,
      );
    } catch (error) {
      if (error instanceof HrImportError)
        return c.json({ error: error.message }, 400);
      return c.json({ error: 'Resume replacement failed' }, 500);
    }
  },
);

hrRoutes.get('/resumes/:resumeId/view', (c) => {
  const user = c.get('user') as AuthUser;
  const resume = getHrResume(user.id, c.req.param('resumeId'));
  if (!resume || !fs.existsSync(resume.filePath))
    return c.json({ error: 'Resume not found' }, 404);
  return resumeFileResponse(resume, 'view');
});

hrRoutes.get('/resumes/:resumeId/download', async (c) => {
  const user = c.get('user') as AuthUser;
  const resume = getHrResume(user.id, c.req.param('resumeId'));
  if (!resume || !fs.existsSync(resume.filePath))
    return c.json({ error: 'Resume not found' }, 404);
  return resumeFileResponse(resume, 'download');
});

hrRoutes.delete('/resumes/:resumeId', async (c) => {
  const user = c.get('user') as AuthUser;
  const resume = getHrResume(user.id, c.req.param('resumeId'));
  if (!resume) return c.json({ error: 'Resume not found' }, 404);
  try {
    await removeResumeFile(resume);
  } catch (error) {
    if (error instanceof HrImportError)
      return c.json({ error: error.message }, 400);
    return c.json({ error: 'Resume deletion failed' }, 500);
  }
  createHrAudit({
    ownerUserId: user.id,
    actorId: user.id,
    action: 'resume_deleted',
    targetType: 'candidate',
    targetId: resume.candidateId,
    detail: { resume_id: resume.id },
  });
  const sync = await trySyncCandidate(
    user.id,
    user.id,
    resume.candidateId,
    new URL(c.req.url).origin,
  );
  return c.json({ candidate_id: resume.candidateId, feishu_sync: sync });
});

hrRoutes.post('/jobs/:jobId/market-analysis', async (c) => {
  const user = c.get('user') as AuthUser;
  const jobId = c.req.param('jobId');
  if (!getHrJob(user.id, jobId)) return c.json({ error: 'Job not found' }, 404);
  try {
    const analysis = await runMarketAnalysis(user.id, jobId);
    return c.json({ analysis });
  } catch (error) {
    if (error instanceof HrCandidateAnalysisError)
      return c.json({ error: error.message }, 502);
    return c.json({ error: 'Market analysis failed' }, 500);
  }
});

hrRoutes.get('/feishu/status', (c) => {
  const user = c.get('user') as AuthUser;
  const config = getHrFeishuConfig(user.id);
  const lastSync = listLatestHrFeishuSync(user.id);
  return c.json({
    status: {
      configured: Boolean(config),
      enabled: config?.enabled ?? false,
      lastSyncedAt: lastSync?.lastSyncedAt ?? null,
      lastStatus: config ? (lastSync?.status ?? 'not_synced') : null,
      lastError: lastSync?.error ?? null,
    },
  });
});

hrRoutes.get('/analytics', (c) => {
  const user = c.get('user') as AuthUser;
  const jobs = listHrJobs(user.id);
  const candidates = listHrCandidates(user.id, { limit: 500 });
  const rounds = listAllHrInterviewRounds(user.id);
  const analysisJobs = listHrAnalysisJobs(user.id, undefined, 2000);
  return c.json({
    analytics: buildAnalytics(jobs, candidates, rounds, analysisJobs),
  });
});

hrRoutes.get('/questions', (c) => {
  const user = c.get('user') as AuthUser;
  const pagination = parsePagination(c);
  if ('error' in pagination) return c.json({ error: pagination.error }, 400);
  if (pagination.enabled) {
    const page = listHrQuestionsPaged(user.id, {
      search: c.req.query('search') || undefined,
      category: c.req.query('category') || undefined,
      limit: pagination.pageSize,
      offset: (pagination.page - 1) * pagination.pageSize,
    });
    return c.json({
      items: page.items,
      categories: page.categories,
      ...paginationMeta(pagination.page, pagination.pageSize, page.total),
    });
  }
  const jobs = listHrJobs(user.id);
  const candidates = listHrCandidates(user.id, { limit: 500 });
  const questions = listAllHrQuestions(user.id);
  const items = buildQuestionLibrary(jobs, candidates, questions);
  return c.json({
    items,
    categories: [...new Set(items.map((item) => item.question.category))],
  });
});

hrRoutes.get('/feishu/config', (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({
    config: publicFeishuConfig(getHrFeishuConfig(user.id)),
  });
});

hrRoutes.post('/feishu/test', async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = HrFeishuConfigSchema.safeParse(body);
  if (!parsed.success) return c.json(validationBody(parsed.error), 400);
  const config = {
    ownerUserId: user.id,
    channelAccountId: parsed.data.channel_account_id,
    appToken: parsed.data.app_token,
    tableId: parsed.data.table_id,
    fieldMapping: parsed.data.field_mapping,
    enabled: parsed.data.enabled,
  };
  try {
    const result = await testFeishuConfig(config, user.id);
    createHrAudit({
      ownerUserId: user.id,
      actorId: user.id,
      action: 'feishu_config_tested',
      targetType: 'feishu_config',
      targetId: parsed.data.channel_account_id,
      detail: { missing_fields: result.missingFields },
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof HrFeishuError)
      return c.json({ error: error.message }, 400);
    return c.json({ error: 'Feishu connection test failed' }, 500);
  }
});

hrRoutes.put('/feishu/config', async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = HrFeishuConfigSchema.safeParse(body);
  if (!parsed.success) return c.json(validationBody(parsed.error), 400);
  const account = getChannelAccountForUser(
    parsed.data.channel_account_id,
    user.id,
  );
  if (!account || account.provider !== 'feishu') {
    return c.json({ error: 'Feishu channel account not found' }, 404);
  }
  const config = upsertHrFeishuConfig({
    ownerUserId: user.id,
    channelAccountId: parsed.data.channel_account_id,
    appToken: parsed.data.app_token,
    tableId: parsed.data.table_id,
    fieldMapping: parsed.data.field_mapping,
    enabled: parsed.data.enabled,
  });
  createHrAudit({
    ownerUserId: user.id,
    actorId: user.id,
    action: 'feishu_config_saved',
    targetType: 'feishu_config',
    targetId: config.id,
    detail: { enabled: config.enabled },
  });
  return c.json({ config: publicFeishuConfig(config) });
});

hrRoutes.post('/candidates/:candidateId/feishu/sync', async (c) => {
  const user = c.get('user') as AuthUser;
  const candidateId = c.req.param('candidateId');
  if (!getHrCandidate(user.id, candidateId))
    return c.json({ error: 'Candidate not found' }, 404);
  try {
    const result = await syncCandidateToFeishu({
      ownerUserId: user.id,
      actorId: user.id,
      candidateId,
      baseUrl: new URL(c.req.url).origin,
    });
    createHrAudit({
      ownerUserId: user.id,
      actorId: user.id,
      action: 'feishu_synced',
      targetType: 'candidate',
      targetId: candidateId,
      detail: { record_id: result.recordId, source: 'web' },
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof HrFeishuError)
      return c.json({ error: error.message }, 400);
    return c.json({ error: 'Feishu sync failed' }, 500);
  }
});
