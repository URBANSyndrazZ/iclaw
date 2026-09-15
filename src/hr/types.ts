import type { ResumeScoreBreakdown } from './resume-scoring.js';

export const HR_STAGES = [
  'pending_tech_screen',
  'interview_1',
  'interview_2',
  'interview_3',
  'salary_discussion',
  'offer_sent',
  'closed_hired',
  'closed_rejected',
  'closed_withdrawn',
] as const;

export type HrStage = (typeof HR_STAGES)[number];

export type HrJobStatus = 'active' | 'paused' | 'closed';
export type HrCandidateSource = 'upload' | 'link' | 'boss_opencli' | 'manual';
export type HrCandidateNameSource =
  | 'filename'
  | 'parsed'
  | 'provided'
  | 'manual'
  | 'unknown';
export type HrResumeParseStatus =
  | 'pending'
  | 'parsed'
  | 'failed'
  | 'unsupported';
export type HrFitLevel = 'strong_fit' | 'fit' | 'borderline' | 'not_fit';
export type HrScoreStandard = 'legacy' | 'resume_scoring_v2';
export type HrAnalysisType =
  | 'candidate_analysis'
  | 'resume_parse'
  | 'jd_match'
  | 'interview_questions'
  | 'feedback_analysis'
  | 'market_analysis';
export type HrAnalysisStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'retrying';
export type HrSyncStatus = 'pending' | 'synced' | 'failed';
export type HrCandidateAiStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';
export type HrJobRuleStatus = 'draft' | 'active' | 'archived' | 'discarded';

export const HR_STAGE_LABELS: Record<HrStage, string> = {
  pending_tech_screen: '待技术初筛',
  interview_1: '一面',
  interview_2: '二面',
  interview_3: '三面',
  salary_discussion: '谈薪',
  offer_sent: '已发 Offer',
  closed_hired: '已入职',
  closed_rejected: '已淘汰',
  closed_withdrawn: '已放弃',
};

export interface HrJob {
  id: string;
  ownerUserId: string;
  title: string;
  department: string | null;
  location: string | null;
  level: string | null;
  salaryRange: string | null;
  status: HrJobStatus;
  jdText: string;
  keywords: string[];
  responsibilities: string[];
  requirements: string[];
  preferred: string[];
  techStack: string[];
  expiresAt: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrCandidate {
  id: string;
  ownerUserId: string;
  jobId: string;
  fullName: string;
  fullNameSource: HrCandidateNameSource;
  email: string | null;
  phone: string | null;
  location: string | null;
  source: HrCandidateSource;
  sourceUrl: string | null;
  stage: HrStage;
  talentPool: boolean;
  yearsExperience: number | null;
  summary: string | null;
  recommendation: string | null;
  overallScore: number | null;
  overallScoreStandard: HrScoreStandard;
  riskFlags: string[];
  profile: Record<string, unknown> | null;
  aiStatus: HrCandidateAiStatus;
  aiError: string | null;
  interviewer1: string | null;
  interviewer2: string | null;
  interviewer3: string | null;
  closedAt: string | null;
  retentionExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrResume {
  id: string;
  ownerUserId: string;
  candidateId: string;
  jobId: string | null;
  filePath: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  sha256: string;
  extractedText: string | null;
  parserVersion: string;
  parseStatus: HrResumeParseStatus;
  createdAt: string;
}

export interface HrMatch {
  id: string;
  ownerUserId: string;
  jobId: string;
  candidateId: string;
  resumeId: string;
  score: number;
  fitLevel: HrFitLevel;
  dimensionScores: Record<string, number>;
  matchedRequirements: Array<{ requirement: string; evidence: string }>;
  missingRequirements: string[];
  contradictions: string[];
  rationale: string;
  model: string | null;
  scoreStandard: HrScoreStandard;
  scoreBreakdown: ResumeScoreBreakdown | null;
  createdAt: string;
}

export interface HrInterviewQuestion {
  id: string;
  ownerUserId: string;
  jobId: string;
  candidateId: string;
  category: string;
  question: string;
  rationale: string;
  expectedSignal: string;
  priority: number;
  model: string | null;
  createdAt: string;
}

export interface HrInterviewRound {
  id: string;
  ownerUserId: string;
  jobId: string;
  candidateId: string;
  stage: HrStage;
  interviewer: string | null;
  scheduledAt: string | null;
  completedAt: string | null;
  outcome: string | null;
  feedbackText: string;
  score: number | null;
  analysis: Record<string, unknown> | null;
  model: string | null;
  createdAt: string;
}

export interface HrAnalysisJob {
  id: string;
  ownerUserId: string;
  type: HrAnalysisType;
  targetId: string;
  status: HrAnalysisStatus;
  attempt: number;
  maxAttempt: number;
  inputHash: string | null;
  result: unknown;
  error: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  leaseExpiresAt: string | null;
  model: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface HrFeishuConfig {
  id: string;
  ownerUserId: string;
  channelAccountId: string;
  appToken: string;
  tableId: string;
  fieldMapping: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HrFeishuSync {
  id: string;
  ownerUserId: string;
  candidateId: string;
  configId: string;
  recordId: string | null;
  payloadHash: string | null;
  status: HrSyncStatus;
  attempt: number;
  error: string | null;
  lastSyncedAt: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface HrJobRule {
  id: string;
  ownerUserId: string;
  jobId: string;
  ruleVersion: number;
  status: HrJobRuleStatus;
  sourceRoundId: string | null;
  summary: string;
  newRequirements: string[];
  jdGaps: string[];
  contradictions: string[];
  decisionSuggestion: string | null;
  model: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface HrAuditLog {
  id: string;
  ownerUserId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}
