import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  analyzeFeedback,
  analyzeMatch,
  analyzeResume,
  generateQuestions,
} from '../src/hr/ai.js';
import {
  bindHrDatabase,
  createHrCandidate,
  createHrInterviewRound,
  createHrJob,
  createHrResume,
  createHrSchema,
  getActiveHrJobRule,
  getHrCandidate,
  listHrJobRules,
} from '../src/hr/store.js';
import {
  processCandidateAnalysis,
  runFeedbackAnalysis,
  startCandidateAnalysis,
  startCandidateAnalysisWithJob,
} from '../src/hr/analysis-service.js';
import { RESUME_SCORING_VERSION } from '../src/hr/resume-scoring.js';

vi.mock('../src/hr/ai.js', () => ({
  HrAnalysisError: class extends Error {},
  analyzeResume: vi.fn(),
  analyzeMatch: vi.fn(),
  generateQuestions: vi.fn(),
  analyzeFeedback: vi.fn(),
  analyzeMarket: vi.fn(),
}));

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createHrSchema(db);
  bindHrDatabase(db);
  vi.clearAllMocks();
});

function createJob() {
  return createHrJob({
    ownerUserId: 'owner-1',
    title: 'Golang Engineer',
    department: null,
    location: null,
    level: null,
    salaryRange: null,
    status: 'active',
    jdText: 'Go API development',
    keywords: ['Go'],
    responsibilities: ['Build services'],
    requirements: ['Golang'],
    preferred: [],
    techStack: ['Go'],
  });
}

