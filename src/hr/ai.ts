import { z } from 'zod';
import { sdkQuery } from '../sdk-query.js';
import {
  HR_MOCK_MODEL_ENV,
  hrMockModelEnabled,
  mockFeedbackResult,
  mockJobQualityResult,
  mockMarketResult,
  mockMatchResult,
  mockQuestionsResult,
  mockResumeResult,
} from './mock-output.js';

export { HR_MOCK_MODEL_ENV, hrMockModelEnabled };
import type {
  HrCandidate,
  HrInterviewRound,
  HrJob,
  HrJobRule,
  HrResume,
} from './types.js';
import type { ResumeScoreAssessment } from './resume-scoring.js';

function stringList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  if (typeof value === 'string')
    return value
      .split(/[,;、\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  return [];
}

function structuredList(
  value: unknown,
  maxItems: number,
): Record<string, unknown>[] {
  const items = Array.isArray(value)
    ? value
    : value === null || value === undefined
      ? []
      : [value];
  return items
    .map((item): Record<string, unknown> | null => {
      if (item === null || item === undefined) return null;
      if (typeof item === 'object') return item as Record<string, unknown>;
      const text = String(item).trim();
      return text ? { detail: text.slice(0, 2000) } : null;
    })
    .filter((item): item is Record<string, unknown> => item !== null)
    .slice(0, maxItems);
}

function dimensionScoreMap(value: unknown): Record<string, number> {
  const entries = Array.isArray(value)
    ? value.map((item) => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Record<string, unknown>;
        const name = String(
          record.name ??
            record.dimension ??
            record.category ??
            record.label ??
            '',
        ).trim();
        return name ? [name.slice(0, 120), record.score ?? record.value] : null;
      })
    : value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>)
      : [];
  return Object.fromEntries(
    entries
      .filter((entry): entry is [string, unknown] => entry !== null)
      .map(([name, score]) => [name, scoreNumber(score)]),
  );
}

function decisionSuggestion(
  value: unknown,
): 'advance' | 'reject' | 'hold' | 'review' {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (/advance|推[进面]|进入下一轮|通过/.test(text)) return 'advance';
  if (/reject|淘汰|拒绝|不通过|不建议/.test(text)) return 'reject';
  if (/hold|暂缓|待定/.test(text)) return 'hold';
  return 'review';
}

function priorityNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(5, Math.max(1, Math.round(parsed)));
}

function questionList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const nested = record.questions ?? record.items ?? record.data;
    return Array.isArray(nested) ? nested : [];
  }
  return [];
}

function scoreNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

function nullableText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function nonEmptyText(
  value: unknown,
  maxLength: number,
  fallback: string,
): string {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, maxLength);
}

export const ResumeSchema = z.object({
  full_name: z.preprocess(
    (value) => String(value ?? '').trim() || '未命名候选人',
    z.string().max(200),
  ),
  email: z.preprocess(
    (value) => nullableText(value, 254),
    z.string().max(254).nullable(),
  ),
  phone: z.preprocess(
    (value) => nullableText(value, 40),
    z.string().max(40).nullable(),
  ),
  location: z.preprocess(
    (value) => nullableText(value, 200),
    z.string().max(200).nullable(),
  ),
  years_experience: z.preprocess(
    (value) =>
      value === null || value === undefined || value === ''
        ? null
        : scoreNumber(value, 0),
    z.number().min(0).max(60).nullable(),
  ),
  summary: z.preprocess(
    (value) => String(value ?? '').trim(),
    z.string().max(3000),
  ),
  skills: z.preprocess(
    (value) => stringList(value).slice(0, 100),
    z.array(z.string().max(120)),
  ),
  education: z.preprocess(
    (value) => structuredList(value, 30),
    z.array(z.record(z.string(), z.unknown())).max(30),
  ),
  experiences: z.preprocess(
    (value) => structuredList(value, 50),
    z.array(z.record(z.string(), z.unknown())).max(50),
  ),
  certifications: z.preprocess(
    (value) => structuredList(value, 50),
    z.array(z.record(z.string(), z.unknown())).max(50),
  ),
  risk_flags: z.preprocess(
    (value) => stringList(value).slice(0, 30),
    z.array(z.string().max(300)),
  ),
});

