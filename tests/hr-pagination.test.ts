import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

import {
  bindHrDatabase,
  createHrAnalysisJob,
  createHrAudit,
  createHrCandidate,
  createHrJob,
  createHrSchema,
  listHrAuditByActions,
  listHrAnalysisJobsPaged,
  listHrCandidatesPaged,
  listHrJobsPaged,
  listHrQuestionsPaged,
  softDeleteHrJob,
  updateHrJob,
} from '../src/hr/store.js';
import hrRoutes from '../src/routes/hr.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createHrSchema(db);
  bindHrDatabase(db);
});

describe('HR lifecycle protection and audit activity', () => {
  test('blocks updates to soft-deleted jobs and exposes lifecycle audits', () => {
    const job = createJob('owner-1', 'Backend Engineer');
    const candidate = createCandidate('owner-1', job.id, 'Ada');
    expect(softDeleteHrJob('owner-1', job.id, 'owner-1')).toBeTruthy();
    expect(
      updateHrJob('owner-1', job.id, { title: 'Blocked' }),
    ).toBeUndefined();
    expect(listHrJobsPaged('owner-1', { limit: 10, offset: 0 }).total).toBe(0);

    createHrAudit({
      ownerUserId: 'owner-1',
      actorId: 'owner-1',
      action: 'candidate_stage_updated',
      targetType: 'candidate',
      targetId: candidate.id,
      detail: {
        job_id: job.id,
        old_stage: 'pending_tech_screen',
        new_stage: 'interview_1',
        source: 'agent_runtime',
      },
    });
    createHrAudit({
      ownerUserId: 'owner-1',
      actorId: 'owner-1',
      action: 'job_soft_deleted',
      targetType: 'job',
      targetId: job.id,
      detail: { title: job.title },
    });

    const audits = listHrAuditByActions(
      'owner-1',
      ['candidate_stage_updated', 'job_soft_deleted'],
      20,
    );
    expect(audits.map((audit) => audit.action)).toEqual(
      expect.arrayContaining(['job_soft_deleted', 'candidate_stage_updated']),
    );
    expect(listHrAuditByActions('owner-2', ['job_soft_deleted'], 20)).toEqual(
      [],
    );
  });
});

function createJob(ownerUserId: string, title: string) {
  return createHrJob({
    ownerUserId,
    title,
    department: null,
    location: null,
    level: null,
    salaryRange: null,
    status: 'active',
    jdText: `${title} JD`,
    keywords: [],
    responsibilities: [],
    requirements: [],
    preferred: [],
    techStack: [],
  });
}

function createCandidate(
  ownerUserId: string,
  jobId: string,
  fullName: string,
  source: 'upload' | 'boss_opencli' | 'manual' = 'upload',
) {
  return createHrCandidate({
    ownerUserId,
    jobId,
    fullName,
    email: null,
    phone: null,
    location: null,
    source,
    sourceUrl: null,
    yearsExperience: null,
    summary: null,
    recommendation: null,
    overallScore: null,
    profile: null,
  });
}