function createCandidate(
  jobId: string,
  fullNameSource: 'filename' | 'unknown' = 'unknown',
) {
  const candidate = createHrCandidate({
    ownerUserId: 'owner-1',
    jobId,
    fullName: 'Resume Candidate',
    fullNameSource,
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
  return createHrResume({
    ownerUserId: 'owner-1',
    candidateId: candidate.id,
    jobId,
    filePath: 'C:/protected/resume.txt',
    fileName: 'resume.txt',
    mimeType: 'text/plain',
    sizeBytes: 128,
    sha256: 'hash',
    extractedText: 'Go API engineer',
    parserVersion: 'test',
    parseStatus: 'pending',
  });
}

function matchAssessment() {
  return {
    must_have_requirements: [
      {
        requirement: 'Golang',
        status: 'met' as const,
        critical: true,
        evidence: 'Go API project',
      },
      {
        requirement: 'API service design',
        status: 'partial' as const,
        critical: false,
        evidence: 'Built API services',
      },
    ],
    preferred_requirements: [],
    project_fit: {
      role_domain_similarity: 85,
      scenario_match: 80,
      complexity_scale: 70,
      outcome_impact: 75,
    },
    evidence_quality: {
      specific_technology: 80,
      measurable_results: 65,
      traceability: 85,
    },
    risks: [],
    rationale: 'Strong Go API experience.',
  };
}

describe('HR manual analysis flow', () => {
  test('queues background analysis and marks the candidate completed', async () => {
    const job = createJob();
    const resume = createCandidate(job.id);
    vi.mocked(analyzeResume).mockResolvedValue({
      full_name: 'Ada',
      email: null,
      phone: null,
      location: null,
      years_experience: 4,
      summary: 'Go API engineer',
      skills: [],
      education: [],
      experiences: [],
      certifications: [],
      risk_flags: [],
    });
    vi.mocked(analyzeMatch).mockResolvedValue(matchAssessment());
    vi.mocked(generateQuestions).mockResolvedValue({
      questions: [
        {
          category: 'technical',
          question: 'Describe a Go service you owned.',
          rationale: 'Verify ownership.',
          expected_signal: 'Concrete outcome.',
          priority: 1,
        },
      ],
    });

    const queued = startCandidateAnalysis('owner-1', resume.candidateId);
    expect(queued.aiStatus).toBe('running');

    await vi.waitFor(() => {
      expect(getHrCandidate('owner-1', resume.candidateId)?.aiStatus).toBe(
        'completed',
      );
    });
  });

  test('overwrites filename-derived names after parse but preserves other sources', async () => {
    const job = createJob();
    vi.mocked(analyzeResume).mockResolvedValue({
      full_name: 'Ada',
      email: null,
      phone: null,
      location: null,
      years_experience: 4,
      summary: 'Go API engineer',
      skills: [],
      education: [],
      experiences: [],
      certifications: [],
      risk_flags: [],
    });
    vi.mocked(analyzeMatch).mockResolvedValue(matchAssessment());
    vi.mocked(generateQuestions).mockResolvedValue({
      questions: [
        {
          category: 'technical',
          question: 'Describe a Go service you owned.',
          rationale: 'Verify ownership.',
          expected_signal: 'Concrete outcome.',
          priority: 1,
        },
      ],
    });

    const parsedResume = createCandidate(job.id, 'filename');
    const parsedStart = startCandidateAnalysisWithJob(
      'owner-1',
      parsedResume.candidateId,
    );
    expect(parsedStart.analysisJobId).toMatch(/.+/);
    await vi.waitFor(() => {
      const parsed = getHrCandidate('owner-1', parsedResume.candidateId);
      expect(parsed?.fullName).toBe('Ada');
      expect(parsed?.fullNameSource).toBe('parsed');
    });

    const preservedResume = createCandidate(job.id, 'unknown');
    startCandidateAnalysis('owner-1', preservedResume.candidateId);
    await vi.waitFor(() => {
      const preserved = getHrCandidate('owner-1', preservedResume.candidateId);
      expect(preserved?.aiStatus).toBe('completed');
    });
    expect(
      getHrCandidate('owner-1', preservedResume.candidateId)?.fullName,
    ).toBe('Resume Candidate');
    expect(
      getHrCandidate('owner-1', preservedResume.candidateId)?.fullNameSource,
    ).toBe('unknown');
  });

  test('manual analysis writes match results and marks candidate completed', async () => {
    const job = createJob();
    const resume = createCandidate(job.id);
    vi.mocked(analyzeResume).mockResolvedValue({
      full_name: 'Ada',
      email: null,
      phone: null,
      location: null,
      years_experience: 4,
      summary: 'Go API engineer',
      skills: [],
      education: [],
      experiences: [],
      certifications: [],
      risk_flags: [],
    });
    vi.mocked(analyzeMatch).mockResolvedValue(matchAssessment());
    vi.mocked(generateQuestions).mockResolvedValue({
      questions: [
        {
          category: 'technical',
          question: 'Describe a Go service you owned.',
          rationale: 'Verify ownership.',
          expected_signal: 'Concrete outcome.',
          priority: 1,
        },
      ],
    });

    const candidate = await processCandidateAnalysis(
      'owner-1',
      resume.candidateId,
    );
    expect(candidate.aiStatus).toBe('completed');
    expect(candidate.overallScore).toBe(69);
    expect(candidate.overallScoreStandard).toBe(RESUME_SCORING_VERSION);
    expect(getHrCandidate('owner-2', candidate.id)).toBeUndefined();
  });

  test('manual analysis failure marks candidate failed without fabricated score', async () => {
    const job = createJob();
    const resume = createCandidate(job.id);
    vi.mocked(analyzeResume).mockResolvedValue({
      full_name: 'Ada',
      email: null,
      phone: null,
      location: null,
      years_experience: 4,
      summary: 'Go API engineer',
      skills: [],
      education: [],
      experiences: [],
      certifications: [],
      risk_flags: [],
    });
    vi.mocked(analyzeMatch).mockRejectedValue(
      new Error('Invalid model output'),
    );

    await expect(
      processCandidateAnalysis('owner-1', resume.candidateId),
    ).rejects.toThrow('Invalid model output');
    expect(getHrCandidate('owner-1', resume.candidateId)?.aiStatus).toBe(
      'failed',
    );
    expect(getHrCandidate('owner-1', resume.candidateId)?.aiError).toContain(
      'Invalid model output',
    );
  });

  test('effective interview feedback creates a draft job rule; pass-through feedback does not', async () => {
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
    vi.mocked(analyzeFeedback).mockResolvedValueOnce({
      summary: 'Interviewer tested database indexing.',
      score: 78,
      updated_recommendation: 'fit',
      new_requirements: ['Database indexing'],
      jd_gaps: ['Database depth'],
      contradictions: [],
      decision_suggestion: 'review',
    });
    const first = createHrInterviewRound({
      ownerUserId: 'owner-1',
      jobId: job.id,
      candidateId: candidate.id,
      stage: 'interview_1',
      interviewer: null,
      scheduledAt: null,
      completedAt: null,
      outcome: null,
      feedbackText: 'Asked about database indexing beyond JD.',
      score: null,
    });
    const rule = await runFeedbackAnalysis('owner-1', candidate.id, first.id);
    expect(rule?.status).toBe('draft');
    expect(getActiveHrJobRule('owner-1', job.id)).toBeUndefined();
    expect(listHrJobRules('owner-1', job.id)).toHaveLength(1);

    vi.mocked(analyzeFeedback).mockResolvedValueOnce({
      summary: 'The interviewer approved the candidate.',
      score: 85,
      updated_recommendation: 'strong_fit',
      new_requirements: [],
      jd_gaps: [],
      contradictions: [],
      decision_suggestion: 'advance',
    });
    const second = createHrInterviewRound({
      ownerUserId: 'owner-1',
      jobId: job.id,
      candidateId: candidate.id,
      stage: 'interview_2',
      interviewer: null,
      scheduledAt: null,
      completedAt: null,
      outcome: null,
      feedbackText: 'Passed.',
      score: null,
    });
    const noRule = await runFeedbackAnalysis(
      'owner-1',
      candidate.id,
      second.id,
    );
    expect(noRule).toBeUndefined();
    expect(listHrJobRules('owner-1', job.id)).toHaveLength(1);
  });
});