export const MatchSchema = z.object({
  score: z.preprocess(
    (value) => scoreNumber(value),
    z.number().min(0).max(100),
  ),
  fit_level: z.preprocess(
    (value) => {
      const text = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
      if (['strong_fit', 'strong'].includes(text)) return 'strong_fit';
      if (['fit', 'qualified', 'recommended'].includes(text)) return 'fit';
      if (['borderline', 'maybe', 'review'].includes(text)) return 'borderline';
      return 'not_fit';
    },
    z.enum(['strong_fit', 'fit', 'borderline', 'not_fit']),
  ),
  dimension_scores: z.preprocess(
    (value) => dimensionScoreMap(value),
    z.record(
      z.string(),
      z.preprocess((value) => scoreNumber(value), z.number().min(0).max(100)),
    ),
  ),
  matched_requirements: z.preprocess(
    (value) => {
      if (!Array.isArray(value)) return [];
      return value
        .map((item) => {
          if (typeof item === 'string')
            return { requirement: item, evidence: item };
          const record = (item ?? {}) as Record<string, unknown>;
          return {
            requirement: String(record.requirement ?? record.name ?? '').trim(),
            evidence: String(
              record.evidence ?? record.detail ?? record.reason ?? '',
            ).trim(),
          };
        })
        .filter((item) => item.requirement)
        .slice(0, 50)
        .map((item) => ({
          requirement: item.requirement.slice(0, 500),
          evidence: (item.evidence || item.requirement).slice(0, 1000),
        }));
    },
    z.array(
      z.object({
        requirement: z.string().min(1).max(500),
        evidence: z.string().min(1).max(1000),
      }),
    ),
  ),
  missing_requirements: z.preprocess(
    (value) => stringList(value).slice(0, 50),
    z.array(z.string().max(500)),
  ),
  contradictions: z.preprocess(
    (value) => stringList(value).slice(0, 30),
    z.array(z.string().max(500)),
  ),
  rationale: z.preprocess(
    (value) => nonEmptyText(value, 4000, '未提供匹配理由'),
    z.string().max(4000),
  ),
});

const RequirementStatusSchema = z.preprocess(
  (value) => {
    const text = String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    if (['met', 'match', 'matched', 'full'].includes(text)) return 'met';
    if (['partial', 'partially_met', 'weak'].includes(text)) return 'partial';
    if (['contradiction', 'contradicts', 'conflict'].includes(text)) {
      return 'contradiction';
    }
    return 'not_evident';
  },
  z.enum(['met', 'partial', 'not_evident', 'contradiction']),
);

const RiskTypeSchema = z.preprocess(
  (value) => {
    const text = String(value ?? '')
      .trim()
      .toLowerCase();
    if (/fabricat|编造|伪造/.test(text)) return 'fabrication';
    if (/contradict|矛盾|冲突/.test(text)) return 'contradiction';
    return 'other';
  },
  z.enum(['contradiction', 'fabrication', 'other']),
);

function requirementAssessments(value: unknown, maxItems: number) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') {
        return {
          requirement: item,
          status: 'not_evident',
          critical: true,
          evidence: '',
        };
      }
      const record = (item ?? {}) as Record<string, unknown>;
      return {
        requirement: String(record.requirement ?? record.name ?? '').trim(),
        status: record.status,
        critical:
          record.critical === undefined
            ? true
            : record.critical === true ||
              /^(true|1|yes|core|核心)$/i.test(String(record.critical)),
        evidence: String(record.evidence ?? record.detail ?? '').trim(),
      };
    })
    .filter((item) => item.requirement)
    .slice(0, maxItems)
    .map((item) => ({
      requirement: item.requirement.slice(0, 500),
      status: RequirementStatusSchema.parse(item.status),
      critical: item.critical,
      evidence: (item.evidence || item.requirement).slice(0, 1000),
    }));
}

