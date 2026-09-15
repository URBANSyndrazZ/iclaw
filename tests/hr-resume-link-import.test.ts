import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
  },
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

vi.mock('../src/config.js', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const real = await import('../src/config.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclaw-hr-link-'));
  (globalThis as any).__ICLAW_HR_LINK_TMP_DIR__ = tmpDir;
  return { ...real, DATA_DIR: tmpDir };
});

import {
  bindHrDatabase,
  createHrJob,
  createHrSchema,
  listHrCandidates,
  listHrResumesForCandidate,
} from '../src/hr/store.js';
import {
  HR_RESUME_MAX_BYTES,
  HrImportError,
  importResumeFromLink,
  ingestResume,
} from '../src/hr/import.js';
import { HrResumeLinkImportSchema } from '../src/hr/schemas.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createHrSchema(db);
  bindHrDatabase(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

describe('HR HTTPS resume link import', () => {
  test('rejects invalid link inputs and oversized local resumes', () => {
    expect(
      HrResumeLinkImportSchema.safeParse({
        job_id: 'job-1',
        source_url: 'http://example.com/resume.pdf',
      }).success,
    ).toBe(false);
    expect(() =>
      ingestResume({
        ownerUserId: 'owner-1',
        actorId: 'owner-1',
        job: createJob(),
        fileName: 'resume.exe',
        mimeType: null,
        content: Buffer.from('resume'),
        source: 'upload',
      }),
    ).rejects.toThrow('Unsupported resume file type');
    expect(() =>
      ingestResume({
        ownerUserId: 'owner-1',
        actorId: 'owner-1',
        job: createJob(),
        fileName: 'resume.pdf',
        mimeType: null,
        content: Buffer.alloc(HR_RESUME_MAX_BYTES + 1),
        source: 'upload',
      }),
    ).rejects.toThrow('exceeds 10MB');
  });

  test('blocks private hosts and insecure redirects before downloading', async () => {
    const job = createJob();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      importResumeFromLink('owner-1', 'owner-1', job, {
        job_id: job.id,
        source_url: 'https://127.0.0.1/resume.pdf',
      }),
    ).rejects.toThrow('Resume URL host is not allowed');

    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1/resume.pdf' },
      }),
    );
    await expect(
      importResumeFromLink('owner-1', 'owner-1', job, {
        job_id: job.id,
        source_url: 'https://public.example.com/redirect',
      }),
    ).rejects.toThrow('Resume URL host is not allowed');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('downloads, parses and deduplicates a public HTTPS resume', async () => {
    const job = createJob();
    const fetchSpy = vi.fn().mockImplementation(async () =>
      new Response('Backend Engineer resume', {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="resume.txt"',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const first = await importResumeFromLink('owner-1', 'owner-1', job, {
      job_id: job.id,
      source_url: 'https://public.example.com/resume.txt',
      candidate: { full_name: 'Ada Lovelace' },
    });
    expect(first.candidate).toMatchObject({
      fullName: 'Ada Lovelace',
      source: 'link',
      sourceUrl: 'https://public.example.com/resume.txt',
    });
    expect(first.resume.parseStatus).toBe('pending');
    expect(listHrResumesForCandidate('owner-1', first.candidate.id)).toHaveLength(1);

    const second = await importResumeFromLink('owner-1', 'owner-1', job, {
      job_id: job.id,
      source_url: 'https://public.example.com/resume.txt',
    });
    expect(second.duplicate).toBe(true);
    expect(second.candidate.id).toBe(first.candidate.id);
    expect(listHrCandidates('owner-1', { jobId: job.id })).toHaveLength(1);
  });

  test('rejects unknown MIME types and controlled timeouts', async () => {
    const job = createJob();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })),
    );
    await expect(
      importResumeFromLink('owner-1', 'owner-1', job, {
        job_id: job.id,
        source_url: 'https://public.example.com/page',
      }),
    ).rejects.toThrow('Unsupported resume URL content type');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
    );
    await expect(
      importResumeFromLink('owner-1', 'owner-1', job, {
        job_id: job.id,
        source_url: 'https://public.example.com/slow.pdf',
      }),
    ).rejects.toThrow('Resume URL request timed out');
  });
});
