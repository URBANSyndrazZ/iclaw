import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  bindHrDatabase,
  createHrCandidate,
  createHrJob,
  createHrJobRule,
  createHrSchema,
  getHrJob,
  listHrJobRules,
  softDeleteHrJob,
  upsertHrFeishuConfig,
} from '../src/hr/store.js';
import { executeHrAgentCapability } from '../src/hr/agent-capability.js';
import { analyzeJobQuality } from '../src/hr/ai.js';
import {
  HrFeishuError,
  syncCandidateToFeishu,
} from '../src/hr/feishu.js';

vi.mock('../src/hr/ai.js', () => ({
  analyzeJobQuality: vi.fn(),
}));

vi.mock('../src/hr/feishu.js', () => ({
  HrFeishuError: class extends Error {},
  syncCandidateToFeishu: vi.fn(),
}));

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createHrSchema(db);
  bindHrDatabase(db);
  vi.clearAllMocks();
});

function createJob(ownerUserId = 'owner-1', title = 'Backend Engineer') {
  return createHrJob({
    ownerUserId,
    title,
    department: 'Platform',
    location: 'Shanghai',
    level: 'Senior',
    salaryRange: '40k-60k',
    status: 'active',
    jdText: 'Build Node.js APIs with PostgreSQL.',
    keywords: ['Node.js'],
    responsibilities: ['Own API services'],
    requirements: ['Five years backend experience'],
    preferred: ['Kubernetes'],
    techStack: ['Node.js', 'PostgreSQL'],
  });
}