export const ResumeScoreAssessmentSchema = z.object({
  must_have_requirements: z.preprocess(
    (value) => requirementAssessments(value, 15),
    z
      .array(
        z.object({
          requirement: z.string().min(1).max(500),
          status: RequirementStatusSchema,
          critical: z.boolean(),
          evidence: z.string().max(1000),
        }),
      )
      .min(1),
  ),
  preferred_requirements: z.preprocess(
    (value) => requirementAssessments(value, 15),
    z.array(
      z.object({
        requirement: z.string().min(1).max(500),
        status: RequirementStatusSchema,
        critical: z.boolean(),
        evidence: z.string().max(1000),
      }),
    ),
  ),
  project_fit: z.object({
    role_domain_similarity: z.preprocess(
      (value) => scoreNumber(value),
      z.number().min(0).max(100),
    ),
    scenario_match: z.preprocess(
      (value) => scoreNumber(value),
      z.number().min(0).max(100),
    ),
    complexity_scale: z.preprocess(
      (value) => scoreNumber(value),
      z.number().min(0).max(100),
    ),
    outcome_impact: z.preprocess(
      (value) => scoreNumber(value),
      z.number().min(0).max(100),
    ),
  }),
  evidence_quality: z.object({
    specific_technology: z.preprocess(
      (value) => scoreNumber(value),
      z.number().min(0).max(100),
    ),
    measurable_results: z.preprocess(
      (value) => scoreNumber(value),
      z.number().min(0).max(100),
    ),
    traceability: z.preprocess(
      (value) => scoreNumber(value),
      z.number().min(0).max(100),
    ),
  }),
  risks: z.preprocess(
    (value) => {
      if (!Array.isArray(value)) return [];
      return value
        .map((item) => {
          if (typeof item === 'string') {
            return { type: 'contradiction', description: item };
          }
          const record = (item ?? {}) as Record<string, unknown>;
          return {
            type: record.type,
            description: String(
              record.description ?? record.detail ?? record.reason ?? '',
            ).trim(),
          };
        })
        .filter((item) => item.description)
        .slice(0, 15)
        .map((item) => ({
          type: RiskTypeSchema.parse(item.type),
          description: item.description.slice(0, 600),
        }));
    },
    z.array(
      z.object({
        type: z.enum(['contradiction', 'fabrication', 'other']),
        description: z.string().min(1).max(600),
      }),
    ),
  ),
  rationale: z.preprocess(
    (value) => nonEmptyText(value, 4000, '未提供匹配理由'),
    z.string().max(4000),
  ),
});

export const QuestionsSchema = z.object({
  questions: z.preprocess(
    (value) => questionList(value),
    z
      .array(
        z.object({
          category: z.string().min(1).max(80),
          question: z.string().min(1).max(1000),
          rationale: z.string().min(1).max(1000),
          expected_signal: z.string().min(1).max(1000),
          priority: z.preprocess(
            (value) => priorityNumber(value),
            z.number().int().min(1).max(5),
          ),
        }),
      )
      .min(1)
      .max(12),
  ),
});

export const FeedbackSchema = z.object({
  summary: z.preprocess(
    (value) => nonEmptyText(value, 3000, '未提供面试反馈摘要'),
    z.string().max(3000),
  ),
  score: z.preprocess(
    (value) => scoreNumber(value),
    z.number().min(0).max(100),
  ),
  updated_recommendation: z.preprocess(
    (value) => nonEmptyText(value, 200, '维持当前推面建议'),
    z.string().min(1).max(200),
  ),
  new_requirements: z.preprocess(
    (value) => stringList(value).slice(0, 30),
    z.array(z.string().max(500)),
  ),
  jd_gaps: z.preprocess(
    (value) => stringList(value).slice(0, 30),
    z.array(z.string().max(500)),
  ),
  contradictions: z.preprocess(
    (value) => stringList(value).slice(0, 30),
    z.array(z.string().max(500)),
  ),
  decision_suggestion: z.preprocess(
    (value) => decisionSuggestion(value),
    z.enum(['advance', 'reject', 'hold', 'review']),
  ),
});

