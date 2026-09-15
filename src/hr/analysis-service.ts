import crypto from 'node:crypto';
import {
  analyzeFeedback,
  analyzeMarket,
  analyzeMatch,
  analyzeResume,
  generateQuestions,
  HrAnalysisError,
} from './ai.js';
import {
  createHrJobRule,
  createHrAnalysisJob,
  createHrMatch,
  claimHrAnalysisJobs,
  getHrCandidate,
  getHrAnalysisJob,
  getHrJob,
  getLatestHrAnalysisJob,
  getActiveHrJobRule,
  getHrResume,
  listHrCandidates,
  listHrInterviewRounds,
  listHrResumesForCandidate,
  markHrAnalysisStatus,
  replaceHrQuestions,
  updateHrCandidate,
  updateHrInterviewRound,
  updateHrResume,
  updateHrAnalysisQueue,
  recoverHrAnalysisJobs,
} from './store.js';
import { logger } from '../logger.js';
import type {
  HrAnalysisJob,
  HrAnalysisType,
  HrCandidate,
  HrJob,
  HrJobRule,
  HrResume,
} from './types.js';
import { extractFileText } from '../file-text-extractor.js';
import { hrMockModelEnabled } from './mock-output.js';
import {
  RESUME_SCORING_VERSION,
  buildMatchResult,
  scoreResumeAssessment,
} from './resume-scoring.js';

export const HR_MODEL_ENV = 'ICLAW_HR_MODEL';

export class HrCandidateAnalysisError extends Error {}

const HR_ANALYSIS_WORKER_ID = `hr-analysis-${crypto.randomUUID()}`;
let hrAnalysisWorkerRunning = false;
let hrAnalysisRetryTimer: ReturnType<typeof setTimeout> | null = null;

export function modelRef(): string | undefined {
  if (hrMockModelEnabled()) return 'hr-mock-model';
  const model = process.env[HR_MODEL_ENV]?.trim();
  return model || undefined;
}

async function runAnalysisStep<T>(
  ownerUserId: string,
  type: HrAnalysisType,
  targetId: string,
  inputHash: string | null,
  operation: () => Promise<T>,
): Promise<T> {
  const analysis = createHrAnalysisJob({
    ownerUserId,
    type,
    targetId,
    inputHash,
    model: modelRef() ?? null,
  });
  markHrAnalysisStatus(ownerUserId, analysis.id, 'running', { attempt: 1 });
  try {
    const result = await operation();
    markHrAnalysisStatus(ownerUserId, analysis.id, 'completed', {
      result,
      model: modelRef() ?? null,
    });
    return result;
  } catch (error) {
    const message =
      error instanceof HrAnalysisError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unknown analysis failure';
    markHrAnalysisStatus(ownerUserId, analysis.id, 'failed', {
      error: message,
      model: modelRef() ?? null,
    });
    throw new HrCandidateAnalysisError(message, { cause: error });
  }
}

function inputHash(...parts: Array<string | null | undefined>): string {
  return Buffer.from(parts.join('\n---\n')).toString('base64url').slice(0, 64);
}

async function latestResume(
  ownerUserId: string,
  candidateId: string,
): Promise<HrResume> {
  const resumes = listHrResumesForCandidate(ownerUserId, candidateId);
  if (resumes.length === 0) {
    throw new HrCandidateAnalysisError('Candidate has no resume');
  }
  const resume = resumes[0]!;
  if (!resume.extractedText?.trim()) {
    const extracted = await extractFileText(resume.filePath);
    if (!extracted?.text.trim()) {
      throw new HrCandidateAnalysisError(
        '简历文本无法提取，可能是扫描件、加密 PDF 或不支持的格式',
      );
    }
    updateHrResume(ownerUserId, resume.id, {
      extractedText: extracted.text,
      parseStatus: 'pending',
    });
    return { ...resume, extractedText: extracted.text };
  }
  return resume;
}

