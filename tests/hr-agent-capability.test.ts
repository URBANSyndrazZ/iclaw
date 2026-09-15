import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

import {
  bindHrDatabase,
  createHrCandidate,
  createHrJob,
  createHrSchema,
  getHrJob,
  listHrJobs,
  softDeleteHrJob,
  updateHrCandidate,
} from '../src/hr/store.js';
import {
  executeHrAgentCapability,
  isHrJobExpired,
  scanExpiredHrJobs,
} from '../src/hr/agent-capability.js';
import { HR_MOCK_MODEL_ENV } from '../src/hr/ai.js';
import { cleanResumeFileName } from '../src/hr/import.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createHrSchema(db);
  bindHrDatabase(db);
});

function createJob(
  ownerUserId: string,
  title = 'Backend Engineer',
  expiresAt: string | null = null,
) {
  return createHrJob({
    ownerUserId,
    title,
    department: null,
    location: null,
    level: null,
    salaryRange: null,
    status: 'active',
    jdText: 'Node.js API development',
    keywords: [],
    responsibilities: [],
    requirements: [],
    preferred: [],
    techStack: [],
    expiresAt,
  });
}

function createCandidate(
  ownerUserId: string,
  jobId: string,
  fullName: string,
) {
  return createHrCandidate({
    ownerUserId,
    jobId,
    fullName,
    fullNameSource: 'provided',
    email: 'private@example.com',
    phone: '+8610000000000',
    location: null,
    source: 'upload',
    sourceUrl: null,
    yearsExperience: 2,
    summary: 'Node.js engineer',
    recommendation: null,
    overallScore: 80,
    profile: null,
  });
}