const JobQualitySchema = z.object({
  quality_score: z.preprocess(
    (value) => scoreNumber(value),
    z.number().min(0).max(100),
  ),
  summary: z.preprocess(
    (value) => nonEmptyText(value, 4000, '暂无 JD 质量分析摘要'),
    z.string().max(4000),
  ),
  strengths: z.preprocess(
    (value) => stringList(value).slice(0, 15),
    z.array(z.string().max(600)),
  ),
  ambiguities: z.preprocess(
    (value) => stringList(value).slice(0, 15),
    z.array(z.string().max(600)),
  ),
  missing_requirements: z.preprocess(
    (value) => stringList(value).slice(0, 15),
    z.array(z.string().max(600)),
  ),
  risks: z.preprocess(
    (value) => stringList(value).slice(0, 15),
    z.array(z.string().max(600)),
  ),
  improvements: z.preprocess(
    (value) => stringList(value).slice(0, 15),
    z.array(z.string().max(600)),
  ),
});

const MarketSchema = z.object({
  summary: z.preprocess(
    (value) => nonEmptyText(value, 4000, '暂无可用的岗位诊断摘要'),
    z.string().max(4000),
  ),
  insights: z.preprocess(
    (value) => stringList(value).slice(0, 20),
    z.array(z.string().max(800)),
  ),
  risks: z.preprocess(
    (value) => stringList(value).slice(0, 20),
    z.array(z.string().max(800)),
  ),
  recommendations: z.preprocess(
    (value) => stringList(value).slice(0, 20),
    z.array(z.string().max(800)),
  ),
});

function mockParsed<T>(value: T, schema: z.ZodType<T>, step: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HrAnalysisError(
      `${step} mock schema failed: ${formatSchemaIssues(result.error)}`,
      { cause: result.error },
    );
  }
  return result.data;
}

export type ResumeParseResult = z.infer<typeof ResumeSchema>;
export type MatchResult = z.infer<typeof MatchSchema>;
export type ResumeScoreAssessmentResult = z.infer<
  typeof ResumeScoreAssessmentSchema
>;
export type QuestionsResult = z.infer<typeof QuestionsSchema>;
export type FeedbackResult = z.infer<typeof FeedbackSchema>;
export type JobQualityResult = z.infer<typeof JobQualitySchema>;
export type MarketResult = z.infer<typeof MarketSchema>;

export class HrAnalysisError extends Error {}

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] ?? text;
  const start = source.indexOf('{');
  if (start < 0)
    throw new HrAnalysisError('Model did not return a JSON object');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(source.slice(start, index + 1));
      }
    }
  }
  throw new HrAnalysisError('Model returned incomplete JSON');
}

export function formatSchemaIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
    .join('; ');
}

function parseModelJson<T>(
  text: string | null,
  schema: z.ZodType<T>,
  step: string,
): T {
  if (!text?.trim())
    throw new HrAnalysisError('Model returned an empty result');
  let parsed: unknown;
  try {
    parsed = extractJsonObject(text);
  } catch (error) {
    if (error instanceof HrAnalysisError) throw error;
    throw new HrAnalysisError('Model returned invalid JSON', { cause: error });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new HrAnalysisError(
      `${step} schema failed: ${formatSchemaIssues(result.error)}`,
      {
        cause: result.error,
      },
    );
  }
  return result.data;
}

async function queryModelJson<T>(
  prompt: string,
  schema: z.ZodType<T>,
  step: string,
  model?: string,
): Promise<T> {
  const text = await queryModel(prompt, model);
  try {
    return parseModelJson(text, schema, step);
  } catch (error) {
    if (
      !(error instanceof HrAnalysisError) ||
      error.message !== 'Model returned incomplete JSON'
    ) {
      throw error;
    }
    const compactRetryPrompt = `${prompt}

上一次输出被截断。请重新输出同一个JSON对象，但使用最紧凑的表达：省略示例、不要展开原文、
每个字符串不超过指定上限、列表只保留最重要的项。仍然只输出一个JSON对象，不要Markdown、
不要解释、不要代码块。`;
    return parseModelJson(
      await queryModel(compactRetryPrompt, model),
      schema,
      step,
    );
  }
}