export async function processCandidateAnalysis(
  ownerUserId: string,
  candidateId: string,
  queueJobId?: string,
): Promise<HrCandidate> {
  const candidate = getHrCandidate(ownerUserId, candidateId);
  if (!candidate) throw new HrCandidateAnalysisError('Candidate not found');
  const job = getHrJob(ownerUserId, candidate.jobId);
  if (!job) throw new HrCandidateAnalysisError('Job not found');
  updateHrCandidate(ownerUserId, candidateId, {
    aiStatus: 'running',
    aiError: null,
  });
  if (queueJobId) {
    updateHrAnalysisQueue(ownerUserId, queueJobId, 'running');
  }
  const resume = await latestResume(ownerUserId, candidateId);
  const hash = inputHash(job.jdText, resume.sha256);
  const activeRule = getActiveHrJobRule(ownerUserId, job.id);

  try {
    const parsed = await runAnalysisStep(
      ownerUserId,
      'resume_parse',
      resume.id,
      hash,
      () => analyzeResume(job, resume, modelRef()),
    );
    updateHrResume(ownerUserId, resume.id, {
      extractedText: resume.extractedText,
      parseStatus: 'parsed',
    });
    const parsedNamePatch: Partial<HrCandidate> =
      parsed.full_name && candidate.fullNameSource === 'filename'
        ? {
            fullName: parsed.full_name,
            fullNameSource: 'parsed',
          }
        : {};
    updateHrCandidate(ownerUserId, candidateId, {
      ...parsedNamePatch,
      email: candidate.email ?? parsed.email ?? null,
      phone: candidate.phone ?? parsed.phone ?? null,
      location: candidate.location ?? parsed.location ?? null,
      yearsExperience:
        candidate.yearsExperience ?? parsed.years_experience ?? null,
      summary: parsed.summary,
      profile: parsed as unknown as Record<string, unknown>,
    });

    const assessment = await runAnalysisStep(
      ownerUserId,
      'jd_match',
      candidateId,
      hash,
      async () => {
        const freshCandidate = getHrCandidate(ownerUserId, candidateId)!;
        return analyzeMatch(
          job,
          freshCandidate,
          resume,
          modelRef(),
          activeRule,
        );
      },
    );
    const breakdown = scoreResumeAssessment(assessment);
    const match = buildMatchResult(breakdown);
    createHrMatch({
      ownerUserId,
      jobId: job.id,
      candidateId,
      resumeId: resume.id,
      score: match.score,
      fitLevel: match.fit_level,
      dimensionScores: match.dimension_scores,
      matchedRequirements: match.matched_requirements,
      missingRequirements: match.missing_requirements,
      contradictions: match.contradictions,
      rationale: match.rationale,
      scoreStandard: RESUME_SCORING_VERSION,
      scoreBreakdown: breakdown,
      model: modelRef() ?? null,
    });
    updateHrCandidate(ownerUserId, candidateId, {
      overallScore: match.score,
      recommendation: match.fit_level,
      overallScoreStandard: RESUME_SCORING_VERSION,
      riskFlags: [...match.contradictions, ...match.missing_requirements],
    });

    await runAnalysisStep(
      ownerUserId,
      'interview_questions',
      candidateId,
      hash,
      async () => {
        const freshCandidate = getHrCandidate(ownerUserId, candidateId)!;
        const questions = await generateQuestions(
          job,
          freshCandidate,
          match,
          modelRef(),
        );
        replaceHrQuestions(
          questions.questions.map((question) => ({
            ownerUserId,
            jobId: job.id,
            candidateId,
            category: question.category,
            question: question.question,
            rationale: question.rationale,
            expectedSignal: question.expected_signal,
            priority: question.priority,
            model: modelRef() ?? null,
          })),
        );
        return questions;
      },
    );

    updateHrCandidate(ownerUserId, candidateId, {
      aiStatus: 'completed',
      aiError: null,
    });
    if (queueJobId) {
      updateHrAnalysisQueue(ownerUserId, queueJobId, 'completed', {
        result: { candidateId },
        model: modelRef() ?? null,
      });
    }
    return getHrCandidate(ownerUserId, candidateId)!;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'AI analysis failed';
    updateHrCandidate(ownerUserId, candidateId, {
      aiStatus: 'failed',
      aiError: message,
    });
    if (queueJobId) {
      updateHrAnalysisQueue(ownerUserId, queueJobId, 'failed', {
        error: message,
        model: modelRef() ?? null,
      });
    }
    throw error;
  }
}

export function startCandidateAnalysis(
  ownerUserId: string,
  candidateId: string,
): HrCandidate {
  const started = startCandidateAnalysisWithJob(ownerUserId, candidateId);
  return started.candidate;
}