describe('HR Agent JD tools', () => {
  test('reads one job with JD, funnel and rule summaries under owner isolation', async () => {
    const job = createJob();
    const rule = createHrJobRule({
      ownerUserId: 'owner-1',
      jobId: job.id,
      status: 'active',
      sourceRoundId: null,
      summary: 'Require database depth.',
      newRequirements: ['Database indexing'],
      jdGaps: ['Database depth'],
      contradictions: [],
      decisionSuggestion: 'review',
      model: null,
    });
    const hidden = createJob('owner-2', 'Hidden Engineer');

    const result = await executeHrAgentCapability(
      'owner-1',
      'get_job',
      { job_id: job.id },
      'http://localhost',
    );
    expect(result.job).toMatchObject({
      id: job.id,
      title: 'Backend Engineer',
      jdText: 'Build Node.js APIs with PostgreSQL.',
      requirements: ['Five years backend experience'],
      techStack: ['Node.js', 'PostgreSQL'],
      deleted: false,
    });
    expect(result.rules).toEqual([
      expect.objectContaining({ id: rule.id, status: 'active' }),
    ]);
    await expect(
      executeHrAgentCapability('owner-1', 'get_job', { job_id: hidden.id }, 'http://localhost'),
    ).rejects.toThrow('Job not found');

    softDeleteHrJob('owner-1', job.id, 'owner-1');
    await expect(
      executeHrAgentCapability('owner-1', 'get_job', { job_id: job.id }, 'http://localhost'),
    ).rejects.toThrow('Job not found');
  });

  test('runs read-only JD quality analysis and writes an audit record', async () => {
    const job = createJob();
    vi.mocked(analyzeJobQuality).mockResolvedValue({
      quality_score: 78,
      summary: 'The JD is concise but needs measurable outcomes.',
      strengths: ['Clear tech stack'],
      ambiguities: ['Ownership scope is broad'],
      missing_requirements: ['Production incident experience'],
      risks: ['Low information density'],
      improvements: ['Add measurable project outcomes'],
    });

    const result = await executeHrAgentCapability(
      'owner-1',
      'analyze_job',
      { job_id: job.id },
      'http://localhost',
    );
    expect(result).toMatchObject({
      status: 'analyzed',
      job: { id: job.id },
      analysis: { quality_score: 78 },
    });
    expect(vi.mocked(analyzeJobQuality)).toHaveBeenCalledWith(job);
    expect(getHrJob('owner-1', job.id)?.jdText).toBe(
      'Build Node.js APIs with PostgreSQL.',
    );
    expect(
      db.prepare(
        "SELECT COUNT(*) AS count FROM hr_audit_log WHERE action = 'job_analyzed' AND target_id = ?",
      ).get(job.id),
    ).toMatchObject({ count: 1 });
    expect(syncCandidateToFeishu).not.toHaveBeenCalled();
  });

  test('rejects unconfirmed, stale and cross-owner JD updates', async () => {
    const job = createJob();
    const base = {
      job_id: job.id,
      expected_updated_at: job.updatedAt,
      title: 'Updated Engineer',
    };

    await expect(
      executeHrAgentCapability('owner-1', 'update_job', base, 'http://localhost'),
    ).rejects.toThrow('explicit confirmation');
    await expect(
      executeHrAgentCapability(
        'owner-1',
        'update_job',
        { ...base, expected_updated_at: '1970-01-01T00:00:00.000Z', confirmed: true },
        'http://localhost',
      ),
    ).rejects.toThrow('modified after it was read');
    await expect(
      executeHrAgentCapability('owner-2', 'update_job', { ...base, confirmed: true }, 'http://localhost'),
    ).rejects.toThrow('Job not found');
  });

  test('updates confirmed JD fields, archives rules and syncs title changes', async () => {
    const job = createJob();
    const candidate = createHrCandidate({
      ownerUserId: 'owner-1',
      jobId: job.id,
      fullName: 'Ada',
      email: null,
      phone: null,
      location: null,
      source: 'upload',
      sourceUrl: null,
      yearsExperience: 4,
      summary: null,
      recommendation: null,
      overallScore: null,
      profile: null,
    });
    upsertHrFeishuConfig({
      ownerUserId: 'owner-1',
      channelAccountId: 'account-1',
      appToken: 'app-token',
      tableId: 'table-1',
      fieldMapping: { candidate_id: '候选人ID' },
      enabled: true,
    });
    createHrJobRule({
      ownerUserId: 'owner-1',
      jobId: job.id,
      status: 'active',
      sourceRoundId: null,
      summary: 'Existing active rule',
      newRequirements: ['Redis'],
      jdGaps: [],
      contradictions: [],
      decisionSuggestion: null,
      model: null,
    });
    vi.mocked(syncCandidateToFeishu).mockResolvedValue({
      synced: true,
      recordId: 'record-1',
    });

    const result = await executeHrAgentCapability(
      'owner-1',
      'update_job',
      {
        job_id: job.id,
        expected_updated_at: job.updatedAt,
        title: 'Senior Backend Engineer',
        jd_text: 'Build Node.js APIs with PostgreSQL and measurable outcomes.',
        confirmed: true,
      },
      'http://localhost',
    );

    expect(result).toMatchObject({
      status: 'updated',
      fields: ['title', 'jd_text'],
      titleChanged: true,
      jdChanged: true,
      auditAction: 'job_updated',
      feishuSync: { attempted: 1, succeeded: 1, failed: 0 },
    });
    const updated = getHrJob('owner-1', job.id);
    expect(updated).toMatchObject({
      title: 'Senior Backend Engineer',
      jdText: 'Build Node.js APIs with PostgreSQL and measurable outcomes.',
      keywords: ['Node.js'],
    });
    expect(updated?.updatedAt).not.toBe(job.updatedAt);
    expect(listHrJobRules('owner-1', job.id)[0]?.status).toBe('archived');
    expect(vi.mocked(syncCandidateToFeishu)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(syncCandidateToFeishu)).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: 'owner-1',
        candidateId: candidate.id,
      }),
    );
    const audit = db.prepare(
      "SELECT detail FROM hr_audit_log WHERE action = 'job_updated' AND target_id = ?",
    ).get(job.id) as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({
      fields: ['title', 'jd_text'],
      jd_changed: true,
      title_changed: true,
    });
  });

  test('keeps a successful JD update distinguishable from failed Feishu sync', async () => {
    const job = createJob();
    createHrCandidate({
      ownerUserId: 'owner-1',
      jobId: job.id,
      fullName: 'Ada',
      email: null,
      phone: null,
      location: null,
      source: 'upload',
      sourceUrl: null,
      yearsExperience: 4,
      summary: null,
      recommendation: null,
      overallScore: null,
      profile: null,
    });
    upsertHrFeishuConfig({
      ownerUserId: 'owner-1',
      channelAccountId: 'account-1',
      appToken: 'app-token',
      tableId: 'table-1',
      fieldMapping: { candidate_id: '候选人ID' },
      enabled: true,
    });
    vi.mocked(syncCandidateToFeishu).mockRejectedValue(
      new HrFeishuError('Bitable permission denied'),
    );

    const result = await executeHrAgentCapability(
      'owner-1',
      'update_job',
      {
        job_id: job.id,
        expected_updated_at: job.updatedAt,
        title: 'Renamed Job',
        confirmed: true,
      },
      'http://localhost',
    );

    expect(result).toMatchObject({
      status: 'updated',
      titleChanged: true,
      jdChanged: false,
      feishuSync: {
        attempted: 1,
        succeeded: 0,
        failed: 1,
        errors: [expect.stringContaining(': Bitable permission denied')],
      },
    });
  });
});
