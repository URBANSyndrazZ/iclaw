import crypto from 'node:crypto';
import type {
  HrAnalysisJob,
  HrAnalysisStatus,
  HrAuditLog,
  HrCandidate,
  HrFeishuConfig,
  HrFeishuSync,
  HrCandidateAiStatus,
  HrCandidateNameSource,
  HrInterviewQuestion,
  HrInterviewRound,
  HrAnalysisType,
  HrJobRule,
  HrJobRuleStatus,
  HrJob,
  HrMatch,
  HrResume,
} from './types.js';
import type { ResumeScoreBreakdown } from './resume-scoring.js';

interface SqliteRunResult {
  changes: number;
}
interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

let db: SqliteDatabase | null = null;
function requireDb(): SqliteDatabase {
  if (!db) throw new Error('HR store is not bound to a database');
  return db;
}
function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}
function nullableText(value: unknown): string | null {
  const text = value === null || value === undefined ? null : String(value);
  return text && text.length > 0 ? text : null;
}

export function createHrSchema(connection: SqliteDatabase): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS hr_jobs (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, title TEXT NOT NULL,
      department TEXT, location TEXT, level TEXT, salary_range TEXT,
      status TEXT NOT NULL DEFAULT 'active', jd_text TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]', responsibilities TEXT NOT NULL DEFAULT '[]',
      requirements TEXT NOT NULL DEFAULT '[]', preferred TEXT NOT NULL DEFAULT '[]',
      tech_stack TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_jobs_owner ON hr_jobs(owner_user_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS hr_candidates (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, job_id TEXT NOT NULL,
      full_name TEXT NOT NULL, email TEXT, phone TEXT, location TEXT, source TEXT NOT NULL,
      source_url TEXT, stage TEXT NOT NULL DEFAULT 'pending_tech_screen',
      talent_pool INTEGER NOT NULL DEFAULT 0, years_experience INTEGER, summary TEXT,
      recommendation TEXT, overall_score REAL, overall_score_standard TEXT,
      risk_flags TEXT NOT NULL DEFAULT '[]',
      profile TEXT, interviewer_1 TEXT, interviewer_2 TEXT, interviewer_3 TEXT,
      closed_at TEXT, retention_expires_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_candidates_owner ON hr_candidates(owner_user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hr_candidates_job ON hr_candidates(job_id, stage);
    CREATE TABLE IF NOT EXISTS hr_resumes (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
      job_id TEXT, file_path TEXT NOT NULL, file_name TEXT NOT NULL, mime_type TEXT,
      size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, extracted_text TEXT,
      parser_version TEXT NOT NULL DEFAULT 'v1', parse_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_resumes_candidate ON hr_resumes(candidate_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS hr_matches (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, job_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL, resume_id TEXT NOT NULL, score REAL NOT NULL,
      fit_level TEXT NOT NULL, dimension_scores TEXT NOT NULL DEFAULT '{}',
      matched_requirements TEXT NOT NULL DEFAULT '[]',
      missing_requirements TEXT NOT NULL DEFAULT '[]',
      contradictions TEXT NOT NULL DEFAULT '[]', rationale TEXT NOT NULL,
      model TEXT, score_standard TEXT, score_breakdown TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_matches_candidate ON hr_matches(candidate_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS hr_interview_questions (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, job_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL, category TEXT NOT NULL, question TEXT NOT NULL,
      rationale TEXT NOT NULL, expected_signal TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 3, model TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_questions_candidate ON hr_interview_questions(candidate_id, priority);
    CREATE TABLE IF NOT EXISTS hr_interview_rounds (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, job_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL, stage TEXT NOT NULL, interviewer TEXT,
      scheduled_at TEXT, completed_at TEXT, outcome TEXT, feedback_text TEXT NOT NULL,
      score REAL, analysis TEXT, model TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_rounds_candidate ON hr_interview_rounds(candidate_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS hr_analysis_jobs (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, type TEXT NOT NULL,
      target_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      attempt INTEGER NOT NULL DEFAULT 0, input_hash TEXT, result TEXT, error TEXT,
      model TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL,
      max_attempt INTEGER NOT NULL DEFAULT 3, last_error TEXT,
      next_retry_at TEXT, locked_at TEXT, locked_by TEXT, lease_expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hr_analysis_target ON hr_analysis_jobs(type, target_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS hr_feishu_configs (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL UNIQUE,
      channel_account_id TEXT NOT NULL, app_token TEXT NOT NULL, table_id TEXT NOT NULL,
      field_mapping TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hr_feishu_syncs (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, candidate_id TEXT NOT NULL UNIQUE,
      config_id TEXT NOT NULL, record_id TEXT, payload_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending', attempt INTEGER NOT NULL DEFAULT 0,
      error TEXT, last_synced_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hr_audit_log (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT,
      detail TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_audit_owner ON hr_audit_log(owner_user_id, created_at DESC);
  `);
  const columns = (table: string) =>
    connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
  const hasColumn = (table: string, name: string) =>
    columns(table).some((column) => column.name === name);
  if (!hasColumn('hr_candidates', 'ai_status')) {
    connection.exec(
      `ALTER TABLE hr_candidates ADD COLUMN ai_status TEXT NOT NULL DEFAULT 'pending'`,
    );
  }
  if (!hasColumn('hr_candidates', 'ai_error')) {
    connection.exec('ALTER TABLE hr_candidates ADD COLUMN ai_error TEXT');
  }
  for (const [name, definition] of [
    ['full_name_source', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['interviewer_1', 'TEXT'],
    ['interviewer_2', 'TEXT'],
    ['interviewer_3', 'TEXT'],
    ['closed_at', 'TEXT'],
    ['retention_expires_at', 'TEXT'],
    ['overall_score_standard', 'TEXT'],
  ] as Array<[string, string]>) {
    if (!hasColumn('hr_candidates', name)) {
      connection.exec(
        `ALTER TABLE hr_candidates ADD COLUMN ${name} ${definition}`,
      );
    }
  }
  for (const [name, definition] of [
    ['score_standard', 'TEXT'],
    ['score_breakdown', 'TEXT'],
  ] as Array<[string, string]>) {
    if (!hasColumn('hr_matches', name)) {
      connection.exec(
        `ALTER TABLE hr_matches ADD COLUMN ${name} ${definition}`,
      );
    }
  }
  for (const [name, definition] of [
    ['max_attempt', 'INTEGER NOT NULL DEFAULT 3'],
    ['last_error', 'TEXT'],
    ['next_retry_at', 'TEXT'],
    ['locked_at', 'TEXT'],
    ['locked_by', 'TEXT'],
    ['lease_expires_at', 'TEXT'],
  ] as Array<[string, string]>) {
    if (!hasColumn('hr_analysis_jobs', name)) {
      connection.exec(
        `ALTER TABLE hr_analysis_jobs ADD COLUMN ${name} ${definition}`,
      );
    }
  }
  for (const [name, definition] of [
    ['expires_at', 'TEXT'],
    ['deleted_at', 'TEXT'],
    ['deleted_by', 'TEXT'],
  ] as Array<[string, string]>) {
    if (!hasColumn('hr_jobs', name)) {
      connection.exec(`ALTER TABLE hr_jobs ADD COLUMN ${name} ${definition}`);
    }
  }
  connection.exec(`
    UPDATE hr_candidates SET ai_status = 'completed'
    WHERE overall_score IS NOT NULL AND ai_status = 'pending';
    CREATE TABLE IF NOT EXISTS hr_job_rules (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, job_id TEXT NOT NULL,
      rule_version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
      source_round_id TEXT, summary TEXT NOT NULL, new_requirements TEXT NOT NULL DEFAULT '[]',
      jd_gaps TEXT NOT NULL DEFAULT '[]', contradictions TEXT NOT NULL DEFAULT '[]',
      decision_suggestion TEXT, model TEXT, created_at TEXT NOT NULL, reviewed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hr_job_rules_job ON hr_job_rules(job_id, rule_version DESC);
  `);
}
export function bindHrDatabase(connection: SqliteDatabase | null): void {
  db = connection;
}

function mapJob(row: any): HrJob {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    title: String(row.title),
    department: nullableText(row.department),
    location: nullableText(row.location),
    level: nullableText(row.level),
    salaryRange: nullableText(row.salary_range),
    status: row.status as HrJob['status'],
    jdText: String(row.jd_text),
    keywords: json<string[]>(row.keywords, []),
    responsibilities: json<string[]>(row.responsibilities, []),
    requirements: json<string[]>(row.requirements, []),
    preferred: json<string[]>(row.preferred, []),
    techStack: json<string[]>(row.tech_stack, []),
    expiresAt: nullableText(row.expires_at),
    deletedAt: nullableText(row.deleted_at),
    deletedBy: nullableText(row.deleted_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapCandidate(row: any): HrCandidate {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    jobId: String(row.job_id),
    fullName: String(row.full_name),
    fullNameSource: (row.full_name_source ??
      'unknown') as HrCandidateNameSource,
    email: nullableText(row.email),
    phone: nullableText(row.phone),
    location: nullableText(row.location),
    source: row.source as HrCandidate['source'],
    sourceUrl: nullableText(row.source_url),
    stage: row.stage as HrCandidate['stage'],
    talentPool: Number(row.talent_pool) === 1,
    yearsExperience:
      row.years_experience == null ? null : Number(row.years_experience),
    summary: nullableText(row.summary),
    recommendation: nullableText(row.recommendation),
    overallScore: row.overall_score == null ? null : Number(row.overall_score),
    overallScoreStandard: (row.overall_score_standard ??
      'legacy') as HrCandidate['overallScoreStandard'],
    riskFlags: json<string[]>(row.risk_flags, []),
    profile: json<Record<string, unknown> | null>(row.profile, null),
    aiStatus: (row.ai_status ?? 'pending') as HrCandidateAiStatus,
    aiError: nullableText(row.ai_error),
    interviewer1: nullableText(row.interviewer_1),
    interviewer2: nullableText(row.interviewer_2),
    interviewer3: nullableText(row.interviewer_3),
    closedAt: nullableText(row.closed_at),
    retentionExpiresAt: nullableText(row.retention_expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapResume(row: any): HrResume {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    candidateId: String(row.candidate_id),
    jobId: nullableText(row.job_id),
    filePath: String(row.file_path),
    fileName: String(row.file_name),
    mimeType: nullableText(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    extractedText: nullableText(row.extracted_text),
    parserVersion: String(row.parser_version),
    parseStatus: row.parse_status as HrResume['parseStatus'],
    createdAt: String(row.created_at),
  };
}

function mapMatch(row: any): HrMatch {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    jobId: String(row.job_id),
    candidateId: String(row.candidate_id),
    resumeId: String(row.resume_id),
    score: Number(row.score),
    fitLevel: row.fit_level as HrMatch['fitLevel'],
    dimensionScores: json<Record<string, number>>(row.dimension_scores, {}),
    matchedRequirements: json<Array<{ requirement: string; evidence: string }>>(
      row.matched_requirements,
      [],
    ),
    missingRequirements: json<string[]>(row.missing_requirements, []),
    contradictions: json<string[]>(row.contradictions, []),
    rationale: String(row.rationale),
    model: nullableText(row.model),
    scoreStandard: (row.score_standard ?? 'legacy') as HrMatch['scoreStandard'],
    scoreBreakdown: json<ResumeScoreBreakdown | null>(
      row.score_breakdown,
      null,
    ),
    createdAt: String(row.created_at),
  };
}

function mapQuestion(row: any): HrInterviewQuestion {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    jobId: String(row.job_id),
    candidateId: String(row.candidate_id),
    category: String(row.category),
    question: String(row.question),
    rationale: String(row.rationale),
    expectedSignal: String(row.expected_signal),
    priority: Number(row.priority),
    model: nullableText(row.model),
    createdAt: String(row.created_at),
  };
}

function mapRound(row: any): HrInterviewRound {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    jobId: String(row.job_id),
    candidateId: String(row.candidate_id),
    stage: row.stage as HrInterviewRound['stage'],
    interviewer: nullableText(row.interviewer),
    scheduledAt: nullableText(row.scheduled_at),
    completedAt: nullableText(row.completed_at),
    outcome: nullableText(row.outcome),
    feedbackText: String(row.feedback_text),
    score: row.score == null ? null : Number(row.score),
    analysis: json<Record<string, unknown> | null>(row.analysis, null),
    model: nullableText(row.model),
    createdAt: String(row.created_at),
  };
}

function mapAnalysisJob(row: any): HrAnalysisJob {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    type: row.type as HrAnalysisJob['type'],
    targetId: String(row.target_id),
    status: row.status as HrAnalysisJob['status'],
    attempt: Number(row.attempt),
    maxAttempt: Number(row.max_attempt ?? 3),
    inputHash: nullableText(row.input_hash),
    result: json<unknown>(row.result, null),
    error: nullableText(row.error),
    lastError: nullableText(row.last_error ?? row.error),
    nextRetryAt: nullableText(row.next_retry_at),
    lockedAt: nullableText(row.locked_at),
    lockedBy: nullableText(row.locked_by),
    leaseExpiresAt: nullableText(row.lease_expires_at),
    model: nullableText(row.model),
    startedAt: nullableText(row.started_at),
    finishedAt: nullableText(row.finished_at),
    createdAt: String(row.created_at),
  };
}

function mapFeishuConfig(row: any): HrFeishuConfig {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    channelAccountId: String(row.channel_account_id),
    appToken: String(row.app_token),
    tableId: String(row.table_id),
    fieldMapping: json<Record<string, string>>(row.field_mapping, {}),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapFeishuSync(row: any): HrFeishuSync {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    candidateId: String(row.candidate_id),
    configId: String(row.config_id),
    recordId: nullableText(row.record_id),
    payloadHash: nullableText(row.payload_hash),
    status: row.status as HrFeishuSync['status'],
    attempt: Number(row.attempt),
    error: nullableText(row.error),
    lastSyncedAt: nullableText(row.last_synced_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapJobRule(row: any): HrJobRule {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    jobId: String(row.job_id),
    ruleVersion: Number(row.rule_version),
    status: row.status as HrJobRuleStatus,
    sourceRoundId: nullableText(row.source_round_id),
    summary: String(row.summary),
    newRequirements: json<string[]>(row.new_requirements, []),
    jdGaps: json<string[]>(row.jd_gaps, []),
    contradictions: json<string[]>(row.contradictions, []),
    decisionSuggestion: nullableText(row.decision_suggestion),
    model: nullableText(row.model),
    createdAt: String(row.created_at),
    reviewedAt: nullableText(row.reviewed_at),
  };
}

export function listHrJobs(
  ownerUserId: string,
  options: { includeDeleted?: boolean } = {},
): HrJob[] {
  const rows = requireDb()
    .prepare(
      `SELECT * FROM hr_jobs WHERE owner_user_id = ? ${options.includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY updated_at DESC`,
    )
    .all(ownerUserId) as any[];
  return rows.map(mapJob);
}

export type HrJobLifecycle =
  | 'active'
  | 'paused'
  | 'closed'
  | 'expired'
  | 'deleted'
  | 'all';

export interface HrJobPageFilters {
  search?: string;
  lifecycle?: HrJobLifecycle;
  limit: number;
  offset: number;
}

function hrJobLifecycleCondition(lifecycle: HrJobLifecycle | undefined): {
  sql: string;
  params: unknown[];
} {
  const now = new Date().toISOString();
  if (!lifecycle) return { sql: 'deleted_at IS NULL', params: [] };
  if (lifecycle === 'all') return { sql: '1 = 1', params: [] };
  if (lifecycle === 'deleted') {
    return { sql: 'deleted_at IS NOT NULL', params: [] };
  }
  if (lifecycle === 'expired') {
    return {
      sql: 'deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?',
      params: [now],
    };
  }
  return {
    sql: `deleted_at IS NULL AND status = ? AND (expires_at IS NULL OR expires_at > ?)`,
    params: [lifecycle, now],
  };
}

export function listHrJobsPaged(
  ownerUserId: string,
  filters: HrJobPageFilters,
): { items: HrJob[]; total: number } {
  const lifecycle = hrJobLifecycleCondition(filters.lifecycle);
  const clauses = ['owner_user_id = ?', lifecycle.sql];
  const params: unknown[] = [ownerUserId, ...lifecycle.params];
  const search = filters.search?.trim();
  if (search) {
    clauses.push('(title LIKE ? OR department LIKE ? OR location LIKE ?)');
    const keyword = `%${search}%`;
    params.push(keyword, keyword, keyword);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const countRow = requireDb()
    .prepare(`SELECT COUNT(*) AS total FROM hr_jobs ${where}`)
    .get(...params) as { total: number | string };
  const rows = requireDb()
    .prepare(
      `SELECT * FROM hr_jobs ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, filters.limit, filters.offset) as any[];
  return { items: rows.map(mapJob), total: Number(countRow.total) };
}

export function getHrJob(
  ownerUserId: string,
  jobId: string,
): HrJob | undefined {
  const row = requireDb()
    .prepare('SELECT * FROM hr_jobs WHERE id = ? AND owner_user_id = ?')
    .get(jobId, ownerUserId) as any;
  return row ? mapJob(row) : undefined;
}

export function createHrJob(
  input: Omit<
    HrJob,
    'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'deletedBy'
  > &
    Partial<Pick<HrJob, 'expiresAt'>>,
): HrJob {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  requireDb()
    .prepare(
      `
    INSERT INTO hr_jobs (id, owner_user_id, title, department, location, level, salary_range, status,
      jd_text, keywords, responsibilities, requirements, preferred, tech_stack,
      expires_at, deleted_at, deleted_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      id,
      input.ownerUserId,
      input.title,
      input.department,
      input.location,
      input.level,
      input.salaryRange,
      input.status,
      input.jdText,
      JSON.stringify(input.keywords),
      JSON.stringify(input.responsibilities),
      JSON.stringify(input.requirements),
      JSON.stringify(input.preferred),
      JSON.stringify(input.techStack),
      input.expiresAt ?? null,
      null,
      null,
      now,
      now,
    );
  return getHrJob(input.ownerUserId, id)!;
}

export function updateHrJob(
  ownerUserId: string,
  jobId: string,
  patch: Partial<HrJob>,
): HrJob | undefined {
  const existing = getHrJob(ownerUserId, jobId);
  if (!existing || existing.deletedAt) return undefined;
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  requireDb()
    .prepare(
      `
    UPDATE hr_jobs SET title = ?, department = ?, location = ?, level = ?, salary_range = ?,
      status = ?, jd_text = ?, keywords = ?, responsibilities = ?, requirements = ?,
      preferred = ?, tech_stack = ?, expires_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?
  `,
    )
    .run(
      next.title,
      next.department,
      next.location,
      next.level,
      next.salaryRange,
      next.status,
      next.jdText,
      JSON.stringify(next.keywords),
      JSON.stringify(next.responsibilities),
      JSON.stringify(next.requirements),
      JSON.stringify(next.preferred),
      JSON.stringify(next.techStack),
      next.expiresAt ?? null,
      next.updatedAt,
      jobId,
      ownerUserId,
    );
  return getHrJob(ownerUserId, jobId);
}

export function softDeleteHrJob(
  ownerUserId: string,
  jobId: string,
  deletedBy: string,
): HrJob | undefined {
  const existing = getHrJob(ownerUserId, jobId);
  if (!existing || existing.deletedAt) return undefined;
  requireDb()
    .prepare(
      `
    UPDATE hr_jobs SET deleted_at = ?, deleted_by = ?, updated_at = ?
    WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL
  `,
    )
    .run(
      new Date().toISOString(),
      deletedBy,
      new Date().toISOString(),
      jobId,
      ownerUserId,
    );
  return getHrJob(ownerUserId, jobId);
}

export function restoreHrJob(
  ownerUserId: string,
  jobId: string,
): HrJob | undefined {
  const row = requireDb()
    .prepare(
      'SELECT * FROM hr_jobs WHERE id = ? AND owner_user_id = ? AND deleted_at IS NOT NULL',
    )
    .get(jobId, ownerUserId) as any;
  if (!row) return undefined;
  requireDb()
    .prepare(
      `
    UPDATE hr_jobs SET deleted_at = NULL, deleted_by = NULL, updated_at = ?
    WHERE id = ? AND owner_user_id = ? AND deleted_at IS NOT NULL
  `,
    )
    .run(new Date().toISOString(), jobId, ownerUserId);
  return getHrJob(ownerUserId, jobId);
}

export function expireHrJobs(): Array<{ ownerUserId: string; job: HrJob }> {
  const now = new Date().toISOString();
  const rows = requireDb()
    .prepare(
      `
    SELECT * FROM hr_jobs
    WHERE deleted_at IS NULL AND status = 'active'
      AND expires_at IS NOT NULL AND expires_at <= ?
  `,
    )
    .all(now) as any[];
  return rows.map((row) => {
    const jobId = String(row.id);
    const ownerUserId = String(row.owner_user_id);
    requireDb()
      .prepare(
        `
      UPDATE hr_jobs SET status = 'closed', updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND status = 'active' AND deleted_at IS NULL
    `,
      )
      .run(now, jobId, ownerUserId);
    return { ownerUserId, job: getHrJob(ownerUserId, jobId)! };
  });
}

export interface HrCandidateFilters {
  jobId?: string;
  stage?: string;
  talentPool?: boolean;
  search?: string;
  cleanupDue?: boolean;
  limit?: number;
  offset?: number;
}

export function listHrCandidates(
  ownerUserId: string,
  filters: HrCandidateFilters = {},
): HrCandidate[] {
  const clauses = ['owner_user_id = ?'];
  const params: unknown[] = [ownerUserId];
  if (filters.jobId) {
    clauses.push('job_id = ?');
    params.push(filters.jobId);
  }
  if (filters.stage) {
    clauses.push('stage = ?');
    params.push(filters.stage);
  }
  if (typeof filters.talentPool === 'boolean') {
    clauses.push('talent_pool = ?');
    params.push(filters.talentPool ? 1 : 0);
  }
  if (filters.cleanupDue) {
    clauses.push(
      "stage IN ('closed_hired','closed_rejected','closed_withdrawn')",
    );
    clauses.push(
      'retention_expires_at IS NOT NULL AND retention_expires_at <= ?',
    );
    params.push(new Date().toISOString());
  }
  if (filters.search?.trim()) {
    clauses.push('(full_name LIKE ? OR email LIKE ? OR phone LIKE ?)');
    const search = `%${filters.search.trim()}%`;
    params.push(search, search, search);
  }
  params.push(
    Math.min(filters.limit ?? 100, 500),
    Math.max(filters.offset ?? 0, 0),
  );
  const rows = requireDb()
    .prepare(
      `
    SELECT * FROM hr_candidates WHERE ${clauses.join(' AND ')}
    ORDER BY updated_at DESC LIMIT ? OFFSET ?
  `,
    )
    .all(...params) as any[];
  return rows.map(mapCandidate);
}

export interface HrCandidatePageFilters {
  search?: string;
  jobId?: string;
  stage?: string;
  source?: string;
  talentPool?: boolean;
  cleanupDue?: boolean;
  limit: number;
  offset: number;
}

export function listHrCandidatesPaged(
  ownerUserId: string,
  filters: HrCandidatePageFilters,
): { items: HrCandidate[]; total: number; sources: string[] } {
  const clauses = ['c.owner_user_id = ?'];
  const params: unknown[] = [ownerUserId];
  if (filters.jobId) {
    clauses.push('c.job_id = ?');
    params.push(filters.jobId);
  }
  if (filters.stage) {
    clauses.push('c.stage = ?');
    params.push(filters.stage);
  }
  if (filters.source) {
    clauses.push('c.source = ?');
    params.push(filters.source);
  }
  if (typeof filters.talentPool === 'boolean') {
    clauses.push('c.talent_pool = ?');
    params.push(filters.talentPool ? 1 : 0);
  }
  if (filters.cleanupDue) {
    clauses.push(
      "c.stage IN ('closed_hired','closed_rejected','closed_withdrawn')",
    );
    clauses.push(
      'c.retention_expires_at IS NOT NULL AND c.retention_expires_at <= ?',
    );
    params.push(new Date().toISOString());
  }
  const search = filters.search?.trim();
  if (search) {
    clauses.push('(c.full_name LIKE ? OR j.title LIKE ?)');
    const keyword = `%${search}%`;
    params.push(keyword, keyword);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const from = `
    FROM hr_candidates c
    LEFT JOIN hr_jobs j ON j.id = c.job_id AND j.owner_user_id = c.owner_user_id
  `;
  const countRow = requireDb()
    .prepare(`SELECT COUNT(*) AS total ${from} ${where}`)
    .get(...params) as { total: number | string };
  const rows = requireDb()
    .prepare(
      `SELECT c.* ${from} ${where} ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, filters.limit, filters.offset) as any[];
  const sources = (
    requireDb()
      .prepare(
        `SELECT DISTINCT source FROM hr_candidates WHERE owner_user_id = ? ORDER BY source`,
      )
      .all(ownerUserId) as Array<{ source: string }>
  ).map((row) => row.source);
  return {
    items: rows.map(mapCandidate),
    total: Number(countRow.total),
    sources,
  };
}

export function listHrCandidatesForJobs(
  ownerUserId: string,
  jobIds: string[],
): HrCandidate[] {
  if (jobIds.length === 0) return [];
  const placeholders = jobIds.map(() => '?').join(',');
  const rows = requireDb()
    .prepare(
      `SELECT * FROM hr_candidates
     WHERE owner_user_id = ? AND job_id IN (${placeholders})
     ORDER BY updated_at DESC, id DESC`,
    )
    .all(ownerUserId, ...jobIds) as any[];
  return rows.map(mapCandidate);
}

export function getHrCandidate(
  ownerUserId: string,
  candidateId: string,
): HrCandidate | undefined {
  const row = requireDb()
    .prepare('SELECT * FROM hr_candidates WHERE id = ? AND owner_user_id = ?')
    .get(candidateId, ownerUserId) as any;
  return row ? mapCandidate(row) : undefined;
}

export function createHrCandidate(
  input: Omit<
    HrCandidate,
    | 'id'
    | 'stage'
    | 'talentPool'
    | 'riskFlags'
    | 'aiStatus'
    | 'aiError'
    | 'interviewer1'
    | 'interviewer2'
    | 'interviewer3'
    | 'closedAt'
    | 'retentionExpiresAt'
    | 'createdAt'
    | 'updatedAt'
    | 'overallScoreStandard'
  > &
    Partial<
      Pick<
        HrCandidate,
        | 'fullNameSource'
        | 'stage'
        | 'talentPool'
        | 'riskFlags'
        | 'interviewer1'
        | 'interviewer2'
        | 'interviewer3'
        | 'closedAt'
        | 'retentionExpiresAt'
        | 'overallScoreStandard'
      >
    >,
): HrCandidate {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  requireDb()
    .prepare(
      `
    INSERT INTO hr_candidates (id, owner_user_id, job_id, full_name, full_name_source, email, phone, location, source,
      source_url, stage, talent_pool, years_experience, summary, recommendation, overall_score, overall_score_standard,
      risk_flags, profile, interviewer_1, interviewer_2, interviewer_3, closed_at,
      retention_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      id,
      input.ownerUserId,
      input.jobId,
      input.fullName,
      input.fullNameSource ?? 'unknown',
      input.email,
      input.phone,
      input.location,
      input.source,
      input.sourceUrl,
      input.stage ?? 'pending_tech_screen',
      input.talentPool ? 1 : 0,
      input.yearsExperience,
      input.summary,
      input.recommendation,
      input.overallScore,
      input.overallScoreStandard ?? 'legacy',
      JSON.stringify(input.riskFlags ?? []),
      input.profile ? JSON.stringify(input.profile) : null,
      input.interviewer1 ?? null,
      input.interviewer2 ?? null,
      input.interviewer3 ?? null,
      input.closedAt ?? null,
      input.retentionExpiresAt ?? null,
      now,
      now,
    );
  return getHrCandidate(input.ownerUserId, id)!;
}

export function updateHrCandidate(
  ownerUserId: string,
  candidateId: string,
  patch: Partial<
    Omit<HrCandidate, 'id' | 'ownerUserId' | 'jobId' | 'createdAt'>
  >,
): HrCandidate | undefined {
  const existing = getHrCandidate(ownerUserId, candidateId);
  if (!existing) return undefined;
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  const isClosed = [
    'closed_hired',
    'closed_rejected',
    'closed_withdrawn',
  ].includes(next.stage);
  if (isClosed && !next.closedAt) next.closedAt = next.updatedAt;
  if (!isClosed) {
    next.closedAt = null;
    next.retentionExpiresAt = null;
  }
  requireDb()
    .prepare(
      `
    UPDATE hr_candidates SET full_name = ?, email = ?, phone = ?, location = ?, stage = ?,
      full_name_source = ?, talent_pool = ?, source_url = ?, years_experience = ?, summary = ?, recommendation = ?,
      overall_score = ?, overall_score_standard = ?, risk_flags = ?, profile = ?, ai_status = ?, ai_error = ?,
      interviewer_1 = ?, interviewer_2 = ?, interviewer_3 = ?, closed_at = ?,
      retention_expires_at = ?, updated_at = ?
    WHERE id = ? AND owner_user_id = ?
  `,
    )
    .run(
      next.fullName,
      next.email,
      next.phone,
      next.location,
      next.stage,
      next.fullNameSource ?? 'unknown',
      next.talentPool ? 1 : 0,
      next.sourceUrl,
      next.yearsExperience,
      next.summary,
      next.recommendation,
      next.overallScore,
      next.overallScoreStandard ?? 'legacy',
      JSON.stringify(next.riskFlags),
      next.profile ? JSON.stringify(next.profile) : null,
      next.aiStatus,
      next.aiError,
      next.interviewer1,
      next.interviewer2,
      next.interviewer3,
      next.closedAt,
      next.retentionExpiresAt,
      next.updatedAt,
      candidateId,
      ownerUserId,
    );
  return getHrCandidate(ownerUserId, candidateId);
}

export function deleteHrCandidate(
  ownerUserId: string,
  candidateId: string,
): boolean {
  return (
    requireDb()
      .prepare('DELETE FROM hr_candidates WHERE id = ? AND owner_user_id = ?')
      .run(candidateId, ownerUserId).changes > 0
  );
}

export function hardDeleteHrCandidate(
  ownerUserId: string,
  candidateId: string,
): {
  resumes: number;
  matches: number;
  questions: number;
  rounds: number;
  analysisJobs: number;
  feishuSyncs: number;
} {
  return requireDb().transaction(() => {
    const count = (table: string) =>
      requireDb()
        .prepare(
          `SELECT COUNT(*) AS count FROM ${table} WHERE owner_user_id = ? AND candidate_id = ?`,
        )
        .get(ownerUserId, candidateId) as { count: number | string };
    const countAnalysisJobs = requireDb()
      .prepare(
        'SELECT COUNT(*) AS count FROM hr_analysis_jobs WHERE owner_user_id = ? AND target_id = ?',
      )
      .get(ownerUserId, candidateId) as { count: number | string };
    const counts = {
      resumes: Number(count('hr_resumes').count),
      matches: Number(count('hr_matches').count),
      questions: Number(count('hr_interview_questions').count),
      rounds: Number(count('hr_interview_rounds').count),
      analysisJobs: Number(countAnalysisJobs.count),
      feishuSyncs: Number(count('hr_feishu_syncs').count),
    };
    requireDb()
      .prepare(
        'DELETE FROM hr_matches WHERE owner_user_id = ? AND candidate_id = ?',
      )
      .run(ownerUserId, candidateId);
    requireDb()
      .prepare(
        'DELETE FROM hr_interview_questions WHERE owner_user_id = ? AND candidate_id = ?',
      )
      .run(ownerUserId, candidateId);
    requireDb()
      .prepare(
        'DELETE FROM hr_interview_rounds WHERE owner_user_id = ? AND candidate_id = ?',
      )
      .run(ownerUserId, candidateId);
    requireDb()
      .prepare(
        'DELETE FROM hr_analysis_jobs WHERE owner_user_id = ? AND target_id = ?',
      )
      .run(ownerUserId, candidateId);
    requireDb()
      .prepare(
        'DELETE FROM hr_feishu_syncs WHERE owner_user_id = ? AND candidate_id = ?',
      )
      .run(ownerUserId, candidateId);
    requireDb()
      .prepare(
        'DELETE FROM hr_resumes WHERE owner_user_id = ? AND candidate_id = ?',
      )
      .run(ownerUserId, candidateId);
    requireDb()
      .prepare('DELETE FROM hr_candidates WHERE owner_user_id = ? AND id = ?')
      .run(ownerUserId, candidateId);
    return counts;
  })();
}

export function createHrResume(
  input: Omit<HrResume, 'id' | 'createdAt'>,
): HrResume {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  requireDb()
    .prepare(
      `
    INSERT INTO hr_resumes (id, owner_user_id, candidate_id, job_id, file_path, file_name,
      mime_type, size_bytes, sha256, extracted_text, parser_version, parse_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      id,
      input.ownerUserId,
      input.candidateId,
      input.jobId,
      input.filePath,
      input.fileName,
      input.mimeType,
      input.sizeBytes,
      input.sha256,
      input.extractedText,
      input.parserVersion,
      input.parseStatus,
      now,
    );
  return getHrResume(input.ownerUserId, id)!;
}

export function getHrResume(
  ownerUserId: string,
  resumeId: string,
): HrResume | undefined {
  const row = requireDb()
    .prepare('SELECT * FROM hr_resumes WHERE id = ? AND owner_user_id = ?')
    .get(resumeId, ownerUserId) as any;
  return row ? mapResume(row) : undefined;
}

export function listHrResumesForCandidate(
  ownerUserId: string,
  candidateId: string,
): HrResume[] {
  const rows = requireDb()
    .prepare(
      `
    SELECT * FROM hr_resumes WHERE owner_user_id = ? AND candidate_id = ?
    ORDER BY created_at DESC
  `,
    )
    .all(ownerUserId, candidateId) as any[];
  return rows.map(mapResume);
}

export function updateHrResume(
  ownerUserId: string,
  resumeId: string,
  patch: Partial<Pick<HrResume, 'extractedText' | 'parseStatus'>>,
): HrResume | undefined {
  const existing = getHrResume(ownerUserId, resumeId);
  if (!existing) return undefined;
  requireDb()
    .prepare(
      'UPDATE hr_resumes SET extracted_text = ?, parse_status = ? WHERE id = ? AND owner_user_id = ?',
    )
    .run(
      patch.extractedText ?? existing.extractedText,
      patch.parseStatus ?? existing.parseStatus,
      resumeId,
      ownerUserId,
    );
  return getHrResume(ownerUserId, resumeId);
}

export function deleteHrResume(ownerUserId: string, resumeId: string): boolean {
  return (
    requireDb()
      .prepare('DELETE FROM hr_resumes WHERE id = ? AND owner_user_id = ?')
      .run(resumeId, ownerUserId).changes > 0
  );
}

export function createHrMatch(
  input: Omit<HrMatch, 'id' | 'createdAt'>,
): HrMatch {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  requireDb()
    .prepare(
      `
    INSERT INTO hr_matches (id, owner_user_id, job_id, candidate_id, resume_id, score, fit_level,
      dimension_scores, matched_requirements, missing_requirements, contradictions, rationale,
      model, score_standard, score_breakdown, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      id,
      input.ownerUserId,
      input.jobId,
      input.candidateId,
      input.resumeId,
      input.score,
      input.fitLevel,
      JSON.stringify(input.dimensionScores),
      JSON.stringify(input.matchedRequirements),
      JSON.stringify(input.missingRequirements),
      JSON.stringify(input.contradictions),
      input.rationale,
      input.model,
      input.scoreStandard,
      input.scoreBreakdown ? JSON.stringify(input.scoreBreakdown) : null,
      now,
    );
  return mapMatch(
    requireDb().prepare('SELECT * FROM hr_matches WHERE id = ?').get(id) as any,
  );
}

export function getLatestHrMatch(
  ownerUserId: string,
  candidateId: string,
): HrMatch | undefined {
  const row = requireDb()
    .prepare(
      `
    SELECT * FROM hr_matches WHERE owner_user_id = ? AND candidate_id = ?
    ORDER BY created_at DESC LIMIT 1
  `,
    )
    .get(ownerUserId, candidateId) as any;
  return row ? mapMatch(row) : undefined;
}

export function replaceHrQuestions(
  input: Array<Omit<HrInterviewQuestion, 'id' | 'createdAt'>>,
): HrInterviewQuestion[] {
  const database = requireDb();
  if (input.length === 0) return [];
  const now = new Date().toISOString();
  return database.transaction(() => {
    database
      .prepare(
        'DELETE FROM hr_interview_questions WHERE owner_user_id = ? AND candidate_id = ?',
      )
      .run(input[0]!.ownerUserId, input[0]!.candidateId);
    const insert = database.prepare(`
      INSERT INTO hr_interview_questions (id, owner_user_id, job_id, candidate_id, category,
        question, rationale, expected_signal, priority, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return input.map((question) => {
      const id = crypto.randomUUID();
      insert.run(
        id,
        question.ownerUserId,
        question.jobId,
        question.candidateId,
        question.category,
        question.question,
        question.rationale,
        question.expectedSignal,
        question.priority,
        question.model,
        now,
      );
      return mapQuestion(
        database
          .prepare('SELECT * FROM hr_interview_questions WHERE id = ?')
          .get(id) as any,
      );
    });
  })();
}

export function listHrQuestions(
  ownerUserId: string,
  candidateId: string,
): HrInterviewQuestion[] {
  const rows = requireDb()
    .prepare(
      `
    SELECT * FROM hr_interview_questions WHERE owner_user_id = ? AND candidate_id = ?
    ORDER BY priority ASC, created_at ASC
  `,
    )
    .all(ownerUserId, candidateId) as any[];
  return rows.map(mapQuestion);
}

export function listAllHrQuestions(ownerUserId: string): HrInterviewQuestion[] {
  const rows = requireDb()
    .prepare(
      `
    SELECT * FROM hr_interview_questions WHERE owner_user_id = ?
    ORDER BY created_at DESC LIMIT 2000
  `,
    )
    .all(ownerUserId) as any[];
  return rows.map(mapQuestion);
}

export interface HrQuestionPageFilters {
  search?: string;
  category?: string;
  limit: number;
  offset: number;
}

export function listHrQuestionsPaged(
  ownerUserId: string,
  filters: HrQuestionPageFilters,
): {
  items: Array<{
    question: HrInterviewQuestion;
    candidate: Pick<HrCandidate, 'id' | 'fullName' | 'stage'>;
    jobTitle: string;
  }>;
  total: number;
  categories: string[];
} {
  const clauses = [
    'q.owner_user_id = ?',
    'c.owner_user_id = ?',
    'j.owner_user_id = ?',
    'j.deleted_at IS NULL',
  ];
  const params: unknown[] = [ownerUserId, ownerUserId, ownerUserId];
  const search = filters.search?.trim();
  if (search) {
    clauses.push('(q.question LIKE ? OR c.full_name LIKE ?)');
    const keyword = `%${search}%`;
    params.push(keyword, keyword);
  }
  if (filters.category) {
    clauses.push('q.category = ?');
    params.push(filters.category);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const from = `
    FROM hr_interview_questions q
    INNER JOIN hr_candidates c
      ON c.id = q.candidate_id AND c.owner_user_id = q.owner_user_id
    INNER JOIN hr_jobs j
      ON j.id = q.job_id AND j.owner_user_id = q.owner_user_id
  `;
  const countRow = requireDb()
    .prepare(`SELECT COUNT(*) AS total ${from} ${where}`)
    .get(...params) as { total: number | string };
  const rows = requireDb()
    .prepare(
      `SELECT q.*, c.full_name AS candidate_full_name, c.stage AS candidate_stage,
            j.title AS job_title
     ${from} ${where}
     ORDER BY q.created_at DESC, q.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, filters.limit, filters.offset) as any[];
  const categoryParams: unknown[] = [ownerUserId, ownerUserId, ownerUserId];
  if (search) categoryParams.push(`%${search}%`, `%${search}%`);
  const categories = (
    requireDb()
      .prepare(
        `SELECT DISTINCT q.category
     ${from}
     WHERE q.owner_user_id = ? AND c.owner_user_id = ? AND j.owner_user_id = ?
       AND j.deleted_at IS NULL${search ? ' AND (q.question LIKE ? OR c.full_name LIKE ?)' : ''}
     ORDER BY q.category`,
      )
      .all(...categoryParams) as Array<{ category: string }>
  ).map((row) => row.category);
  return {
    items: rows.map((row) => ({
      question: mapQuestion(row),
      candidate: {
        id: String(row.candidate_id),
        fullName: String(row.candidate_full_name),
        stage: String(row.candidate_stage) as HrCandidate['stage'],
      },
      jobTitle: String(row.job_title),
    })),
    total: Number(countRow.total),
    categories,
  };
}

export function createHrInterviewRound(
  input: Omit<HrInterviewRound, 'id' | 'createdAt' | 'analysis' | 'model'> & {
    analysis?: Record<string, unknown> | null;
    model?: string | null;
  },
): HrInterviewRound {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  requireDb()
    .prepare(
      `
    INSERT INTO hr_interview_rounds (id, owner_user_id, job_id, candidate_id, stage, interviewer,
      scheduled_at, completed_at, outcome, feedback_text, score, analysis, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      id,
      input.ownerUserId,
      input.jobId,
      input.candidateId,
      input.stage,
      input.interviewer,
      input.scheduledAt,
      input.completedAt,
      input.outcome,
      input.feedbackText,
      input.score,
      input.analysis ? JSON.stringify(input.analysis) : null,
      input.model,
      now,
    );
  return mapRound(
    requireDb()
      .prepare('SELECT * FROM hr_interview_rounds WHERE id = ?')
      .get(id) as any,
  );
}

export function updateHrInterviewRound(
  ownerUserId: string,
  roundId: string,
  patch: Partial<
    Pick<
      HrInterviewRound,
      'score' | 'analysis' | 'model' | 'completedAt' | 'outcome'
    >
  >,
): HrInterviewRound | undefined {
  const existingRow = requireDb()
    .prepare(
      'SELECT * FROM hr_interview_rounds WHERE id = ? AND owner_user_id = ?',
    )
    .get(roundId, ownerUserId) as any;
  if (!existingRow) return undefined;
  const next = { ...mapRound(existingRow), ...patch };
  requireDb()
    .prepare(
      `
    UPDATE hr_interview_rounds SET completed_at = ?, outcome = ?, score = ?, analysis = ?, model = ?
    WHERE id = ? AND owner_user_id = ?
  `,
    )
    .run(
      next.completedAt,
      next.outcome,
      next.score,
      next.analysis ? JSON.stringify(next.analysis) : null,
      next.model,
      roundId,
      ownerUserId,
    );
  return mapRound(
    requireDb()
      .prepare('SELECT * FROM hr_interview_rounds WHERE id = ?')
      .get(roundId) as any,
  );
}

export function listHrInterviewRounds(
  ownerUserId: string,
  candidateId: string,
): HrInterviewRound[] {
  const rows = requireDb()
    .prepare(
      `
    SELECT * FROM hr_interview_rounds WHERE owner_user_id = ? AND candidate_id = ?
    ORDER BY created_at DESC
  `,
    )
    .all(ownerUserId, candidateId) as any[];
  return rows.map(mapRound);
}

export function listAllHrInterviewRounds(
  ownerUserId: string,
): HrInterviewRound[] {
  const rows = requireDb()
    .prepare(
      `
    SELECT * FROM hr_interview_rounds WHERE owner_user_id = ?
    ORDER BY created_at DESC LIMIT 2000
  `,
    )
    .all(ownerUserId) as any[];
  return rows.map(mapRound);
}

export function createHrAnalysisJob(
  input: Pick<
    HrAnalysisJob,
    'ownerUserId' | 'type' | 'targetId' | 'inputHash' | 'model'
  >,
): HrAnalysisJob {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  requireDb()
    .prepare(
      `
    INSERT INTO hr_analysis_jobs (id, owner_user_id, type, target_id, status, attempt, input_hash,
      model, created_at)
    VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
  `,
    )
    .run(
      id,
      input.ownerUserId,
      input.type,
      input.targetId,
      input.inputHash,
      input.model,
      now,
    );
  return getHrAnalysisJob(input.ownerUserId, id)!;
}

export function getHrAnalysisJob(
  ownerUserId: string,
  analysisId: string,
): HrAnalysisJob | undefined {
  const row = requireDb()
    .prepare(
      'SELECT * FROM hr_analysis_jobs WHERE id = ? AND owner_user_id = ?',
    )
    .get(analysisId, ownerUserId) as any;
  return row ? mapAnalysisJob(row) : undefined;
}

export function getLatestHrAnalysisJob(
  ownerUserId: string,
  type: HrAnalysisType,
  targetId: string,
): HrAnalysisJob | undefined {
  const row = requireDb()
    .prepare(
      `
    SELECT * FROM hr_analysis_jobs
    WHERE owner_user_id = ? AND type = ? AND target_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `,
    )
    .get(ownerUserId, type, targetId) as any;
  return row ? mapAnalysisJob(row) : undefined;
}

export function markHrAnalysisStatus(
  ownerUserId: string,
  analysisId: string,
  status: HrAnalysisStatus,
  patch: Partial<
    Pick<HrAnalysisJob, 'attempt' | 'result' | 'error' | 'model'>
  > = {},
): HrAnalysisJob | undefined {
  const existing = getHrAnalysisJob(ownerUserId, analysisId);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const result =
    patch.result === undefined
      ? existing.result === null
        ? null
        : JSON.stringify(existing.result)
      : JSON.stringify(patch.result);
  requireDb()
    .prepare(
      `
    UPDATE hr_analysis_jobs SET status = ?, attempt = ?, result = ?, error = ?, model = ?,
      started_at = ?, finished_at = ? WHERE id = ? AND owner_user_id = ?
  `,
    )
    .run(
      status,
      patch.attempt ?? existing.attempt,
      result,
      patch.error ?? existing.error,
      patch.model ?? existing.model,
      status === 'running' ? now : existing.startedAt,
      status === 'completed' || status === 'failed' ? now : existing.finishedAt,
      analysisId,
      ownerUserId,
    );
  return getHrAnalysisJob(ownerUserId, analysisId);
}

export function listHrAnalysisJobs(
  ownerUserId: string,
  candidateId?: string,
  limit = 50,
  status?: HrAnalysisStatus,
): HrAnalysisJob[] {
  const clauses = ['owner_user_id = ?'];
  const params: unknown[] = [ownerUserId];
  if (candidateId) {
    clauses.push('target_id = ?');
    params.push(candidateId);
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  params.push(limit);
  const rows = requireDb()
    .prepare(
      `
    SELECT * FROM hr_analysis_jobs WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC LIMIT ?
  `,
    )
    .all(...params) as any[];
  return rows.map(mapAnalysisJob);
}

export function listHrAnalysisJobsPaged(
  ownerUserId: string,
  filters: {
    candidateId?: string;
    status?: HrAnalysisStatus;
    limit: number;
    offset: number;
  },
): { items: HrAnalysisJob[]; total: number } {
  const clauses = ['owner_user_id = ?'];
  const params: unknown[] = [ownerUserId];
  if (filters.candidateId) {
    clauses.push('target_id = ?');
    params.push(filters.candidateId);
  }
  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const countRow = requireDb()
    .prepare(`SELECT COUNT(*) AS total FROM hr_analysis_jobs ${where}`)
    .get(...params) as { total: number | string };
  const rows = requireDb()
    .prepare(
      `SELECT * FROM hr_analysis_jobs ${where}
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, filters.limit, filters.offset) as any[];
  return { items: rows.map(mapAnalysisJob), total: Number(countRow.total) };
}

export function claimHrAnalysisJobs(
  ownerUserId: string | null,
  workerId: string,
  limit: number,
): HrAnalysisJob[] {
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  return requireDb().transaction(() => {
    const clauses = ["status IN ('queued','retrying')"];
    const params: unknown[] = [];
    if (ownerUserId) {
      clauses.push('owner_user_id = ?');
      params.push(ownerUserId);
    }
    params.push(now, limit);
    const rows = requireDb()
      .prepare(
        `
      SELECT * FROM hr_analysis_jobs
      WHERE ${clauses.join(' AND ')}
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY created_at ASC LIMIT ?
    `,
      )
      .all(...params) as any[];
    const claimed: HrAnalysisJob[] = [];
    for (const row of rows) {
      const result = requireDb()
        .prepare(
          `
        UPDATE hr_analysis_jobs SET status = 'running', locked_at = ?, locked_by = ?,
          lease_expires_at = ?, attempt = attempt + 1
        WHERE id = ? AND status IN ('queued','retrying')
      `,
        )
        .run(now, workerId, leaseExpiresAt, String(row.id));
      if (result.changes > 0) {
        const fresh = requireDb()
          .prepare('SELECT * FROM hr_analysis_jobs WHERE id = ?')
          .get(String(row.id)) as any;
        if (fresh) claimed.push(mapAnalysisJob(fresh));
      }
    }
    return claimed;
  })();
}

export function recoverHrAnalysisJobs(workerId: string): number {
  const now = new Date().toISOString();
  return requireDb()
    .prepare(
      `
    UPDATE hr_analysis_jobs SET status = 'retrying', next_retry_at = ?, locked_at = NULL,
      locked_by = NULL, lease_expires_at = NULL
    WHERE status = 'running' AND (locked_by IS NULL OR locked_by <> ?)
  `,
    )
    .run(now, workerId).changes;
}

export function updateHrAnalysisQueue(
  ownerUserId: string,
  analysisId: string,
  status: HrAnalysisStatus,
  patch: {
    error?: string | null;
    nextRetryAt?: string | null;
    result?: unknown;
    model?: string | null;
  } = {},
): HrAnalysisJob | undefined {
  const existing = getHrAnalysisJob(ownerUserId, analysisId);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  requireDb()
    .prepare(
      `
    UPDATE hr_analysis_jobs SET status = ?, error = ?, last_error = ?, next_retry_at = ?,
      result = ?, model = ?, locked_at = NULL, locked_by = NULL, lease_expires_at = NULL,
      started_at = COALESCE(started_at, CASE WHEN ? = 'running' THEN ? ELSE started_at END),
      finished_at = CASE WHEN ? IN ('completed','failed') THEN ? ELSE finished_at END
    WHERE id = ? AND owner_user_id = ?
  `,
    )
    .run(
      status,
      patch.error ?? existing.error,
      patch.error ?? existing.lastError,
      patch.nextRetryAt ?? null,
      patch.result === undefined
        ? existing.result === null
          ? null
          : JSON.stringify(existing.result)
        : JSON.stringify(patch.result),
      patch.model ?? existing.model,
      status,
      now,
      status,
      now,
      analysisId,
      ownerUserId,
    );
  return getHrAnalysisJob(ownerUserId, analysisId);
}

export function getHrFeishuConfig(
  ownerUserId: string,
): HrFeishuConfig | undefined {
  const row = requireDb()
    .prepare('SELECT * FROM hr_feishu_configs WHERE owner_user_id = ?')
    .get(ownerUserId) as any;
  return row ? mapFeishuConfig(row) : undefined;
}

export function upsertHrFeishuConfig(
  input: Omit<HrFeishuConfig, 'id' | 'createdAt' | 'updatedAt'>,
): HrFeishuConfig {
  const database = requireDb();
  const existing = getHrFeishuConfig(input.ownerUserId);
  const now = new Date().toISOString();
  const id = existing?.id ?? crypto.randomUUID();
  if (existing) {
    database
      .prepare(
        `
      UPDATE hr_feishu_configs SET channel_account_id = ?, app_token = ?, table_id = ?,
        field_mapping = ?, enabled = ?, updated_at = ? WHERE owner_user_id = ?
    `,
      )
      .run(
        input.channelAccountId,
        input.appToken,
        input.tableId,
        JSON.stringify(input.fieldMapping),
        input.enabled ? 1 : 0,
        now,
        input.ownerUserId,
      );
  } else {
    database
      .prepare(
        `
      INSERT INTO hr_feishu_configs (id, owner_user_id, channel_account_id, app_token, table_id,
        field_mapping, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.ownerUserId,
        input.channelAccountId,
        input.appToken,
        input.tableId,
        JSON.stringify(input.fieldMapping),
        input.enabled ? 1 : 0,
        now,
        now,
      );
  }
  return getHrFeishuConfig(input.ownerUserId)!;
}

export function getHrFeishuSync(
  ownerUserId: string,
  candidateId: string,
): HrFeishuSync | undefined {
  const row = requireDb()
    .prepare(
      'SELECT * FROM hr_feishu_syncs WHERE owner_user_id = ? AND candidate_id = ?',
    )
    .get(ownerUserId, candidateId) as any;
  return row ? mapFeishuSync(row) : undefined;
}

export function upsertHrFeishuSync(
  ownerUserId: string,
  candidateId: string,
  configId: string,
  patch: Partial<
    Pick<
      HrFeishuSync,
      | 'recordId'
      | 'payloadHash'
      | 'status'
      | 'attempt'
      | 'error'
      | 'lastSyncedAt'
    >
  > = {},
): HrFeishuSync {
  const database = requireDb();
  const existing = getHrFeishuSync(ownerUserId, candidateId);
  const now = new Date().toISOString();
  if (existing) {
    database
      .prepare(
        `
      UPDATE hr_feishu_syncs SET config_id = ?, record_id = ?, payload_hash = ?, status = ?,
        attempt = ?, error = ?, last_synced_at = ?, updated_at = ?
      WHERE owner_user_id = ? AND candidate_id = ?
    `,
      )
      .run(
        configId,
        patch.recordId ?? existing.recordId,
        patch.payloadHash ?? existing.payloadHash,
        patch.status ?? existing.status,
        patch.attempt ?? existing.attempt,
        patch.error ?? null,
        patch.lastSyncedAt ?? existing.lastSyncedAt,
        now,
        ownerUserId,
        candidateId,
      );
  } else {
    database
      .prepare(
        `
      INSERT INTO hr_feishu_syncs (id, owner_user_id, candidate_id, config_id, record_id,
        payload_hash, status, attempt, error, last_synced_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        crypto.randomUUID(),
        ownerUserId,
        candidateId,
        configId,
        patch.recordId ?? null,
        patch.payloadHash ?? null,
        patch.status ?? 'pending',
        patch.attempt ?? 0,
        patch.error ?? null,
        patch.lastSyncedAt ?? null,
        now,
        now,
      );
  }
  return getHrFeishuSync(ownerUserId, candidateId)!;
}

export function createHrAudit(
  input: Omit<HrAuditLog, 'id' | 'createdAt'>,
): void {
  requireDb()
    .prepare(
      `
    INSERT INTO hr_audit_log (id, owner_user_id, actor_id, action, target_type, target_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      crypto.randomUUID(),
      input.ownerUserId,
      input.actorId,
      input.action,
      input.targetType,
      input.targetId,
      input.detail ? JSON.stringify(input.detail) : null,
      new Date().toISOString(),
    );
}

export function listHrAuditByActions(
  ownerUserId: string,
  actions: string[],
  limit = 20,
): Array<{
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  detail: string | null;
  createdAt: string;
}> {
  const safeActions = [...new Set(actions.filter(Boolean))];
  if (safeActions.length === 0) return [];
  const placeholders = safeActions.map(() => '?').join(', ');
  const rows = requireDb()
    .prepare(
      `
    SELECT id, action, target_type, target_id, detail, created_at
    FROM hr_audit_log
    WHERE owner_user_id = ? AND action IN (${placeholders})
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `,
    )
    .all(
      ownerUserId,
      ...safeActions,
      Math.min(Math.max(limit, 1), 100),
    ) as any[];
  return rows.map((row) => ({
    id: String(row.id),
    action: String(row.action),
    targetType: String(row.target_type),
    targetId: nullableText(row.target_id),
    detail: nullableText(row.detail),
    createdAt: String(row.created_at),
  }));
}

export function createHrJobRule(
  input: Omit<HrJobRule, 'id' | 'ruleVersion' | 'createdAt' | 'reviewedAt'>,
): HrJobRule {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const version = requireDb()
    .prepare(
      'SELECT COALESCE(MAX(rule_version), 0) + 1 AS next FROM hr_job_rules WHERE owner_user_id = ? AND job_id = ?',
    )
    .get(input.ownerUserId, input.jobId) as { next: number };
  requireDb()
    .prepare(
      `
    INSERT INTO hr_job_rules (id, owner_user_id, job_id, rule_version, status, source_round_id,
      summary, new_requirements, jd_gaps, contradictions, decision_suggestion, model,
      created_at, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      id,
      input.ownerUserId,
      input.jobId,
      version.next,
      input.status,
      input.sourceRoundId,
      input.summary,
      JSON.stringify(input.newRequirements),
      JSON.stringify(input.jdGaps),
      JSON.stringify(input.contradictions),
      input.decisionSuggestion,
      input.model,
      now,
      null,
    );
  return getHrJobRule(input.ownerUserId, id)!;
}

export function getHrJobRule(
  ownerUserId: string,
  ruleId: string,
): HrJobRule | undefined {
  const row = requireDb()
    .prepare('SELECT * FROM hr_job_rules WHERE id = ? AND owner_user_id = ?')
    .get(ruleId, ownerUserId) as any;
  return row ? mapJobRule(row) : undefined;
}

export function listHrJobRules(
  ownerUserId: string,
  jobId: string,
): HrJobRule[] {
  const rows = requireDb()
    .prepare(
      `
    SELECT * FROM hr_job_rules WHERE owner_user_id = ? AND job_id = ?
    ORDER BY rule_version DESC
  `,
    )
    .all(ownerUserId, jobId) as any[];
  return rows.map(mapJobRule);
}

export function getActiveHrJobRule(
  ownerUserId: string,
  jobId: string,
): HrJobRule | undefined {
  const row = requireDb()
    .prepare(
      `
    SELECT * FROM hr_job_rules WHERE owner_user_id = ? AND job_id = ? AND status = 'active'
    ORDER BY rule_version DESC LIMIT 1
  `,
    )
    .get(ownerUserId, jobId) as any;
  return row ? mapJobRule(row) : undefined;
}

export function setHrJobRuleStatus(
  ownerUserId: string,
  ruleId: string,
  status: HrJobRuleStatus,
): HrJobRule | undefined {
  const existing = getHrJobRule(ownerUserId, ruleId);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  return requireDb().transaction(() => {
    if (status === 'active') {
      requireDb()
        .prepare(
          `
        UPDATE hr_job_rules SET status = 'archived', reviewed_at = ?
        WHERE owner_user_id = ? AND job_id = ? AND status = 'active' AND id <> ?
      `,
        )
        .run(now, ownerUserId, existing.jobId, ruleId);
    }
    requireDb()
      .prepare(
        `
      UPDATE hr_job_rules SET status = ?, reviewed_at = ? WHERE id = ? AND owner_user_id = ?
    `,
      )
      .run(status, now, ruleId, ownerUserId);
    return getHrJobRule(ownerUserId, ruleId)!;
  })();
}

export function archiveHrJobRulesForJob(
  ownerUserId: string,
  jobId: string,
): void {
  requireDb()
    .prepare(
      `
    UPDATE hr_job_rules SET status = 'archived', reviewed_at = ?
    WHERE owner_user_id = ? AND job_id = ? AND status IN ('draft', 'active')
  `,
    )
    .run(new Date().toISOString(), ownerUserId, jobId);
}

export function listLatestHrFeishuSync(
  ownerUserId: string,
): HrFeishuSync | undefined {
  const row = requireDb()
    .prepare(
      `
    SELECT * FROM hr_feishu_syncs WHERE owner_user_id = ?
    ORDER BY updated_at DESC LIMIT 1
  `,
    )
    .get(ownerUserId) as any;
  return row ? mapFeishuSync(row) : undefined;
}