export function startCandidateAnalysisWithJob(
  ownerUserId: string,
  candidateId: string,
): { candidate: HrCandidate; analysisJobId: string } {
  const candidate = getHrCandidate(ownerUserId, candidateId);
  if (!candidate) throw new HrCandidateAnalysisError('Candidate not found');
  if (candidate.aiStatus === 'running') {
    const latest = getLatestHrAnalysisJob(
      ownerUserId,
      'candidate_analysis',
      candidateId,
    );
    if (latest) {
      return { candidate, analysisJobId: latest.id };
    }
  }
  updateHrCandidate(ownerUserId, candidateId, {
    aiStatus: 'running',
    aiError: null,
  });
  const analysisJob = createHrAnalysisJob({
    ownerUserId,
    type: 'candidate_analysis',
    targetId: candidateId,
    inputHash: null,
    model: modelRef() ?? null,
  });
  void runHrAnalysisWorkerOnce();
  return {
    candidate: getHrCandidate(ownerUserId, candidateId)!,
    analysisJobId: analysisJob.id,
  };
}

async function runHrAnalysisWorkerOnce(): Promise<void> {
  if (hrAnalysisWorkerRunning) return;
  hrAnalysisWorkerRunning = true;
  try {
    while (true) {
      const [job] = claimHrAnalysisJobs(null, HR_ANALYSIS_WORKER_ID, 1);
      if (!job) break;
      if (job.type !== 'candidate_analysis') {
        updateHrAnalysisQueue(job.ownerUserId, job.id, 'completed');
        continue;
      }
      try {
        await processCandidateAnalysis(job.ownerUserId, job.targetId, job.id);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'AI analysis failed';
        if (job.attempt < job.maxAttempt) {
          const nextRetryAt = new Date(
            Date.now() + Math.min(15 * 60 * 1000, 2 ** job.attempt * 15_000),
          ).toISOString();
          updateHrAnalysisQueue(job.ownerUserId, job.id, 'retrying', {
            error: message,
            nextRetryAt,
          });
          const delay = Math.max(
            0,
            new Date(nextRetryAt).getTime() - Date.now(),
          );
          if (hrAnalysisRetryTimer) clearTimeout(hrAnalysisRetryTimer);
          hrAnalysisRetryTimer = setTimeout(
            () => void runHrAnalysisWorkerOnce(),
            delay,
          );
        } else {
          updateHrAnalysisQueue(job.ownerUserId, job.id, 'failed', {
            error: message,
          });
        }
        logger.warn(
          {
            candidateId: job.targetId,
            analysisJobId: job.id,
            attempt: job.attempt,
            error: message,
          },
          'HR analysis job failed',
        );
      }
    }
  } finally {
    hrAnalysisWorkerRunning = false;
  }
}

export function startHrAnalysisQueueWorker(): number {
  const recovered = recoverHrAnalysisJobs(HR_ANALYSIS_WORKER_ID);
  void runHrAnalysisWorkerOnce();
  return recovered;
}

export function retryHrAnalysisJob(
  ownerUserId: string,
  analysisJobId: string,
): HrCandidate {
  const analysisJob = getHrAnalysisJob(ownerUserId, analysisJobId);
  if (!analysisJob || analysisJob.type !== 'candidate_analysis') {
    throw new HrCandidateAnalysisError('Analysis job not found');
  }
  const candidate = getHrCandidate(ownerUserId, analysisJob.targetId);
  if (!candidate) throw new HrCandidateAnalysisError('Candidate not found');
  updateHrCandidate(ownerUserId, candidate.id, {
    aiStatus: 'running',
    aiError: null,
  });
  updateHrAnalysisQueue(ownerUserId, analysisJob.id, 'queued', {
    error: null,
    nextRetryAt: null,
  });
  void runHrAnalysisWorkerOnce();
  return getHrCandidate(ownerUserId, candidate.id)!;
}

export function analyzePendingCandidates(
  ownerUserId: string,
  jobId: string,
): number {
  const job = getHrJob(ownerUserId, jobId);
  if (!job) throw new HrCandidateAnalysisError('Job not found');
  const candidates = listHrCandidates(ownerUserId, { jobId, limit: 500 });
  let queued = 0;
  for (const candidate of candidates) {
    if (candidate.aiStatus === 'pending' || candidate.aiStatus === 'failed') {
      startCandidateAnalysis(ownerUserId, candidate.id);
      queued += 1;
    }
  }
  return queued;
}