function candidateBlock(candidate: HrCandidate): string {
  return JSON.stringify({
    full_name: candidate.fullName,
    current_summary: candidate.summary,
    profile: candidate.profile,
    years_experience: candidate.yearsExperience,
  });
}

function jobBlock(job: HrJob): string {
  return JSON.stringify({
    title: job.title,
    level: job.level,
    salary_range: job.salaryRange,
    jd_text: job.jdText,
    keywords: job.keywords,
    responsibilities: job.responsibilities,
    requirements: job.requirements,
    preferred: job.preferred,
    tech_stack: job.techStack,
  });
}

async function queryModel(
  prompt: string,
  model?: string,
): Promise<string | null> {
  try {
    return await sdkQuery(prompt, { model, timeout: 120_000 });
  } catch (error) {
    throw new HrAnalysisError('AI model request failed', { cause: error });
  }
}

export async function analyzeResume(
  job: HrJob,
  resume: HrResume,
  model?: string,
): Promise<ResumeParseResult> {
  if (hrMockModelEnabled()) {
    return mockParsed(
      mockResumeResult(job, resume),
      ResumeSchema,
      'resume_parse',
    );
  }
  const prompt = `你是严格的HR简历解析器。只输出一个JSON对象，不要Markdown。禁止编造简历中没有的信息；不确定字段用null。
岗位名称：${job.title}
简历内容：
${resume.extractedText ?? ''}
JSON字段必须只有一层对象：full_name,email,phone,location,years_experience,summary,skills,education,experiences,certifications,risk_flags。education和experiences必须是数组；skills、risk_flags必须是字符串数组；所有字段都不能省略。
summary不超过400字；skills最多30项；education、experiences、certifications最多20项；每个对象字段值不超过300字。`;
  return queryModelJson(prompt, ResumeSchema, 'resume_parse', model);
}

export async function analyzeMatch(
  job: HrJob,
  candidate: HrCandidate,
  resume: HrResume,
  model?: string,
  activeRule?: HrJobRule | null,
): Promise<ResumeScoreAssessmentResult> {
  if (hrMockModelEnabled()) {
    const legacy = mockParsed(
      mockMatchResult(job, candidate, resume),
      MatchSchema,
      'jd_match',
    );
    return mockParsed(
      {
        must_have_requirements: [
          ...legacy.matched_requirements.map((item) => ({
            requirement: item.requirement,
            status: 'met' as const,
            critical: true,
            evidence: item.evidence,
          })),
          ...legacy.missing_requirements.map((item) => ({
            requirement: item,
            status: 'not_evident' as const,
            critical: true,
            evidence: '',
          })),
        ],
        preferred_requirements: [],
        project_fit: {
          role_domain_similarity:
            legacy.dimension_scores['技术匹配'] ?? legacy.score,
          scenario_match: legacy.dimension_scores['经验匹配'] ?? legacy.score,
          complexity_scale: legacy.dimension_scores['经验匹配'] ?? legacy.score,
          outcome_impact: legacy.dimension_scores['沟通协作'] ?? legacy.score,
        },
        evidence_quality: {
          specific_technology: legacy.score,
          measurable_results: Math.max(0, legacy.score - 10),
          traceability: legacy.score,
        },
        risks: legacy.contradictions.map((item) => ({
          type: 'contradiction' as const,
          description: item,
        })),
        rationale: legacy.rationale,
      },
      ResumeScoreAssessmentSchema,
      'jd_match',
    );
  }
  const prompt = `你是技术招聘评估器。以JD为主、简历为唯一证据进行结构化评估，不要编造。不要输出总分；总分由系统公式计算。已审核的岗位规则只能作为辅助校准，不能覆盖JD原始要求。输出JSON对象。
JD：${jobBlock(job)}
候选人：${candidateBlock(candidate)}
简历：${resume.extractedText ?? ''}
${activeRule ? `已审核岗位规则：${JSON.stringify(activeRule)}` : ''}
JSON字段必须只有一层对象：must_have_requirements:[{requirement,status(met|partial|not_evident|contradiction),critical,evidence}],preferred_requirements:[同前]，project_fit:{role_domain_similarity,scenario_match,complexity_scale,outcome_impact}，evidence_quality:{specific_technology,measurable_results,traceability}，risks:[{type(contradiction|fabrication|other),description}]，rationale。
must_have_requirements必须包含至少1条JD硬性要求；每个0-100子项必须给出独立评分。critical=true表示缺失会阻断岗位胜任；critical=false表示可通过学习或团队补足。证据必须来自简历原文；简历未展开时用not_evident，不要推断为met。
rationale必须覆盖主要匹配证据、关键能力缺口和矛盾点；禁止省略号和截断式概括。数组最多15项；requirement/evidence不超过200字；rationale不超过800字。`;
  return queryModelJson(prompt, ResumeScoreAssessmentSchema, 'jd_match', model);
}

