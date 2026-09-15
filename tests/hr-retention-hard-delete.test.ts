import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const real = await import('../src/config.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclaw-hr-retention-'));
  (globalThis as any).__ICLAW_HR_TMP_DIR__ = tmpDir;
  return { ...real, DATA_DIR: tmpDir };
});

const tmpDir = () => (globalThis as any).__ICLAW_HR_TMP_DIR__ as string;

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'owner-1',
      username: 'owner',
      role: 'member',
      status: 'active',
      permissions: [],
      must_change_password: false,
    });
    return next();
  },
}));

import {
  bindHrDatabase,
  createHrAudit,
  createHrCandidate,
  createHrJob,
  createHrResume,
  createHrSchema,
  getHrCandidate,
  hardDeleteHrCandidate,
  listHrCandidates,
} from '../src/hr/store.js';
import hrRoutes from '../src/routes/hr.js';

const app = new Hono().route('/api/hr', hrRoutes);
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createHrSchema(db);
  bindHrDatabase(db);
});

function createJob(ownerUserId = 'owner-1') {
  return createHrJob({
    ownerUserId,
    title: 'Backend Engineer',
    department: null,
    location: null,
    level: null,
    salaryRange: null,
    status: 'active',
    jdText: 'Build APIs',
    keywords: [],
    responsibilities: [],
    requirements: [],
    preferred: [],
    techStack: [],
  });
}

function createCandidate(ownerUserId = 'owner-1', jobId = 'job-1') {
  return createHrCandidate({
    ownerUserId,
    jobId,
    fullName: 'Ada Lovelace',
    email: null,
    phone: null,
    location: null,
    source: 'upload',
    sourceUrl: null,
    yearsExperience: null,
    summary: null,
    recommendation: null,
    overallScore: null,
    profile: null,
  });
}

describe('HR candidate retention and hard deletion', () => {
  test('sets retention only for closed candidates and exposes cleanup queue', async () => {
    const job = createJob();
    const candidate = createCandidate('owner-1', job.id);
    createCandidate('owner-2', job.id);

    const openResponse = await app.request(
      `/api/hr/candidates/${candidate.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retention_expires_at: '2026-01-01T00:00:00.000Z' }),
      },
    );
    expect(openResponse.status).toBe(400);

    const closed = await app.request(
      `/api/hr/candidates/${candidate.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stage: 'closed_rejected',
          interviewer_1: 'Interviewer A',
          retention_expires_at: '2020-01-01T00:00:00.000Z',
        }),
      },
    );
    expect(closed.status).toBe(200);
    expect((await closed.json()).candidate).toMatchObject({
      stage: 'closed_rejected',
      interviewer1: 'Interviewer A',
      retentionExpiresAt: '2020-01-01T00:00:00.000Z',
      closedAt: expect.any(String),
    });

    expect(
      listHrCandidates('owner-1', { cleanupDue: true }).map((item) => item.id),
    ).toEqual([candidate.id]);
    expect(listHrCandidates('owner-2', { cleanupDue: true })).toEqual([]);
  });

  test('requires name confirmation and deletes local candidate data with audit', async () => {
    const job = createJob();
    const candidate = createCandidate('owner-1', job.id);
    const resumeDir = path.join(tmpDir(), 'hr', 'resumes', 'owner-1', candidate.id);
    fs.mkdirSync(resumeDir, { recursive: true });
    const resumePath = path.join(resumeDir, 'resume.pdf');
    fs.writeFileSync(resumePath, 'resume');
    createHrResume({
      ownerUserId: 'owner-1',
      candidateId: candidate.id,
      jobId: job.id,
      filePath: resumePath,
      fileName: 'resume.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 6,
      sha256: 'hash',
      extractedText: 'resume',
      parserVersion: 'test',
      parseStatus: 'parsed',
    });

    const wrongName = await app.request(
      `/api/hr/candidates/${candidate.id}/hard-delete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm_full_name: 'Wrong Name' }),
      },
    );
    expect(wrongName.status).toBe(400);
    expect(getHrCandidate('owner-1', candidate.id)).toBeDefined();

    const deleted = await app.request(
      `/api/hr/candidates/${candidate.id}/hard-delete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm_full_name: 'Ada Lovelace' }),
      },
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ deleted: true });
    expect(getHrCandidate('owner-1', candidate.id)).toBeUndefined();
    expect(hardDeleteHrCandidate('owner-1', candidate.id)).toMatchObject({
      resumes: 0,
      matches: 0,
    });
    expect(fs.existsSync(resumeDir)).toBe(false);
    const audit = db.prepare(
      "SELECT detail FROM hr_audit_log WHERE action = 'candidate_hard_deleted' AND target_id = ?",
    ).get(candidate.id) as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ source: 'web' });
    expect(audit.detail).not.toContain('Ada');
  });

  test('classifies activity sources and isolates by owner', async () => {
    const job = createJob();
    const candidate = createCandidate('owner-1', job.id);
    createHrAudit({
      ownerUserId: 'owner-1',
      actorId: 'owner-1',
      action: 'candidate_stage_updated',
      targetType: 'candidate',
      targetId: candidate.id,
      detail: {
        old_stage: 'pending_tech_screen',
        new_stage: 'interview_1',
        source: 'agent_runtime',
      },
    });
    createHrAudit({
      ownerUserId: 'owner-1',
      actorId: 'owner-1',
      action: 'candidate_updated',
      targetType: 'candidate',
      targetId: candidate.id,
      detail: { fields: ['interviewer_1'], source: 'web' },
    });
    createHrAudit({
      ownerUserId: 'owner-1',
      actorId: 'owner-1',
      action: 'job_expired',
      targetType: 'job',
      targetId: job.id,
      detail: { title: job.title, source: 'system' },
    });

    const response = await app.request('/api/hr/agent-activity');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.activity.map((item: { source: string }) => item.source),
    ).toEqual(expect.arrayContaining(['agent_runtime', 'web', 'system']));
    expect(body.activity).toHaveLength(3);
  });
});