export async function runFeedbackAnalysis(
  ownerUserId: string,
  candidateId: string,
  roundId: string,
): Promise<HrJobRule | undefined> {
  const candidate = getHrCandidate(ownerUserId, candidateId);
  if (!candidate) throw new HrCandidateAnalysisError('Candidate not found');
  const job = getHrJob(ownerUserId, candidate.jobId);
  if (!job) throw new HrCandidateAnalysisError('Job not found');
  const round = listHrInterviewRounds(ownerUserId, candidateId).find(
    (item) => item.id === roundId,
  );
  if (!round) throw new HrCandidateAnalysisError('Interview round not found');
  if (!['interview_1', 'interview_2', 'interview_3'].includes(round.stage))
    throw new HrCandidateAnalysisError(
      'Interview feedback is only available after interview rounds',
    );
  const hash = inputHash(job.jdText, round.feedbackText);
  const result = await runAnalysisStep(
    ownerUserId,
    'feedback_analysis',
    roundId,
    hash,
    () => analyzeFeedback(job, candidate, round, modelRef()),
  );
  updateHrInterviewRound(ownerUserId, roundId, {
    score: result.score,
    analysis: result as unknown as Record<string, unknown>,
    model: modelRef() ?? null,
  });
  const hasRuleSignal =
    result.new_requirements.length > 0 ||
    result.jd_gaps.length > 0 ||
    result.contradictions.length > 0;
  const jobRule = hasRuleSignal
    ? createHrJobRule({
        ownerUserId,
        jobId: job.id,
        status: 'draft',
        sourceRoundId: roundId,
        summary: result.summary,
        newRequirements: result.new_requirements,
        jdGaps: result.jd_gaps,
        contradictions: result.contradictions,
        decisionSuggestion: result.decision_suggestion,
        model: modelRef() ?? null,
      })
    : undefined;
  return jobRule;
}

async function executeMarketAnalysis(
  ownerUserId: string,
  jobId: string,
  analysisJobId: string,
): Promise<unknown> {
  const job = getHrJob(ownerUserId, jobId);
  if (!job) throw new HrCandidateAnalysisError('Job not found');
  const candidates = listHrCandidates(ownerUserId, { jobId, limit: 500 });
  const rounds = candidates.flatMap((candidate) =>
    listHrInterviewRounds(ownerUserId, candidate.id),
  );
  const hash = inputHash(
    job.jdText,
    candidates.map((item) => item.id + item.stage).join('|'),
  );
  markHrAnalysisStatus(ownerUserId, analysisJobId, 'running', {
    attempt: 1,
    model: modelRef() ?? null,
  });
  try {
    const result = await analyzeMarket(job, candidates, rounds, modelRef());
    markHrAnalysisStatus(ownerUserId, analysisJobId, 'completed', {
      result,
      model: modelRef() ?? null,
    });
    return result;
  } catch (error) {
    const message =
      error instanceof HrAnalysisError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unknown analysis failure';
    markHrAnalysisStatus(ownerUserId, analysisJobId, 'failed', {
      error: message,
      model: modelRef() ?? null,
    });
    throw new HrCandidateAnalysisError(message, { cause: error });
  }
}

export async function runMarketAnalysis(
  ownerUserId: string,
  jobId: string,
): Promise<unknown> {
  const job = getHrJob(ownerUserId, jobId);
  if (!job) throw new HrCandidateAnalysisError('Job not found');
  const analysis = createHrAnalysisJob({
    ownerUserId,
    type: 'market_analysis',
    targetId: jobId,
    inputHash: null,
    model: modelRef() ?? null,
  });
  return executeMarketAnalysis(ownerUserId, jobId, analysis.id);
}

export function startHrMarketAnalysis(
  ownerUserId: string,
  jobId: string,
): HrAnalysisJob {
  const job = getHrJob(ownerUserId, jobId);
  if (!job || job.deletedAt)
    throw new HrCandidateAnalysisError('Job not found');
  const analysis = createHrAnalysisJob({
    ownerUserId,
    type: 'market_analysis',
    targetId: jobId,
    inputHash: null,
    model: modelRef() ?? null,
  });
  void executeMarketAnalysis(ownerUserId, jobId, analysis.id).catch(
    () => undefined,
  );
  return analysis;
}

export type { HrJob, HrResume };
