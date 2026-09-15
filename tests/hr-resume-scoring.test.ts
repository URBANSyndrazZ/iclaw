import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  bindHrDatabase,
  createHrCandidate,
  createHrJob,
  createHrResume,
  createHrSchema,
  getLatestHrMatch,
} from '../src/hr/store.js';
import { processCandidateAnalysis } from '../src/hr/analysis-service.js';
import {
  analyzeFeedback,
  analyzeMatch,
  analyzeResume,
  generateQuestions,
} from '../src/hr/ai.js';
import {
  RESUME_SCORING_VERSION,
  scoreResumeAssessment,
  type ResumeScoreAssessment,
} from '../src/hr/resume-scoring.js';

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

function assessment(
  overrides: Partial<ResumeScoreAssessment> = {},
): ResumeScoreAssessment {
  return {
    must_have_requirements: [
      {
        requirement: 'Node.js',
        status: 'met',
        critical: true,
        evidence: 'Built Node.js APIs',
      },
      {
        requirement: 'PostgreSQL',
        status: 'met',
        critical: false,
        evidence: 'Used PostgreSQL',
      },
    ],
    preferred_requirements: [
      {
        requirement: 'Kubernetes',
        status: 'met',
        critical: false,
        evidence: 'Deployed on Kubernetes',
      },
    ],
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
    rationale: 'Strong matching evidence.',
    ...overrides,
  };
}

describe('resume_scoring_v2', () => {
  test('uses the fixed default weights and applies risk penalties', () => {
    const result = scoreResumeAssessment(
      assessment({
        project_fit: {
          role_domain_similarity: 80,
          scenario_match: 80,
          complexity_scale: 80,
          outcome_impact: 80,
        },
        evidence_quality: {
          specific_technology: 70,
          measurable_results: 70,
          traceability: 70,
        },
        preferred_requirements: [
          {
            requirement: 'Kubernetes',
            status: 'partial',
            critical: false,
            evidence: 'Mentioned Kubernetes',
          },
        ],
        risks: [{ type: 'contradiction', description: 'Dates overlap' }],
      }),
    );

    expect(result.score_standard).toBe(RESUME_SCORING_VERSION);
    expect(result.dimensions).toMatchObject({
      must_have_score: 100,
      project_fit_score: 80,
      evidence_quality_score: 70,
      preferred_score: 50,
      risk_penalty: 5,
    });
    expect(result.weights).toEqual({
      must_have: 0.35,
      project_fit: 0.4,
      evidence_quality: 0.15,
      preferred: 0.1,
    });
    expect(result.adjusted_for_experience).toBe(false);
    expect(result.total_score).toBe(78);
    expect(result.fit_level).toBe('fit');
  });

  test('shifts weight to project experience only for strong non-blocking evidence', () => {
    const result = scoreResumeAssessment(
      assessment({
        must_have_requirements: [
          {
            requirement: 'Node.js',
            status: 'met',
            critical: true,
            evidence: 'Built Node.js APIs',
          },
          {
            requirement: 'PostgreSQL',
            status: 'partial',
            critical: false,
            evidence: 'Used PostgreSQL',
          },
        ],
        project_fit: {
          role_domain_similarity: 90,
          scenario_match: 90,
          complexity_scale: 90,
          outcome_impact: 90,
        },
        evidence_quality: {
          specific_technology: 80,
          measurable_results: 80,
          traceability: 80,
        },
      }),
    );

    expect(result.adjusted_for_experience).toBe(true);
    expect(result.weights).toEqual({
      must_have: 0.3,
      project_fit: 0.45,
      evidence_quality: 0.15,
      preferred: 0.1,
    });
    expect(result.total_score).toBe(85);
  });

  test('does not reduce hard-requirement weight for a missing core requirement', () => {
    const result = scoreResumeAssessment(
      assessment({
        must_have_requirements: [
          {
            requirement: 'Node.js',
            status: 'not_evident',
            critical: true,
            evidence: '',
          },
          {
            requirement: 'PostgreSQL',
            status: 'met',
            critical: false,
            evidence: 'Used PostgreSQL',
          },
        ],
        project_fit: {
          role_domain_similarity: 95,
          scenario_match: 95,
          complexity_scale: 95,
          outcome_impact: 95,
        },
      }),
    );

    expect(result.adjusted_for_experience).toBe(false);
    expect(result.weights.must_have).toBe(0.35);
  });

  test('caps risks and blocks experience adjustment for fabrication', () => {
    const result = scoreResumeAssessment(
      assessment({
        risks: Array.from({ length: 4 }, () => ({
          type: 'fabrication' as const,
          description: 'Unverifiable claim',
        })),
      }),
    );

    expect(result.dimensions.risk_penalty).toBe(15);
    expect(result.adjusted_for_experience).toBe(false);
  });

  test('persists a versioned match and candidate score without changing legacy records', async () => {
    const job = createHrJob({
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
      requirements: ['Node.js'],
      preferred: [],
      techStack: ['Node.js'],
    });
    const candidate = createHrCandidate({
      ownerUserId: 'owner-1',
      jobId: job.id,
      fullName: 'Ada',
      fullNameSource: 'provided',
      email: null,
      phone: null,
      location: null,
      source: 'upload',
      sourceUrl: null,
      yearsExperience: 4,
      summary: null,
      recommendation: null,
      overallScore: 91,
      overallScoreStandard: 'legacy',
      profile: null,
    });
    createHrResume({
      ownerUserId: 'owner-1',
      candidateId: candidate.id,
      jobId: job.id,
      filePath: 'C:/protected/resume.txt',
      fileName: 'resume.txt',
      mimeType: 'text/plain',
      sizeBytes: 128,
      sha256: 'hash',
      extractedText: 'Node.js engineer',
      parserVersion: 'test',
      parseStatus: 'pending',
    });
    vi.mocked(analyzeResume).mockResolvedValue({
      full_name: 'Ada',
      email: null,
      phone: null,
      location: null,
      years_experience: 4,
      summary: 'Node.js engineer',
      skills: [],
      education: [],
      experiences: [],
      certifications: [],
      risk_flags: [],
    });
    vi.mocked(analyzeMatch).mockResolvedValue(assessment());
    vi.mocked(generateQuestions).mockResolvedValue({
      questions: [
        {
          category: 'Project',
          question: 'Describe a Node.js API you owned.',
          rationale: 'Verify ownership.',
          expected_signal: 'Concrete outcome.',
          priority: 1,
        },
      ],
    });

    const updated = await processCandidateAnalysis('owner-1', candidate.id);
    expect(updated.overallScore).not.toBe(91);
    expect(updated.overallScoreStandard).toBe(RESUME_SCORING_VERSION);
    const match = getLatestHrMatch('owner-1', candidate.id)!;
    expect(match.scoreStandard).toBe(RESUME_SCORING_VERSION);
    expect(match.scoreBreakdown?.dimensions.must_have_score).toBe(100);
    expect(match.scoreBreakdown?.adjusted_for_experience).toBe(false);
    expect(match.score).toBe(match.scoreBreakdown?.total_score);
  });
});
