import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

import {
  bindHrDatabase,
  createHrAudit,
  createHrAnalysisJob,
  createHrCandidate,
  createHrInterviewRound,
  createHrJob,
  createHrResume,
  getLatestHrMatch,
  createHrJobRule,
  getActiveHrJobRule,
  listHrJobRules,
  setHrJobRuleStatus,
  archiveHrJobRulesForJob,
  replaceHrQuestions,
  createHrSchema,
  getHrCandidate,
  getHrFeishuConfig,
  getHrFeishuSync,
  getHrJob,
  listHrCandidates,
  listAllHrInterviewRounds,
  listAllHrQuestions,
  markHrAnalysisStatus,
  updateHrCandidate,
  upsertHrFeishuConfig,
  upsertHrFeishuSync,
} from '../src/hr/store.js';
import {
  buildAnalytics,
  buildJobStats,
  buildOverview,
  buildQuestionLibrary,
} from '../src/hr/reports.js';
import { HrFeishuConfigSchema } from '../src/hr/schemas.js';
import { HrFeedbackSchema } from '../src/hr/schemas.js';
import { HR_STAGE_LABELS } from '../src/hr/types.js';
import {
  candidatePayload,
  formatFeishuUpdatedAt,
} from '../src/hr/feishu.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createHrSchema(db);
  bindHrDatabase(db);
});

function createOwnerJob(ownerUserId: string) {
  return createHrJob({
    ownerUserId,
    title: 'Backend Engineer',
    department: 'R&D',
    location: 'Shanghai',
    level: 'Intern',
    salaryRange: '200-300',
    status: 'active',
    jdText: 'Node.js API development',
    keywords: ['node'],
    responsibilities: ['Build APIs'],
    requirements: ['Node.js'],
    preferred: ['Docker'],
    techStack: ['Node.js'],
  });
}

