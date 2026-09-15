import fs from 'node:fs/promises';
import path from 'node:path';
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

vi.mock('../src/hr/ai.js', () => ({
  analyzeJobQuality: vi.fn(),
  analyzeResumePreview: vi.fn(),
}));

import hrRoutes from '../src/routes/hr.js';
import { executeHrAgentCapability } from '../src/hr/agent-capability.js';
import { analyzeResumePreview } from '../src/hr/ai.js';
import { bindHrDatabase, createHrSchema } from '../src/hr/store.js';
import { DATA_DIR } from '../src/config.js';

let db: Database.Database;
let app: Hono;

beforeEach(() => {
  db = new Database(':memory:');
  createHrSchema(db);
  bindHrDatabase(db);
  app = new Hono();
  app.route('/api/hr', hrRoutes);
  vi.clearAllMocks();
});

async function uploadResume(): Promise<string> {
  const formData = new FormData();
  formData.append(
    'file',
    new File(['Node.js engineer with API delivery.'], 'resume.txt', {
      type: 'text/plain',
    }),
  );
  const response = await app.request('/api/hr/chat-resume-uploads', {
    method: 'POST',
    body: formData,
  });
  expect(response.status).toBe(201);
  const result = (await response.json()) as { attachment_id: string };
  return result.attachment_id;
}

describe('temporary chat resume analysis', () => {
  test('uploads, analyzes with the shared scorer, masks PII and deletes the temp file', async () => {
    const attachmentId = await uploadResume();
    vi.mocked(analyzeResumePreview).mockResolvedValue({
      must_have_requirements: [
        {
          requirement: 'Node.js API',
          status: 'met',
          critical: true,
          evidence: 'Contact hidden@example.com or 13800000000',
        },
      ],
      preferred_requirements: [],
      project_fit: {
        role_domain_similarity: 80,
        scenario_match: 80,
        complexity_scale: 80,
        outcome_impact: 80,
      },
      evidence_quality: {
        specific_technology: 80,
        measurable_results: 80,
        traceability: 80,
      },
      risks: [],
      rationale: 'Relevant API experience.',
    });

    const result = await executeHrAgentCapability(
      'owner-1',
      'analyze_resume_preview',
      {
        attachment_id: attachmentId,
        jd_text:
          'Build production Node.js APIs with measurable reliability outcomes.',
      },
      'http://localhost',
    );

    expect(result.status).toBe('analyzed');
    expect(result.score_standard).toBe('resume_scoring_v2');
    expect(result.persistence).toEqual({
      job_created: false,
      candidate_created: false,
      resume_created: false,
      analysis_job_created: false,
      feishu_synced: false,
    });
    const breakdown = result.breakdown as {
      must_have_requirements: Array<{ evidence: string }>;
    };
    expect(breakdown.must_have_requirements[0]?.evidence).not.toContain(
      'hidden@example.com',
    );
    expect(breakdown.must_have_requirements[0]?.evidence).not.toContain(
      '13800000000',
    );
    expect(JSON.stringify(result)).not.toContain(
      'Node.js engineer with API delivery',
    );
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM hr_audit_log WHERE action = 'resume_preview_analyzed'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM hr_candidates').get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM hr_analysis_jobs').get(),
    ).toEqual({ count: 0 });
    await expect(
      fs.access(
        path.join(DATA_DIR, 'hr', 'chat-documents', 'owner-1', attachmentId),
      ),
    ).rejects.toThrow();
  });

  test('rejects attachments across owners', async () => {
    const attachmentId = await uploadResume();
    await expect(
      executeHrAgentCapability(
        'owner-2',
        'analyze_resume_preview',
        {
          attachment_id: attachmentId,
          jd_text:
            'Build production Node.js APIs with measurable reliability outcomes.',
        },
        'http://localhost',
      ),
    ).rejects.toThrow('Resume attachment not found');
  });
});
