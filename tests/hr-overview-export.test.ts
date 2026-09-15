import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', {
      id: 'owner-1',
      username: 'owner-1',
      role: 'owner',
      permissions: [],
    });
    await next();
  },
}));

import { bindHrDatabase, createHrCandidate, createHrJob, createHrSchema } from '../src/hr/store.js';
import hrRoutes from '../src/routes/hr.js';

let db: Database.Database;
let app: Hono;

beforeEach(() => {
  db = new Database(':memory:');
  createHrSchema(db);
  bindHrDatabase(db);
  app = new Hono();
  app.route('/api/hr', hrRoutes);
});

function createJob() {
  return createHrJob({
    ownerUserId: 'owner-1',
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
}

describe('HR overview export', () => {
  test('exports aggregate rows with owner isolation and audit', async () => {
    const job = createJob();
    createHrCandidate({
      ownerUserId: 'owner-1',
      jobId: job.id,
      fullName: 'Private Candidate',
      email: 'hidden@example.com',
      phone: '+8613800000000',
      location: null,
      source: 'upload',
      sourceUrl: null,
      yearsExperience: 2,
      summary: 'Node.js engineer',
      recommendation: null,
      overallScore: 80,
      profile: { resume: 'Full resume text' },
    });
    const response = await app.request('/api/hr/overview/export.csv');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    const csv = await response.text();
    expect(csv).toContain('核心指标');
    expect(csv).toContain('岗位汇总');
    expect(csv).toContain('Backend Engineer');
    expect(csv).toContain('候选人: 1');
    expect(csv).not.toContain('Private Candidate');
    expect(csv).not.toContain('hidden@example.com');
    expect(csv).not.toContain('Full resume text');
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM hr_audit_log WHERE action = 'overview_exported'",
    ).get()).toEqual({ count: 1 });
  });
});
