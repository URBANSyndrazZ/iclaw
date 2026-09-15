import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { HR_MODEL_ENV, modelRef } from '../src/hr/analysis-service.js';
import {
  analyzeResume,
  FeedbackSchema,
  formatSchemaIssues,
  MatchSchema,
  QuestionsSchema,
  ResumeSchema,
} from '../src/hr/ai.js';
import { sdkQuery } from '../src/sdk-query.js';

vi.mock('../src/sdk-query.js', () => ({
  sdkQuery: vi.fn(),
}));

describe('HR model schema compatibility', () => {
  test('retries once with a compact prompt when model JSON is truncated', async () => {
    vi.mocked(sdkQuery)
      .mockResolvedValueOnce('{"full_name":"Ada","summary":"Go engineer')
      .mockResolvedValueOnce(
        '{"full_name":"Ada","email":null,"phone":null,"location":null,"years_experience":4,"summary":"Go engineer","skills":["Go"],"education":[],"experiences":[],"certifications":[],"risk_flags":[]}',
      );

    const result = await analyzeResume(
      {
        title: 'Golang Engineer',
      } as Parameters<typeof analyzeResume>[0],
      {
        extractedText: 'Go API engineer',
      } as Parameters<typeof analyzeResume>[1],
    );

    expect(result.full_name).toBe('Ada');
    expect(sdkQuery).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sdkQuery).mock.calls[1]?.[0]).toContain(
      '上一次输出被截断',
    );
  });

  test('accepts loose model resumes and matches', () => {
    const resume = ResumeSchema.safeParse({
      full_name: 'Ada',
      email: '',
      phone: '',
      location: '',
      years_experience: '4',
      summary: '',
      skills: 'Go, PostgreSQL',
      education: '本科 | 计算机科学与技术',
      experiences: { title: 'Go Engineer', company: 'Example' },
      certifications: null,
      risk_flags: null,
    });
    expect(resume.success).toBe(true);
    if (resume.success) {
      expect(resume.data.email).toBeNull();
      expect(resume.data.years_experience).toBe(4);
      expect(resume.data.skills).toEqual(['Go', 'PostgreSQL']);
      expect(resume.data.education).toEqual([
        { detail: '本科 | 计算机科学与技术' },
      ]);
      expect(resume.data.experiences).toEqual([
        { title: 'Go Engineer', company: 'Example' },
      ]);
    }
    const match = MatchSchema.safeParse({
      score: '82',
      fit_level: 'fit',
      dimension_scores: [{ dimension: '技术匹配', score: '82' }],
      matched_requirements: [],
      missing_requirements: null,
      contradictions: null,
      rationale: '',
    });
    expect(match.success).toBe(true);
    if (match.success) {
      expect(match.data.score).toBe(82);
      expect(match.data.dimension_scores).toEqual({ 技术匹配: 82 });
      expect(match.data.missing_requirements).toEqual([]);
    }
  });

  test('accepts wrapped questions and Chinese feedback decisions', () => {
    const questions = QuestionsSchema.safeParse({
      questions: {
        questions: [
          {
            category: '技术验证',
            question: '请描述一个 Go 服务。',
            rationale: '验证真实经历。',
            expected_signal: '有具体业务与结果。',
            priority: '2',
          },
        ],
      },
    });
    expect(questions.success).toBe(true);
    if (questions.success) {
      expect(questions.data.questions[0]?.priority).toBe(2);
    }

    const feedback = FeedbackSchema.safeParse({
      summary: '',
      score: '86',
      updated_recommendation: null,
      new_requirements: '数据库索引, 缓存设计',
      jd_gaps: null,
      contradictions: null,
      decision_suggestion: '推面',
    });
    expect(feedback.success).toBe(true);
    if (feedback.success) {
      expect(feedback.data.summary).toBe('未提供面试反馈摘要');
      expect(feedback.data.score).toBe(86);
      expect(feedback.data.updated_recommendation).toBe('维持当前推面建议');
      expect(feedback.data.new_requirements).toEqual([
        '数据库索引',
        '缓存设计',
      ]);
      expect(feedback.data.decision_suggestion).toBe('advance');
    }
  });

  test('formats schema validation issues with field paths', () => {
    const parsed = z.object({ summary: z.string() }).safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(formatSchemaIssues(parsed.error)).toBe(
        'summary: Invalid input: expected string, received undefined',
      );
    }
  });

  test('reports the configured HR model when provided', () => {
    process.env[HR_MODEL_ENV] = 'deepseek/qwen3.6-flash';
    expect(modelRef()).toBe('deepseek/qwen3.6-flash');
    process.env[HR_MODEL_ENV] = '';
  });
});

describe('HR model prompt guardrails', () => {
  test('requires explicit one-level JSON and required arrays', async () => {
    const { default: fs } = await import('node:fs');
    const source = fs.readFileSync('src/hr/ai.ts', 'utf8');
    expect(source).toContain('JSON字段必须只有一层对象');
    expect((source.match(/JSON字段必须只有一层对象/g) ?? []).length).toBe(7);
  });
});