export async function generateQuestions(
  job: HrJob,
  candidate: HrCandidate,
  match: MatchResult,
  model?: string,
): Promise<QuestionsResult> {
  if (hrMockModelEnabled()) {
    return mockParsed(
      mockQuestionsResult(job, candidate, match),
      QuestionsSchema,
      'interview_questions',
    );
  }
  const prompt = `你是HR面试问题生成器。基于JD、简历与匹配缺口，生成5-8个HR初面问题，用于验证真实性和技术适配度。输出JSON对象。
JD：${jobBlock(job)}
候选人：${candidateBlock(candidate)}
匹配结论：${JSON.stringify(match)}
JSON字段必须只有一层对象：questions:[{category,question,rationale,expected_signal,priority(1-5)}]。questions数组必须存在且至少有一项。
questions最多8项；每个字符串字段不超过300字。`;
  return queryModelJson(prompt, QuestionsSchema, 'interview_questions', model);
}

function temporaryResumeAssessment(
  jdText: string,
  resumeText: string,
): ResumeScoreAssessmentResult {
  const requirements = jdText
    .split(/[\n。；;]|要求[:：]/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4 && item.length <= 120)
    .slice(0, 8);
  const haystack = resumeText.toLowerCase();
  return {
    must_have_requirements: (requirements.length
      ? requirements
      : [jdText.slice(0, 120)]
    ).map((requirement) => ({
      requirement,
      status: haystack.includes(requirement.slice(0, 12).toLowerCase())
        ? ('met' as const)
        : ('not_evident' as const),
      critical: true,
      evidence: haystack.includes(requirement.slice(0, 12).toLowerCase())
        ? requirement
        : '',
    })),
    preferred_requirements: [],
    project_fit: {
      role_domain_similarity: haystack ? 60 : 0,
      scenario_match: haystack ? 55 : 0,
      complexity_scale: haystack ? 50 : 0,
      outcome_impact: haystack ? 45 : 0,
    },
    evidence_quality: {
      specific_technology: haystack ? 55 : 0,
      measurable_results: haystack ? 45 : 0,
      traceability: haystack ? 65 : 0,
    },
    risks: [],
    rationale: 'Mock临时分析：按JD关键词和简历文本生成演示评估，不落库。',
  };
}