function countTable(table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

describe('HR Agent capability', () => {
  test('lists jobs with lifecycle information and owner isolation', async () => {
    const job = createJob('owner-1', 'Backend Engineer');
    const hidden = createJob('owner-2', 'Hidden');
    const result = await executeHrAgentCapability(
      'owner-1',
      'list_jobs',
      {},
      'http://localhost',
    );
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      id: job.id,
      title: 'Backend Engineer',
      status: 'active',
      expired: false,
      deleted: false,
    });
    expect(
      await executeHrAgentCapability('owner-2', 'list_jobs', {}, 'http://localhost'),
    ).toEqual({ jobs: [expect.objectContaining({ id: hidden.id })] });
    expect(
      await executeHrAgentCapability('owner-3', 'list_jobs', {}, 'http://localhost'),
    ).toEqual({ jobs: [] });
  });

  test('returns a sanitized candidate summary without PII', async () => {
    const job = createJob('owner-1');
    const candidate = createCandidate('owner-1', job.id, 'Ada');
    const result = await executeHrAgentCapability(
      'owner-1',
      'get_candidate',
      { candidate_id: candidate.id },
      'http://localhost',
    );
    const text = JSON.stringify(result);
    expect(text).toContain('Ada');
    expect(text).not.toContain('private@example.com');
    expect(text).not.toContain('+8610000000000');
    expect(result.candidate).not.toHaveProperty('email');
    expect(result.candidate).not.toHaveProperty('phone');
    expect(result.candidate).not.toHaveProperty('profile');
    expect(result.candidate).toEqual(expect.objectContaining({
      updatedAt: candidate.updatedAt,
    }));
    expect(result.piiNote).toContain('不通过 Agent 返回');
  });

  test('requires confirmation and unique candidate resolution for stage updates', async () => {
    const job = createJob('owner-1');
    const candidate = createCandidate('owner-1', job.id, 'Ada');
    await expect(
      executeHrAgentCapability(
        'owner-1',
        'update_candidate',
        { candidate_id: candidate.id, stage: 'interview_1' },
        'http://localhost',
      ),
    ).rejects.toThrow('explicit confirmation');

    const updated = await executeHrAgentCapability(
      'owner-1',
        'update_candidate',
      {
        candidate_id: candidate.id,
        stage: 'interview_1',
        confirmed: true,
        expected_updated_at: candidate.updatedAt,
      },
      'http://localhost',
    );
    expect(updated).toMatchObject({
      status: 'updated',
      oldStage: 'pending_tech_screen',
      newStage: 'interview_1',
      auditAction: 'candidate_stage_updated',
      auditActions: ['candidate_stage_updated'],
      feishuSync: { attempted: false, error: null },
    });
    expect((updated as { candidate: { updatedAt: string } }).candidate.updatedAt)
      .not.toBe(candidate.updatedAt);

    await expect(
      executeHrAgentCapability(
        'owner-1',
        'update_candidate',
        {
          candidate_id: candidate.id,
          stage: 'interview_2',
          confirmed: true,
          expected_updated_at: candidate.updatedAt,
        },
        'http://localhost',
      ),
    ).rejects.toThrow('Candidate was modified after it was read');
    const audits = db.prepare(
      "SELECT * FROM hr_audit_log WHERE action = 'candidate_stage_updated'",
    ).all();
    expect(audits).toHaveLength(1);
  });

  test('updates name and stage with separate audits and manual name source', async () => {
    const job = createJob('owner-1');
    const candidate = createCandidate('owner-1', job.id, 'Ada');
    const result = await executeHrAgentCapability(
      'owner-1',
      'update_candidate',
      {
        candidate_id: candidate.id,
        full_name: 'Ada Lovelace',
        stage: 'interview_1',
        expected_updated_at: candidate.updatedAt,
        confirmed: true,
      },
      'http://localhost',
    );
    expect(result).toMatchObject({
      status: 'updated',
      oldName: 'Ada',
      newName: 'Ada Lovelace',
      oldStage: 'pending_tech_screen',
      newStage: 'interview_1',
      auditActions: ['candidate_name_updated', 'candidate_stage_updated'],
      feishuSync: { attempted: false, error: null },
    });
    const audits = db.prepare(
      "SELECT action, COUNT(*) AS count FROM hr_audit_log WHERE action IN ('candidate_name_updated','candidate_stage_updated') GROUP BY action",
    ).all();
    expect(audits).toEqual([
      { action: 'candidate_name_updated', count: 1 },
      { action: 'candidate_stage_updated', count: 1 },
    ]);
  });

  test('updates talent pool and summary with separate audits and masked output', async () => {
    const job = createJob('owner-1');
    const candidate = createCandidate('owner-1', job.id, 'Ada');
    const result = await executeHrAgentCapability(
      'owner-1',
      'update_candidate',
      {
        candidate_id: candidate.id,
        talent_pool: true,
        summary: 'Email private@example.com, phone 13800000000.',
        expected_updated_at: candidate.updatedAt,
        confirmed: true,
      },
      'http://localhost',
    );
    expect(result).toMatchObject({
      status: 'updated',
      oldTalentPool: false,
      newTalentPool: true,
      auditActions: [
        'candidate_talent_pool_updated',
        'candidate_summary_updated',
      ],
      feishuSync: { attempted: false, error: null },
    });
    expect((result as { newSummary: string | null }).newSummary).toBe(
      'Email [联系方式已脱敏], phone [联系方式已脱敏].',
    );
    expect(JSON.stringify(result)).not.toContain('private@example.com');
    expect(JSON.stringify(result)).not.toContain('13800000000');
    expect(db.prepare(
      "SELECT action, COUNT(*) AS count FROM hr_audit_log WHERE action IN ('candidate_talent_pool_updated','candidate_summary_updated') GROUP BY action ORDER BY action",
    ).all()).toEqual([
      { action: 'candidate_summary_updated', count: 1 },
      { action: 'candidate_talent_pool_updated', count: 1 },
    ]);
  });

  test('rejects candidate updates without any changed field or confirmation', async () => {
    const job = createJob('owner-1');
    const candidate = createCandidate('owner-1', job.id, 'Ada');
    await expect(
      executeHrAgentCapability(
        'owner-1',
        'update_candidate',
        {
          candidate_id: candidate.id,
          talent_pool: false,
          summary: candidate.summary,
          expected_updated_at: candidate.updatedAt,
          confirmed: true,
        },
        'http://localhost',
      ),
    ).resolves.toMatchObject({ status: 'updated', auditActions: [] });
    await expect(
      executeHrAgentCapability(
        'owner-1',
        'update_candidate',
        {
          candidate_id: candidate.id,
          talent_pool: true,
          expected_updated_at: candidate.updatedAt,
        },
        'http://localhost',
      ),
    ).rejects.toThrow('explicit confirmation');
    expect(countTable('hr_audit_log')).toBe(0);
  });

  test('searches jobs and candidates without exposing PII or deleted jobs', async () => {
    const job = createJob('owner-1', 'Backend Engineer');
    const deletedJob = createJob('owner-1', 'Backend Legacy');
    const candidate = createCandidate('owner-1', job.id, 'Ada Search');
    await updateHrCandidate('owner-1', candidate.id, {
      summary: 'Reach private@example.com or 13800000000.',
    });
    softDeleteHrJob('owner-1', deletedJob.id, 'owner-1');
    const result = await executeHrAgentCapability(
      'owner-1',
      'search_aggregate',
      { query: 'backend', limit: 1 },
      'http://localhost',
    );
    expect(result).toMatchObject({
      scope: 'all',
      totals: { jobs: 1, candidates: 1 },
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain('Backend Legacy');
    expect(JSON.stringify(result)).not.toContain('private@example.com');
    expect(JSON.stringify(result)).not.toContain('13800000000');
    expect(result.candidates[0]).not.toHaveProperty('email');
    expect(result.candidates[0]).not.toHaveProperty('phone');
    expect(result.candidates[0]).not.toHaveProperty('profile');
    await expect(
      executeHrAgentCapability(
        'owner-2',
        'search_aggregate',
        { query: 'backend' },
        'http://localhost',
      ),
    ).resolves.toEqual({
      query: 'backend',
      scope: 'all',
      jobs: [],
      candidates: [],
      totals: { jobs: 0, candidates: 0 },
      truncated: false,
    });
  });

  test('starts and tracks job analysis with owner isolation', async () => {
    process.env[HR_MOCK_MODEL_ENV] = 'true';
    const job = createJob('owner-1');
    createCandidate('owner-1', job.id, 'Ada');
    const started = await executeHrAgentCapability(
      'owner-1',
      'start_job_analysis',
      { job_id: job.id },
      'http://localhost',
    );
    expect(started).toMatchObject({
      status: 'started',
      analysisStatus: 'queued',
    });
    const analysisJobId = (started as { analysisJobId: string }).analysisJobId;
    await new Promise((resolve) => setImmediate(resolve));
    const tracked = await executeHrAgentCapability(
      'owner-1',
      'get_analysis_job',
      { analysis_job_id: analysisJobId },
      'http://localhost',
    );
    expect(tracked.analysisJob).toMatchObject({
      id: analysisJobId,
      type: 'market_analysis',
      status: 'completed',
    });
    expect(tracked.analysisJob.candidate).toBeNull();
    await expect(
      executeHrAgentCapability(
        'owner-2',
        'get_analysis_job',
        { analysis_job_id: analysisJobId },
        'http://localhost',
      ),
    ).rejects.toThrow('Analysis job not found');
    delete process.env[HR_MOCK_MODEL_ENV];
  });

  test('records interview feedback, creates a draft rule, and masks candidate PII', async () => {
    process.env[HR_MOCK_MODEL_ENV] = 'true';
    const job = createJob('owner-1');
    const candidate = createCandidate('owner-1', job.id, 'Grace');
    const result = await executeHrAgentCapability(
      'owner-1',
      'submit_interview_feedback',
      {
        candidate_id: candidate.id,
        stage: 'interview_1',
        feedback_text: '候选人补充了一个新的部署自动化要求。',
        confirmed: true,
      },
      'http://localhost',
    );
    expect(result).toMatchObject({
      status: 'recorded',
      analysisStatus: 'completed',
      candidate: { stage: 'interview_1' },
      feishuSync: { attempted: false, error: null },
    });
    expect(JSON.stringify(result)).not.toContain(candidate.email!);
    expect(JSON.stringify(result)).not.toContain(candidate.phone!);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM hr_job_rules WHERE job_id = ? AND status = 'draft'",
    ).get(job.id)).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM hr_audit_log WHERE action = 'interview_feedback_submitted'",
    ).get()).toEqual({ count: 1 });
    delete process.env[HR_MOCK_MODEL_ENV];
  });

  test('requires confirmation before interview feedback is written', async () => {
    const job = createJob('owner-1');
    const candidate = createCandidate('owner-1', job.id, 'Grace');
    await expect(
      executeHrAgentCapability(
        'owner-1',
        'submit_interview_feedback',
        {
          candidate_id: candidate.id,
          stage: 'interview_1',
          feedback_text: 'feedback',
        },
        'http://localhost',
      ),
    ).rejects.toThrow('explicit confirmation');
    expect(countTable('hr_interview_rounds')).toBe(0);
  });

  test('cleans noisy resume filenames', () => {
    expect(cleanResumeFileName('张三-简历-2024-05-01-v2.pdf')).toBe('张三');
    expect(cleanResumeFileName('resume_张三_resume_20250101.pdf')).toBe('张三');
    expect(cleanResumeFileName('9f8e7d6c5b4a3210.docx')).toBe(
      '9f8e7d6c5b4a3210',
    );
  });

  test('does not update a stage when a name is ambiguous', async () => {
    const first = createJob('owner-1', 'Backend');
    const second = createJob('owner-1', 'Platform');
    createCandidate('owner-1', first.id, 'Grace');
    createCandidate('owner-1', second.id, 'Grace');
    const result = await executeHrAgentCapability(
      'owner-1',
        'update_candidate',
        {
          full_name: 'Grace',
          stage: 'interview_2',
          expected_updated_at: '2026-01-01T00:00:00.000Z',
          confirmed: true,
        },
      'http://localhost',
    );
    expect(result).toMatchObject({
      status: 'requires_confirmation',
      reason: 'multiple_candidates',
    });
    expect(result.candidates).toHaveLength(2);
  });

  test('expires active jobs, writes audit records, and respects soft delete', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const expired = createJob('owner-1', 'Expired', past);
    const active = createJob('owner-1', 'Active', future);
    const paused = createHrJob({
      ownerUserId: 'owner-1',
      title: 'Paused',
      department: null,
      location: null,
      level: null,
      salaryRange: null,
      status: 'paused',
      jdText: 'JD',
      keywords: [],
      responsibilities: [],
      requirements: [],
      preferred: [],
      techStack: [],
      expiresAt: past,
    });
    expect(isHrJobExpired({ expiresAt: past })).toBe(true);
    expect(scanExpiredHrJobs()).toBe(1);
    expect(getHrJob('owner-1', expired.id)?.status).toBe('closed');
    expect(getHrJob('owner-1', active.id)?.status).toBe('active');
    expect(getHrJob('owner-1', paused.id)?.status).toBe('paused');
    const audits = db.prepare(
      "SELECT * FROM hr_audit_log WHERE action = 'job_expired' AND target_id = ?",
    ).all(expired.id);
    expect(audits).toHaveLength(1);

    const deleted = executeHrAgentCapability(
      'owner-1',
      'delete_job',
      { job_id: active.id, confirmed: true },
      'http://localhost',
    ) as unknown as Promise<{ job: { id: string } }>;
    expect(deleted).resolves.toMatchObject({ status: 'updated' });
    expect(getHrJob('owner-1', active.id)?.deletedAt).toBeTruthy();
    expect(listHrJobs('owner-1').find((job) => job.id === active.id)).toBeUndefined();
  });
});