describe('HR workbench store', () => {
  test('creates jobs and enforces owner isolation', () => {
    const job = createOwnerJob('owner-1');
    expect(getHrJob('owner-1', job.id)?.title).toBe('Backend Engineer');
    expect(getHrJob('owner-2', job.id)).toBeUndefined();
  });

  test('moves a candidate through stages and filters by stage', () => {
    const job = createOwnerJob('owner-1');
    const candidate = createHrCandidate({
      ownerUserId: 'owner-1',
      jobId: job.id,
      fullName: 'Ada',
      email: null,
      phone: null,
      location: null,
      source: 'upload',
      sourceUrl: null,
      yearsExperience: 2,
      summary: null,
      recommendation: null,
      overallScore: null,
      profile: null,
    });
    expect(candidate.stage).toBe('pending_tech_screen');
    const resume = createHrResume({
      ownerUserId: 'owner-1',
      candidateId: candidate.id,
      jobId: job.id,
      filePath: 'C:/protected/resume.pdf',
      fileName: 'resume.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 128,
      sha256: 'hash',
      extractedText: 'Node.js experience',
      parserVersion: 'iclaw-hr-v1',
      parseStatus: 'pending',
    });
    expect(resume.parseStatus).toBe('pending');
    const updated = updateHrCandidate('owner-1', candidate.id, {
      stage: 'interview_1',
      overallScore: 82,
      recommendation: 'fit',
    });
    expect(updated?.stage).toBe('interview_1');
    createHrAudit({
      ownerUserId: 'owner-1',
      actorId: 'owner-1',
      action: 'candidate_updated',
      targetType: 'candidate',
      targetId: candidate.id,
      detail: { stage: 'interview_1' },
    });
    expect(listHrCandidates('owner-1', { stage: 'interview_1' })).toHaveLength(
      1,
    );
    expect(getHrCandidate('owner-2', candidate.id)).toBeUndefined();
  });

  test('stores interview rounds and replaces generated questions', async () => {
    const job = createOwnerJob('owner-1');
    const candidate = createHrCandidate({
      ownerUserId: 'owner-1',
      jobId: job.id,
      fullName: 'Grace',
      email: null,
      phone: null,
      location: null,
      source: 'boss_opencli',
      sourceUrl: null,
      yearsExperience: 1,
      summary: null,
      recommendation: null,
      overallScore: null,
      profile: null,
    });
    const round = createHrInterviewRound({
      ownerUserId: 'owner-1',
      jobId: job.id,
      candidateId: candidate.id,
      stage: 'interview_1',
      interviewer: 'Tech Lead',
      scheduledAt: null,
      completedAt: null,
      outcome: 'hold',
      feedbackText: 'Asked database indexing beyond JD.',
      score: null,
    });
    expect(round.feedbackText).toContain('indexing');
    const { replaceHrQuestions, listHrQuestions } =
      await import('../src/hr/store.js');
    replaceHrQuestions([
      {
        ownerUserId: 'owner-1',
        jobId: job.id,
        candidateId: candidate.id,
        category: 'technical',
        question: 'Describe your Node.js project.',
        rationale: 'Verify experience.',
        expectedSignal: 'Concrete ownership.',
        priority: 1,
        model: null,
      },
    ]);
    expect(listHrQuestions('owner-1', candidate.id)).toHaveLength(1);
  });

  test('keeps one Feishu config and idempotent sync state per candidate', () => {
    const first = upsertHrFeishuConfig({
      ownerUserId: 'owner-1',
      channelAccountId: 'account-1',
      appToken: 'app-token',
      tableId: 'table-1',
      fieldMapping: { candidate_id: '候选人ID' },
      enabled: true,
    });
    const second = upsertHrFeishuConfig({
      ownerUserId: 'owner-1',
      channelAccountId: 'account-2',
      appToken: 'app-token-2',
      tableId: 'table-2',
      fieldMapping: { candidate_id: 'ID' },
      enabled: false,
    });
    expect(first.id).toBe(second.id);
    expect(getHrFeishuConfig('owner-1')?.channelAccountId).toBe('account-2');
    const sync = upsertHrFeishuSync('owner-1', 'candidate-1', second.id, {
      status: 'synced',
      recordId: 'rec-1',
      payloadHash: 'hash-1',
      attempt: 1,
    });
    const updated = upsertHrFeishuSync('owner-1', 'candidate-1', second.id, {
      recordId: 'rec-1',
      payloadHash: 'hash-2',
      status: 'synced',
      attempt: 2,
    });
    expect(sync.candidateId).toBe('candidate-1');
    expect(updated.attempt).toBe(2);
    expect(getHrFeishuSync('owner-1', 'candidate-1')?.payloadHash).toBe(
      'hash-2',
    );
  });

  test('uses candidate_id in the default Feishu field mapping', () => {
    const parsed = HrFeishuConfigSchema.safeParse({
      channel_account_id: 'account-1',
      app_token: 'app-token',
      table_id: 'table-1',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.field_mapping.candidate_id).toBe(
      '候选人ID',
    );
    const unknownField = HrFeishuConfigSchema.safeParse({
      channel_account_id: 'account-1',
      app_token: 'app-token',
      table_id: 'table-1',
      field_mapping: { candidate_id: '候选人ID', unknown_field: '无效' },
    });
    expect(unknownField.success).toBe(false);
  });

  test('requires an HTTPS source URL for resume link imports', async () => {
    const { HrResumeLinkImportSchema } = await import('../src/hr/schemas.js');
    const base = { job_id: 'job-1' };
    expect(
      HrResumeLinkImportSchema.safeParse({
        ...base,
        source_url: 'http://example.com',
      }).success,
    ).toBe(false);
    expect(HrResumeLinkImportSchema.safeParse(base).success).toBe(false);
    expect(
      HrResumeLinkImportSchema.safeParse({
        ...base,
        source_url: `https://example.com/${'a'.repeat(1100)}`,
      }).success,
    ).toBe(false);
    expect(
      HrResumeLinkImportSchema.safeParse({
        ...base,
        source_url: 'https://example.com/resume',
      }).success,
    ).toBe(true);
  });

  test('rejects empty and oversized resume files', async () => {
    const { ingestResume, HR_RESUME_MAX_BYTES } =
      await import('../src/hr/import.js');
    const job = createOwnerJob('owner-1');
    await expect(
      ingestResume({
        ownerUserId: 'owner-1',
        actorId: 'owner-1',
        job,
        fileName: 'empty.pdf',
        content: Buffer.alloc(0),
        source: 'upload',
      }),
    ).rejects.toThrow('Resume file is empty');
    await expect(
      ingestResume({
        ownerUserId: 'owner-1',
        actorId: 'owner-1',
        job,
        fileName: 'large.pdf',
        content: Buffer.alloc(HR_RESUME_MAX_BYTES + 1),
        source: 'upload',
      }),
    ).rejects.toThrow('exceeds 10MB');
  });

  test('rejects resume formats outside the upload whitelist', async () => {
    const { ingestResume } = await import('../src/hr/import.js');
    const job = createOwnerJob('owner-1');
    for (const fileName of ['resume.markdown', 'resume.rtf']) {
      await expect(
        ingestResume({
          ownerUserId: 'owner-1',
          actorId: 'owner-1',
          job,
          fileName,
          content: Buffer.from('resume text'),
          source: 'upload',
        }),
      ).rejects.toThrow('Unsupported resume file type');
    }
  });

  test('aggregates job stats and overview with owner isolation', () => {
    const job = createOwnerJob('owner-1');
    const candidate = createHrCandidate({
      ownerUserId: 'owner-1',
      jobId: job.id,
      fullName: 'Ada',
      email: null,
      phone: null,
      location: null,
      source: 'upload',
      sourceUrl: null,
      yearsExperience: 2,
      summary: 'Node.js engineer',
      recommendation: 'fit',
      overallScore: 82,
      profile: null,
    });
    const analysisJob = createHrAnalysisJob({
      ownerUserId: 'owner-1',
      type: 'jd_match',
      targetId: candidate.id,
      inputHash: 'hash',
      model: null,
    });
    const failedAnalysis = markHrAnalysisStatus(
      'owner-1',
      analysisJob.id,
      'failed',
      {
        error: 'model unavailable',
      },
    );
    expect(buildJobStats(job.id, [candidate])).toMatchObject({
      total: 1,
      pendingTechScreen: 1,
      interviewing: 0,
      offerSent: 0,
    });
    const overview = buildOverview([job], [candidate], [failedAnalysis!]);
    expect(overview.metrics).toMatchObject({
      activeJobs: 1,
      totalCandidates: 1,
      pendingTechScreen: 1,
      aiFailed: 1,
    });
    expect(overview.pendingItems[0]?.title).toContain('Ada');
    expect(buildJobStats(job.id, [])).toMatchObject({ total: 0 });
  });

  test('aggregates analytics and question library without cross-owner leakage', () => {
    const job = createOwnerJob('owner-1');
    const candidate = createHrCandidate({
      ownerUserId: 'owner-1',
      jobId: job.id,
      fullName: 'Grace',
      email: null,
      phone: null,
      location: null,
      source: 'boss_opencli',
      sourceUrl: null,
      yearsExperience: 1,
      summary: null,
      recommendation: null,
      overallScore: null,
      riskFlags: ['missing_auth_experience'],
      profile: null,
    });
    createHrInterviewRound({
      ownerUserId: 'owner-1',
      jobId: job.id,
      candidateId: candidate.id,
      stage: 'interview_1',
      interviewer: 'Tech Lead',
      scheduledAt: null,
      completedAt: null,
      outcome: 'hold',
      feedbackText: 'Asked database indexing beyond JD.',
      score: null,
    });
    replaceHrQuestionsForTest('owner-1', job.id, candidate.id);
    const rounds = listAllHrInterviewRounds('owner-1');
    const analysisJobs = [
      createHrAnalysisJob({
        ownerUserId: 'owner-1',
        type: 'feedback_analysis',
        targetId: rounds[0]!.id,
        inputHash: 'hash',
        model: null,
      }),
    ];
    const analytics = buildAnalytics([job], [candidate], rounds, analysisJobs);
    expect(analytics.stageCounts[0]).toMatchObject({ count: 1 });
    expect(analytics.jobDiagnostics[0]?.closedRejected).toBe(0);
    expect(listAllHrInterviewRounds('owner-2')).toHaveLength(0);
    expect(
      buildQuestionLibrary([job], [candidate], listAllHrQuestions('owner-1')),
    ).toHaveLength(1);
    expect(
      buildQuestionLibrary([job], [candidate], listAllHrQuestions('owner-2')),
    ).toHaveLength(0);
  });

  test('imports resumes without automatic AI matching', async () => {
    const { ingestResume } = await import('../src/hr/import.js');
    const job = createOwnerJob('owner-1');
    const result = await ingestResume({
      ownerUserId: 'owner-1',
      actorId: 'owner-1',
      job,
      fileName: 'resume.txt',
      content: Buffer.from('Node.js API engineer with five years experience.'),
      source: 'upload',
    });
    expect(result.candidate.aiStatus).toBe('pending');
    expect(result.candidate.overallScore).toBeNull();
    expect(result.analysisError).toBeNull();
    expect(getLatestHrMatch('owner-1', result.candidate.id)).toBeUndefined();
  });

  test('reuses an existing candidate when email or resume hash duplicates', async () => {
    const { ingestResume } = await import('../src/hr/import.js');
    const job = createOwnerJob('owner-1');
    const candidate = {
      full_name: 'Ada',
      email: 'Ada@Example.com ',
      phone: null,
      location: null,
    };
    const first = await ingestResume({
      ownerUserId: 'owner-1',
      actorId: 'owner-1',
      job,
      fileName: 'ada-v1.txt',
      content: Buffer.from('Node.js API engineer with five years experience.'),
      source: 'upload',
      candidate,
    });
    const second = await ingestResume({
      ownerUserId: 'owner-1',
      actorId: 'owner-1',
      job,
      fileName: 'ada-v2.txt',
      content: Buffer.from('Node.js API engineer with database experience.'),
      source: 'upload',
      candidate,
    });
    expect(second.candidate.id).toBe(first.candidate.id);
    expect(second.duplicate).toBe(true);
    expect(
      listHrCandidates('owner-1', { jobId: job.id, limit: 10 }),
    ).toHaveLength(1);
  });

  test('creates, activates, and archives job scoring rules with owner isolation', () => {
    const job = createOwnerJob('owner-1');
    const first = createHrJobRule({
      ownerUserId: 'owner-1',
      jobId: job.id,
      status: 'draft',
      sourceRoundId: null,
      summary: 'Prefer database depth.',
      newRequirements: ['Database indexing'],
      jdGaps: [],
      contradictions: [],
      decisionSuggestion: 'review',
      model: null,
    });
    const activeFirst = setHrJobRuleStatus('owner-1', first.id, 'active');
    expect(activeFirst?.status).toBe('active');
    const second = createHrJobRule({
      ownerUserId: 'owner-1',
      jobId: job.id,
      status: 'draft',
      sourceRoundId: null,
      summary: 'Weight project ownership higher.',
      newRequirements: ['Project ownership'],
      jdGaps: ['System design'],
      contradictions: [],
      decisionSuggestion: 'advance',
      model: null,
    });
    const activeSecond = setHrJobRuleStatus('owner-1', second.id, 'active');
    expect(activeSecond?.ruleVersion).toBe(2);
    expect(getActiveHrJobRule('owner-1', job.id)?.id).toBe(second.id);
    expect(
      listHrJobRules('owner-1', job.id).find((rule) => rule.id === first.id)
        ?.status,
    ).toBe('archived');
    archiveHrJobRulesForJob('owner-1', job.id);
    expect(getActiveHrJobRule('owner-1', job.id)).toBeUndefined();
    expect(listHrJobRules('owner-2', job.id)).toHaveLength(0);
  });

  test('limits feedback-triggered rule analysis to interview stages', () => {
    expect(
      HrFeedbackSchema.safeParse({
        stage: 'pending_tech_screen',
        feedback_text: 'Technical screening notes',
      }).success,
    ).toBe(false);
    expect(
      HrFeedbackSchema.safeParse({
        stage: 'interview_1',
        feedback_text:
          'The interviewer tested database indexing beyond the JD.',
      }).success,
    ).toBe(true);
  });

  test('writes Chinese stage labels to Feishu payloads', () => {
    const config = {
      id: 'config-1',
      ownerUserId: 'owner-1',
      channelAccountId: 'account-1',
      appToken: 'app-token',
      tableId: 'table-1',
      fieldMapping: { candidate_id: '候选人ID', stage: '阶段' },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    for (const [stage, label] of Object.entries(HR_STAGE_LABELS)) {
      const payload = candidatePayload(
        config,
        'candidate-1',
        'Ada',
        'Backend',
        stage,
        80,
        'fit',
        null,
        'upload',
        new Date().toISOString(),
      );
      expect(payload['阶段']).toBe(label);
      expect(payload['候选人ID']).toBe('candidate-1');
    }
  });

  test('summarizes recommendation and adapts payload to Bitable field types', () => {
    const config = {
      id: 'config-1',
      ownerUserId: 'owner-1',
      channelAccountId: 'account-1',
      appToken: 'app-token',
      tableId: 'table-1',
      fieldMapping: {
        candidate_id: '候选人ID',
        score: '评分',
        recommendation: '推荐结论',
        resume_url: '简历链接',
        updated_at: '更新时间',
      },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const payload = candidatePayload(
      config,
      'candidate-1',
      'Ada',
      'Backend',
      'pending_tech_screen',
      82,
      'fit',
      'https://example.com/resume.pdf',
      'upload',
      '2026-09-08T00:00:00.000Z',
      [
        { field_name: '候选人ID', type: 1 },
        { field_name: '评分', type: 1 },
        { field_name: '推荐结论', type: 1 },
        { field_name: '简历链接', type: 15 },
        { field_name: '更新时间', type: 1 },
      ],
      '具备 Go API 经验。熟悉 PostgreSQL。缺少权限模型实践。',
    );
    expect(payload['评分']).toBe('82');
    expect(payload['推荐结论']).toBe(
      '匹配等级：匹配。具备 Go API 经验。熟悉 PostgreSQL。缺少权限模型实践。',
    );
    expect(payload['简历链接']).toEqual({
      text: 'https://example.com/resume.pdf',
      link: 'https://example.com/resume.pdf',
    });
    expect(payload['更新时间']).toBe('2026年9月8日 08:00:00');
  });

  test('formats Feishu updated_at as UTC+8 Chinese text', () => {
    expect(formatFeishuUpdatedAt('2026-09-09T04:30:45.000Z')).toBe(
      '2026年9月9日 12:30:45',
    );
    expect(formatFeishuUpdatedAt('2026-09-08T16:30:45.000Z')).toBe(
      '2026年9月9日 00:30:45',
    );
  });

  test('writes and clears the three interviewer fields in Feishu payloads', () => {
    const config = {
      id: 'config-1',
      ownerUserId: 'owner-1',
      channelAccountId: 'account-1',
      appToken: 'app-token',
      tableId: 'table-1',
      fieldMapping: {
        candidate_id: '候选人ID',
        interviewer_1: '一面面试官',
        interviewer_2: '二面面试官',
        interviewer_3: '三面面试官',
      },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const definitions = [
      { field_name: '候选人ID', type: 1 },
      { field_name: '一面面试官', type: 1 },
      { field_name: '二面面试官', type: 1 },
      { field_name: '三面面试官', type: 1 },
    ];
    const payload = candidatePayload(
      config,
      'candidate-1',
      'Ada',
      'Backend',
      'interview_2',
      null,
      null,
      null,
      'upload',
      new Date().toISOString(),
      definitions,
      null,
      ['Alice', 'Bob', null],
    );
    expect(payload['一面面试官']).toBe('Alice');
    expect(payload['二面面试官']).toBe('Bob');
    expect(payload['三面面试官']).toBeNull();
  });

  test('rejects updated_at mapped to a Bitable date field', () => {
    const config = {
      id: 'config-1',
      ownerUserId: 'owner-1',
      channelAccountId: 'account-1',
      appToken: 'app-token',
      tableId: 'table-1',
      fieldMapping: { candidate_id: '候选人ID', updated_at: '更新时间' },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(() =>
      candidatePayload(
        config,
        'candidate-1',
        'Ada',
        'Backend',
        'pending_tech_screen',
        80,
        'fit',
        null,
        'upload',
        '2026-09-09T04:30:45.000Z',
        [
          { field_name: '候选人ID', type: 1 },
          { field_name: '更新时间', type: 5 },
        ],
      ),
    ).toThrowError(/must be a text field for updated_at/);
  });

  test('omits empty scores and missing optional Bitable fields', () => {
    const config = {
      id: 'config-1',
      ownerUserId: 'owner-1',
      channelAccountId: 'account-1',
      appToken: 'app-token',
      tableId: 'table-1',
      fieldMapping: {
        candidate_id: '候选人ID',
        score: '评分',
        recommendation: '推荐结论',
      },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const payload = candidatePayload(
      config,
      'candidate-1',
      'Ada',
      'Backend',
      'pending_tech_screen',
      null,
      null,
      null,
      'upload',
      new Date().toISOString(),
      [{ field_name: '候选人ID', type: 1 }],
    );
    expect(payload['评分']).toBeUndefined();
    expect(payload['推荐结论']).toBeUndefined();
  });

  test('clears the Feishu resume link when no resume remains', () => {
    const config = {
      id: 'config-1',
      ownerUserId: 'owner-1',
      channelAccountId: 'account-1',
      appToken: 'app-token',
      tableId: 'table-1',
      fieldMapping: { candidate_id: '候选人ID', resume_url: '简历链接' },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const payload = candidatePayload(
      config,
      'candidate-1',
      'Ada',
      'Backend',
      'pending_tech_screen',
      null,
      null,
      null,
      'upload',
      new Date().toISOString(),
      [
        { field_name: '候选人ID', type: 1 },
        { field_name: '简历链接', type: 15 },
      ],
    );
    expect(payload['简历链接']).toBeNull();
  });

  test('keeps complete recommendation text and falls back without rationale', () => {
    const config = {
      id: 'config-1',
      ownerUserId: 'owner-1',
      channelAccountId: 'account-1',
      appToken: 'app-token',
      tableId: 'table-1',
      fieldMapping: {
        candidate_id: '候选人ID',
        recommendation: '推荐结论',
      },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const payload = candidatePayload(
      config,
      'candidate-1',
      'Ada',
      'Backend',
      'pending_tech_screen',
      80,
      'borderline',
      null,
      'upload',
      new Date().toISOString(),
      [
        { field_name: '候选人ID', type: 1 },
        { field_name: '推荐结论', type: 1 },
      ],
      '具备 Node.js API 经验；技术栈与 JD 重叠，但缺少权限模型实践…',
    );
    expect(payload['推荐结论']).toBe(
      '匹配等级：边界匹配。具备 Node.js API 经验；技术栈与 JD 重叠，但缺少权限模型实践。',
    );

    const fallbackPayload = candidatePayload(
      config,
      'candidate-1',
      'Ada',
      'Backend',
      'pending_tech_screen',
      80,
      'strong_fit',
      null,
      'upload',
      new Date().toISOString(),
      [
        { field_name: '候选人ID', type: 1 },
        { field_name: '推荐结论', type: 1 },
      ],
      null,
    );
    expect(fallbackPayload['推荐结论']).toBe('匹配等级：强匹配。');
  });

  test('rejects recommendation mapped to a single-select field', () => {
    const config = {
      id: 'config-1',
      ownerUserId: 'owner-1',
      channelAccountId: 'account-1',
      appToken: 'app-token',
      tableId: 'table-1',
      fieldMapping: {
        candidate_id: '候选人ID',
        recommendation: '推荐结论',
      },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(() =>
      candidatePayload(
        config,
        'candidate-1',
        'Ada',
        'Backend',
        'pending_tech_screen',
        80,
        'fit',
        null,
        'upload',
        new Date().toISOString(),
        [
          { field_name: '候选人ID', type: 1 },
          { field_name: '推荐结论', type: 3 },
        ],
        '具备 Go API 经验。',
      ),
    ).toThrowError(/must be a text field for the recommendation/);
  });
});

function replaceHrQuestionsForTest(
  ownerUserId: string,
  jobId: string,
  candidateId: string,
) {
  replaceHrQuestions([
    {
      ownerUserId,
      jobId,
      candidateId,
      category: 'technical',
      question: 'Describe your Node.js project.',
      rationale: 'Verify experience.',
      expectedSignal: 'Concrete ownership.',
      priority: 1,
      model: null,
    },
  ]);
}
