import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iclaw-hr-resume-'));
const dataDir = path.join(tmp, 'data');

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
}));

vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', {
      id: process.env.HR_TEST_USER || 'owner-1',
      username: process.env.HR_TEST_USER || 'owner-1',
      role: 'admin',
      permissions: [],
    });
    return next();
  },
}));

import {
  bindHrDatabase,
  createHrCandidate,
  createHrJob,
  createHrResume,
  createHrSchema,
  getHrCandidate,
  getHrResume,
  listHrResumesForCandidate,
} from '../src/hr/store.js';

const routes = (await import('../src/routes/hr.js')).default;

function seedCandidate(ownerUserId = 'owner-1') {
  const job = createHrJob({
    ownerUserId,
    title: 'Backend Engineer',
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
  });
  return createHrCandidate({
    ownerUserId,
    jobId: job.id,
    fullName: 'Ada',
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

function seedResume(ownerUserId: string, candidateId: string) {
  const resumeDir = path.join(
    dataDir,
    'hr',
    'resumes',
    ownerUserId,
    candidateId,
  );
  fs.mkdirSync(resumeDir, { recursive: true });
  const filePath = path.join(resumeDir, 'old.txt');
  fs.writeFileSync(filePath, 'old resume');
  return createHrResume({
    ownerUserId,
    candidateId,
    jobId: getHrCandidate(ownerUserId, candidateId)!.jobId,
    filePath,
    fileName: 'old.txt',
    mimeType: 'text/plain',
    sizeBytes: 10,
    sha256: 'old-hash',
    extractedText: 'old resume',
    parserVersion: 'iclaw-hr-v1',
    parseStatus: 'pending',
  });
}

beforeEach(() => {
  const db = new Database(':memory:');
  createHrSchema(db);
  bindHrDatabase(db);
  process.env.HR_TEST_USER = 'owner-1';
});

afterEach(() => {
  delete process.env.HR_TEST_USER;
});

describe('HR resume delete and replace actions', () => {
  test('deletes only the resume and reports when Feishu is not configured', async () => {
    const candidate = seedCandidate();
    const resume = seedResume('owner-1', candidate.id);

    process.env.HR_TEST_USER = 'owner-2';
    const foreign = await routes.request(`/resumes/${resume.id}`, {
      method: 'DELETE',
    });
    expect(foreign.status).toBe(404);
    expect(getHrResume('owner-1', resume.id)).toBeDefined();

    process.env.HR_TEST_USER = 'owner-1';
    const response = await routes.request(`/resumes/${resume.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      candidate_id: candidate.id,
      feishu_sync: { attempted: false },
    });
    expect(fs.existsSync(resume.filePath)).toBe(false);
    expect(getHrResume('owner-1', resume.id)).toBeUndefined();
    expect(getHrCandidate('owner-1', candidate.id)).toBeDefined();
  });

  test('rejects a resume path outside the protected candidate directory', async () => {
    const candidate = seedCandidate();
    const outsideDir = path.join(tmp, 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    const filePath = path.join(outsideDir, 'old.txt');
    fs.writeFileSync(filePath, 'old resume');
    const resume = createHrResume({
      ownerUserId: 'owner-1',
      candidateId: candidate.id,
      jobId: getHrCandidate('owner-1', candidate.id)!.jobId,
      filePath,
      fileName: 'old.txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      sha256: 'outside-hash',
      extractedText: 'old resume',
      parserVersion: 'iclaw-hr-v1',
      parseStatus: 'pending',
    });

    const response = await routes.request(`/resumes/${resume.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(400);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(getHrResume('owner-1', resume.id)).toBeDefined();
  });

  test('replaces a resume on the target candidate and resets AI status', async () => {
    const candidate = seedCandidate();
    const oldResume = seedResume('owner-1', candidate.id);
    const form = new FormData();
    form.append(
      'file',
      new File(['new resume'], 'new-resume.txt', { type: 'text/plain' }),
    );

    const response = await routes.request(
      `/candidates/${candidate.id}/resumes/${oldResume.id}/replace`,
      { method: 'POST', body: form },
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.candidate).toMatchObject({
      id: candidate.id,
      aiStatus: 'pending',
    });
    expect(body.feishu_sync).toEqual({ attempted: false });
    expect(getHrResume('owner-1', oldResume.id)).toBeUndefined();
    expect(fs.existsSync(oldResume.filePath)).toBe(false);
    const resumes = listHrResumesForCandidate('owner-1', candidate.id);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.fileName).toBe('new-resume.txt');
    expect(fs.existsSync(resumes[0]!.filePath)).toBe(true);
    expect(getHrCandidate('owner-1', candidate.id)?.fullName).toBe('Ada');
  });

  test('keeps the old resume when replacement upload fails', async () => {
    const candidate = seedCandidate();
    const oldResume = seedResume('owner-1', candidate.id);
    const form = new FormData();
    form.append(
      'file',
      new File(['unsupported'], 'new-resume.rtf', {
        type: 'application/rtf',
      }),
    );

    const response = await routes.request(
      `/candidates/${candidate.id}/resumes/${oldResume.id}/replace`,
      { method: 'POST', body: form },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Unsupported resume file type',
    });
    expect(getHrResume('owner-1', oldResume.id)).toBeDefined();
    expect(fs.existsSync(oldResume.filePath)).toBe(true);
  });
});
