import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  HR_MOCK_MODEL_ENV,
  analyzeFeedback,
  analyzeMarket,
  analyzeMatch,
  analyzeResume,
  generateQuestions,
} from '../src/hr/ai.js';
import { modelRef } from '../src/hr/analysis-service.js';
import {
  buildMatchResult,
  scoreResumeAssessment,
} from '../src/hr/resume-scoring.js';
import type {
  HrCandidate,
  HrInterviewRound,
  HrJob,
  HrResume,
} from '../src/hr/types.js';
import { sdkQuery } from '../src/sdk-query.js';

vi.mock('../src/sdk-query.js', () => ({
  sdkQuery: vi.fn(),
}));

const job = {
  id: 'job-1',
  ownerUserId: 'owner-1',
  title: 'Backend Engineer',
  department: null,
  location: null,
  level: null,
  salaryRange: null,
  status: 'active',
  jdText: 'Build services with Go and PostgreSQL.',
  keywords: ['Go'],
  responsibilities: ['Build backend services'],
  requirements: ['Go service development', 'PostgreSQL'],
  preferred: [],
  techStack: ['Go', 'PostgreSQL'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as HrJob;

const resume = {
  id: 'resume-1',
  ownerUserId: 'owner-1',
  candidateId: 'candidate-1',
  jobId: job.id,
  filePath: '/tmp/resume.pdf',
  fileName: 'Ada Lovelace.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 100,
  sha256: 'sha256',
  extractedText:
    'Ada Lovelace is a backend engineer with 6 years experience. She built Go services and modeled PostgreSQL schemas.',
  parserVersion: 'v1',
  parseStatus: 'parsed',
  createdAt: '2026-01-01T00:00:00.000Z',
} as HrResume;

const candidate = {
  id: 'candidate-1',
  ownerUserId: 'owner-1',
  jobId: job.id,
  fullName: 'Ada Lovelace',
  email: null,
  phone: null,
  location: null,
  source: 'upload',
  sourceUrl: null,
  stage: 'pending_tech_screen',
  talentPool: false,
  yearsExperience: 6,
  summary: 'Backend engineer focused on Go APIs.',
  recommendation: null,
  overallScore: null,
  riskFlags: [],
  profile: null,
  aiStatus: 'pending',
  aiError: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as HrCandidate;

const round = {
  id: 'round-1',
  ownerUserId: 'owner-1',
  jobId: job.id,
  candidateId: candidate.id,
  stage: 'interview_1',
  interviewer: null,
  scheduledAt: null,
  completedAt: null,
  outcome: null,
  feedbackText: 'Asked about Redis caching beyond the JD.',
  score: 78,
  analysis: null,
  model: null,
  createdAt: '2026-01-01T00:00:00.000Z',
} as HrInterviewRound;

describe('HR mock model', () => {
  beforeEach(() => {
    process.env[HR_MOCK_MODEL_ENV] = 'true';
    vi.mocked(sdkQuery).mockClear();
  });

  afterEach(() => {
    delete process.env[HR_MOCK_MODEL_ENV];
  });

  test('does not call the model transport and still validates every AI result', async () => {
    const parsed = await analyzeResume(job, resume);
    expect(parsed.full_name).toBe('Ada Lovelace');
    expect(parsed.years_experience).toBe(6);
    expect(parsed.skills).toEqual(
      expect.arrayContaining(['Go service development', 'PostgreSQL']),
    );

    const assessment = await analyzeMatch(job, candidate, resume);
    const match = scoreResumeAssessment(assessment);
    expect(match.total_score).toBeGreaterThanOrEqual(60);
    expect(match.fit_level).toBe('fit');
    expect(match.must_have_requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requirement: 'PostgreSQL', status: 'met' }),
      ]),
    );

    const questions = await generateQuestions(
      job,
      candidate,
      buildMatchResult(match),
    );
    expect(questions.questions).toHaveLength(8);
    expect(questions.questions[0]?.category).toBe('项目验证');

    const feedback = await analyzeFeedback(job, candidate, round);
    expect(feedback.score).toBe(78);
    expect(feedback.decision_suggestion).toBe('advance');
    expect(feedback.new_requirements).toContain(
      'Asked about Redis caching beyond the JD.',
    );

    const market = await analyzeMarket(job, [candidate], [round]);
    expect(market.insights.join(' ')).toContain('1 名候选人');
    expect(market.summary).toContain('Mock岗位诊断');

    expect(sdkQuery).not.toHaveBeenCalled();
  });

  test('records a stable mock model reference', () => {
    expect(modelRef()).toBe('hr-mock-model');
  });
});