describe('HR list pagination', () => {
  test('requires authentication for paged routes', async () => {
    const response = await hrRoutes.request('/jobs?page=1&page_size=20');
    expect(response.status).toBe(401);
  });

  test('paginates jobs, filters lifecycle and excludes deleted jobs by default', () => {
    const first = createJob('owner-1', 'Backend Engineer');
    const second = createJob('owner-1', 'Frontend Engineer');
    createJob('owner-2', 'Hidden Engineer');
    softDeleteHrJob('owner-1', second.id, 'owner-1');

    const pageOne = listHrJobsPaged('owner-1', { limit: 1, offset: 0 });
    const pageTwo = listHrJobsPaged('owner-1', { limit: 1, offset: 1 });
    expect(pageOne.total).toBe(1);
    expect(pageOne.items).toHaveLength(1);
    expect(pageTwo.items).toHaveLength(0);
    expect(pageOne.items[0]?.id).toBe(first.id);

    const all = listHrJobsPaged('owner-1', {
      lifecycle: 'all',
      limit: 10,
      offset: 0,
    });
    expect(all.total).toBe(2);
    expect(all.items.map((job) => job.id)).toContain(second.id);

    const deleted = listHrJobsPaged('owner-1', {
      lifecycle: 'deleted',
      limit: 10,
      offset: 0,
    });
    expect(deleted.total).toBe(1);
    expect(deleted.items[0]?.id).toBe(second.id);
  });

  test('paginates candidates with owner, source, talent pool and job title filters', () => {
    const job = createJob('owner-1', 'Go Engineer');
    const otherJob = createJob('owner-2', 'Hidden Go Engineer');
    const ada = createCandidate('owner-1', job.id, 'Ada', 'upload');
    const grace = createCandidate('owner-1', job.id, 'Grace', 'manual');
    createCandidate('owner-2', otherJob.id, 'Hidden', 'upload');

    const byTitle = listHrCandidatesPaged('owner-1', {
      search: 'Go Engineer',
      limit: 10,
      offset: 0,
    });
    expect(byTitle.total).toBe(2);
    expect(byTitle.items.map((candidate) => candidate.id).sort()).toEqual(
      [ada.id, grace.id].sort(),
    );

    const bySource = listHrCandidatesPaged('owner-1', {
      source: 'manual',
      limit: 10,
      offset: 0,
    });
    expect(bySource.total).toBe(1);
    expect(bySource.items[0]?.id).toBe(grace.id);
    expect(bySource.sources).toEqual(
      expect.arrayContaining(['manual', 'upload']),
    );

    const byTalent = listHrCandidatesPaged('owner-1', {
      talentPool: true,
      limit: 10,
      offset: 0,
    });
    expect(byTalent.total).toBe(0);
  });

  test('paginates questions with candidate, job and category filters', () => {
    const job = createJob('owner-1', 'Backend Engineer');
    const hiddenJob = createJob('owner-2', 'Hidden Job');
    const candidate = createCandidate('owner-1', job.id, 'Ada');
    const hiddenCandidate = createCandidate('owner-2', hiddenJob.id, 'Hidden');
    const questions = [
      {
        ownerUserId: 'owner-1' as const,
        jobId: job.id,
        candidateId: candidate.id,
        category: 'technical',
        question: 'Describe an API you owned.',
        rationale: 'Check ownership.',
        expectedSignal: 'Concrete outcome.',
        priority: 1,
        model: null,
      },
    ];
    db.prepare(
      `INSERT INTO hr_interview_questions
       (id, owner_user_id, job_id, candidate_id, category, question, rationale,
        expected_signal, priority, model, created_at)
       VALUES ('q-hidden', ?, ?, ?, 'system', 'Hidden', '', '', 1, NULL, ?)`,
    ).run(
      'owner-2',
      hiddenJob.id,
      hiddenCandidate.id,
      new Date().toISOString(),
    );

    for (const question of questions) {
      db.prepare(
        `INSERT INTO hr_interview_questions
         (id, owner_user_id, job_id, candidate_id, category, question, rationale,
          expected_signal, priority, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'q-visible',
        question.ownerUserId,
        question.jobId,
        question.candidateId,
        question.category,
        question.question,
        question.rationale,
        question.expectedSignal,
        question.priority,
        question.model,
        new Date().toISOString(),
      );
    }

    const page = listHrQuestionsPaged('owner-1', {
      limit: 10,
      offset: 0,
    });
    expect(page.total).toBe(1);
    expect(page.categories).toEqual(['technical']);
    expect(page.items[0]?.candidate.id).toBe(candidate.id);
    expect(page.items[0]?.jobTitle).toBe('Backend Engineer');

    const filtered = listHrQuestionsPaged('owner-1', {
      category: 'missing',
      limit: 10,
      offset: 0,
    });
    expect(filtered.total).toBe(0);
  });

  test('paginates analysis jobs with owner and status filters', () => {
    const job = createJob('owner-1', 'Backend Engineer');
    const candidate = createCandidate('owner-1', job.id, 'Ada');
    createHrAnalysisJob({
      ownerUserId: 'owner-1',
      type: 'candidate_analysis',
      targetId: candidate.id,
      inputHash: 'hash-1',
      model: null,
    });
    createHrAnalysisJob({
      ownerUserId: 'owner-2',
      type: 'candidate_analysis',
      targetId: candidate.id,
      inputHash: 'hash-2',
      model: null,
    });

    const queued = listHrAnalysisJobsPaged('owner-1', {
      status: 'queued',
      limit: 10,
      offset: 0,
    });
    expect(queued.total).toBe(1);
    expect(queued.items[0]?.status).toBe('queued');
  });
});