export async function analyzeResumePreview(
  jdText: string,
  resumeText: string,
  model?: string,
): Promise<ResumeScoreAssessmentResult> {
  if (hrMockModelEnabled()) {
    return mockParsed(
      temporaryResumeAssessment(jdText, resumeText),
      ResumeScoreAssessmentSchema,
      'resume_preview',
    );
  }
  const prompt = `你是技术招聘评估器。以下是用户临时提供的简历和JD，可能不属于岗位库。以JD为主、简历为唯一证据进行结构化评估，不要编造。不要输出总分；总分由系统公式计算。不要返回联系方式。输出JSON对象。
JD：
${jdText.slice(0, 60000)}
简历：
${resumeText}
JSON字段必须只有一层对象：must_have_requirements:[{requirement,status(met|partial|not_evident|contradiction),critical,evidence}],preferred_requirements:[同前]，project_fit:{role_domain_similarity,scenario_match,complexity_scale,outcome_impact}，evidence_quality:{specific_technology,measurable_results,traceability}，risks:[{type(contradiction|fabrication|other),description}]，rationale。
must_have_requirements必须包含至少1条JD硬性要求；每个0-100子项必须给出独立评分。critical=true表示缺失会阻断岗位胜任；critical=false表示可通过学习或团队补足。证据必须来自简历原文；简历未展开时用not_evident，不要推断为met。数组最多15项；requirement/evidence不超过200字；rationale不超过800字。`;
  return queryModelJson(
    prompt,
    ResumeScoreAssessmentSchema,
    'resume_preview',
    model,
  );
}

export async function analyzeFeedback(
  job: HrJob,
  candidate: HrCandidate,
  round: HrInterviewRound,
  model?: string,
): Promise<FeedbackResult> {
  if (hrMockModelEnabled()) {
    return mockParsed(
      mockFeedbackResult(job, round),
      FeedbackSchema,
      'feedback_analysis',
    );
  }
  const prompt = `你是招聘流程分析器。以JD为主、面试反馈为辅，识别JD未覆盖但被面试官考察的职责、反馈矛盾、通过/拒绝依据。不要编造。输出JSON对象。
JD：${jobBlock(job)}
候选人：${candidateBlock(candidate)}
面试反馈：${JSON.stringify(round)}
JSON字段必须只有一层对象：summary,score(0-100),updated_recommendation,new_requirements,jd_gaps,contradictions,decision_suggestion(advance|reject|hold|review)。所有数组字段都必须存在。
summary不超过800字；三个数组各最多20项；每项不超过300字。`;
  return queryModelJson(prompt, FeedbackSchema, 'feedback_analysis', model);
}

export async function analyzeJobQuality(
  job: HrJob,
  model?: string,
): Promise<JobQualityResult> {
  if (hrMockModelEnabled()) {
    return mockParsed(
      mockJobQualityResult(job),
      JobQualitySchema,
      'jd_quality_analysis',
    );
  }
  const prompt = `你是技术岗位JD质量审查助手。只审查给定的岗位JD和结构化字段，不访问外部市场，不假设候选人。输出JSON对象。
岗位：${jobBlock(job)}
JSON字段必须只有一层对象：quality_score(0-100),summary,strengths,ambiguities,missing_requirements,risks,improvements。所有数组字段都必须存在。
summary不超过1200字；五个数组各最多15项；每项不超过600字。结论必须可直接用于HR修改JD，禁止编造候选人或市场数据。`;
  return queryModelJson(prompt, JobQualitySchema, 'jd_quality_analysis', model);
}

export async function analyzeMarket(
  job: HrJob,
  candidates: HrCandidate[],
  rounds: HrInterviewRound[],
  model?: string,
): Promise<MarketResult> {
  if (hrMockModelEnabled()) {
    return mockParsed(
      mockMarketResult(job, candidates, rounds),
      MarketSchema,
      'job_market_analysis',
    );
  }
  const prompt = `你是招聘市场与漏斗诊断助手。只使用给定的内部招聘数据，不访问外部行情。输出JSON对象。
岗位：${jobBlock(job)}
候选人：${JSON.stringify(candidates.map((item) => ({ stage: item.stage, score: item.overallScore, recommendation: item.recommendation })))}
面试轮次：${JSON.stringify(rounds.map((item) => ({ stage: item.stage, outcome: item.outcome, score: item.score, analysis: item.analysis })))}
JSON字段必须只有一层对象：summary,insights,risks,recommendations。所有数组字段都必须存在。
summary不超过1200字；数组各最多10项；每项不超过300字。`;
  return queryModelJson(prompt, MarketSchema, 'job_market_analysis', model);
}
