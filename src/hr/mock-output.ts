import type {
  FeedbackResult,
  JobQualityResult,
  MarketResult,
  MatchResult,
  QuestionsResult,
  ResumeParseResult,
} from './ai.js';
import type {
  HrCandidate,
  HrInterviewRound,
  HrJob,
  HrResume,
} from './types.js';

export const HR_MOCK_MODEL_ENV = 'ICLAW_HR_MOCK_MODEL';

export function hrMockModelEnabled(): boolean {
  const value = process.env[HR_MOCK_MODEL_ENV]?.trim().toLowerCase();
  return value ? ['1', 'true', 'yes', 'on'].includes(value) : false;
}

function sentences(text: string): string[] {
  return String(text ?? '')
    .split(/(?<=[。！？!?])\s*|\r?\n|;|；/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function haystack(...values: Array<string | null | undefined>): string {
  return values.filter((item): item is string => Boolean(item)).join('\n').toLowerCase();
}

function evidenceFor(text: string, requirement: string): string | null {
  const keywords = requirement
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#.]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 1)
    .slice(0, 8);
  const sentence = sentences(text).find((item) => {
    const lowered = item.toLowerCase();
    return keywords.some((keyword) => lowered.includes(keyword));
  });
  return sentence ? sentence.slice(0, 1000) : null;
}

function parseYears(text: string): number | null {
  const english = text.match(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i);
  const chinese = text.match(/工作经[验歷][^\d]{0,8}(\d{1,2})/);
  const value = Number(english?.[1] ?? chinese?.[1] ?? Number.NaN);
  return Number.isFinite(value) ? Math.min(60, Math.max(0, value)) : null;
}

export function mockResumeResult(
  job: HrJob,
  resume: HrResume,
): ResumeParseResult {
  const text = resume.extractedText ?? '';
  const lines = sentences(text);
  const email = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0] ?? null;
  const phone =
    text
      .replace(/\D+/g, ' ')
      .trim()
      .split(/\s+/)
      .find((item) => item.length >= 7 && item.length <= 15) ?? null;
  const jobTerms = [...job.requirements, ...job.techStack, ...job.keywords]
    .map((item) => String(item).trim())
    .filter(Boolean);
  const loweredText = haystack(text);
  const matchingJobTerms = jobTerms.filter((item) => {
    const loweredItem = item.toLowerCase();
    if (loweredText.includes(loweredItem)) return true;
    const words = loweredItem
      .split(/[^\p{L}\p{N}+#.]+/u)
      .filter((word) => word.length > 2);
    return words.some((word) =>
      loweredText.includes(word.endsWith('y') ? `${word.slice(0, -1)}` : word),
    );
  });
  const skills = [...new Set(matchingJobTerms)].slice(0, 12);
  const fullNameSource = resume.fileName
    .replace(/\.[^.]+$/, '')
    .replace(/(?:resume|简历|cv).*$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();

  return {
    full_name: fullNameSource || 'Mock候选人',
    email,
    phone,
    location: null,
    years_experience: parseYears(text),
    summary:
      lines.slice(0, 3).join(' ').slice(0, 400) ||
      'Mock简历摘要：候选人简历已成功解析。',
    skills,
    education: lines
      .filter((item) =>
        /大学|本科|硕士|博士|学院|education|b\.?s\b/i.test(item),
      )
      .slice(0, 2)
      .map((item) => ({ detail: item.slice(0, 300) })),
    experiences: lines
      .filter((item) =>
        /负责|开发|设计|维护|led|built|developed|engineer/i.test(item),
      )
      .slice(0, 3)
      .map((item) => ({ detail: item.slice(0, 300) })),
    certifications: [],
    risk_flags:
      text.trim().length < 80
        ? ['Mock模式：简历文本较短，建议人工核对']
        : [],
  };
}

export function mockMatchResult(
  job: HrJob,
  candidate: HrCandidate,
  resume: HrResume,
): MatchResult {
  const requirements = [
    ...new Set(
      [...job.requirements, ...job.techStack]
        .map((item) => String(item).trim())
        .filter(Boolean),
    ),
  ].slice(0, 15);
  const text = `${resume.extractedText ?? ''}\n${candidate.summary ?? ''}`;
  const allEvidence = requirements.map((requirement) => ({
    requirement,
    evidence: evidenceFor(text, requirement),
  }));
  const matched = allEvidence
    .filter((item): item is { requirement: string; evidence: string } =>
      Boolean(item.evidence),
    )
    .slice(0, 8);
  const missing = allEvidence
    .filter((item) => !item.evidence)
    .map((item) => item.requirement)
    .slice(0, 8);
  const score = Math.min(
    75,
    Math.max(
      45,
      Math.round(45 + (matched.length / (requirements.length || 1)) * 30),
    ),
  );
  const matchedLabels = matched.slice(0, 3).map((item) => item.requirement);
  const missingLabels = missing.slice(0, 3);
  const rationale = [
    `Mock匹配结论：JD中 ${requirements.length} 项关键要求可直接对应 ${matched.length} 项。`,
    matchedLabels.length
      ? `主要匹配包括 ${matchedLabels.join('、')}。`
      : '简历与JD关键词直接匹配较少。',
    missingLabels.length
      ? `仍需人工确认 ${missingLabels.join('、')}。`
      : '未发现明显关键词缺口。',
  ].join('');

  return {
    score,
    fit_level:
      score >= 80
        ? 'strong_fit'
        : score >= 65
          ? 'fit'
          : score >= 50
            ? 'borderline'
            : 'not_fit',
    dimension_scores: {
      技术匹配: score,
      经验匹配: Math.max(40, score - 5),
      沟通协作: 72,
    },
    matched_requirements: matched,
    missing_requirements: missing,
    contradictions: [],
    rationale,
  };
}

export function mockQuestionsResult(
  job: HrJob,
  candidate: HrCandidate,
  match: MatchResult,
): QuestionsResult {
  const generated = [
    ...match.matched_requirements.slice(0, 4).map((item) => ({
      category: '项目验证',
      question: `请具体讲解一段与「${item.requirement}」相关的项目经历，并说明你的职责和结果。`,
      rationale: '验证简历证据是否具备真实业务背景和可追问细节。',
      expected_signal: item.evidence.slice(0, 300),
      priority: 2,
    })),
    ...match.missing_requirements.slice(0, 3).map((item) => ({
      category: 'JD缺口',
      question: `JD中提到「${item}」，请说明你目前的掌握程度和一个实际应用场景。`,
      rationale: '确认该能力是缺失、简历未展开，还是仅需要补充证据。',
      expected_signal: '能说明使用场景、限制、决策和结果。',
      priority: 1,
    })),
    {
      category: '动机与稳定性',
      question: `你为什么对「${job.title}」感兴趣？期望的工作内容和团队协作方式是什么？`,
      rationale: '验证岗位动机、沟通预期和稳定性。',
      expected_signal: '对岗位职责有具体理解，并表达可验证的求职目标。',
      priority: 3,
    },
    {
      category: '技术深度',
      question: '请选择简历中最复杂的一段技术实现，说明架构权衡、失败风险和你负责的边界。',
      rationale: '验证候选人是否具备可追问的技术深度。',
      expected_signal: '能讲清楚技术选型、限制、结果和替代方案。',
      priority: 2,
    },
    {
      category: '结果量化',
      question: '请用数据说明一个你主导或核心参与的项目结果，并解释数据口径。',
      rationale: '验证项目结果的量化证据是否真实。',
      expected_signal: '给出基线、改动、指标变化和数据来源。',
      priority: 2,
    },
    {
      category: '协作沟通',
      question: '请描述一次与产品、前端或其他团队的意见冲突，以及你如何推动达成一致。',
      rationale: '验证跨团队沟通与责任意识。',
      expected_signal: '有具体场景、决策依据、沟通动作和最终结果。',
      priority: 3,
    },
    {
      category: '风险与质量',
      question: '请说明你上线服务前如何评估风险、设计验证和准备回滚。',
      rationale: '验证工程质量意识和线上稳定性经验。',
      expected_signal: '有测试策略、灰度方案、监控告警和回滚手段。',
      priority: 2,
    },
  ].slice(0, 8);

  return {
    questions: generated.length
      ? generated
      : [
          {
            category: '项目验证',
            question: `请介绍一个最能代表你技术能力的项目，并说明你在「${job.title}」相关职责中的贡献。`,
            rationale: 'Mock模式下先建立基础项目证据。',
            expected_signal: candidate.summary
              ? candidate.summary.slice(0, 300)
              : '有具体业务背景、技术决策和结果。',
            priority: 1,
          },
        ],
  };
}

export function mockFeedbackResult(
  job: HrJob,
  round: HrInterviewRound,
): FeedbackResult {
  const score =
    round.score == null
      ? 76
      : Math.min(100, Math.max(0, Math.round(round.score)));
  const newRequirements = sentences(round.feedbackText)
    .filter(
      (item) =>
        !haystack(job.jdText).includes(item.toLowerCase().slice(0, 20)),
    )
    .slice(0, 3)
    .map((item) => item.slice(0, 300));

  return {
    summary: `Mock反馈分析：${round.stage}反馈已记录。系统保持JD为主，识别${
      newRequirements.length
        ? '反馈中可能新增的考察点'
        : '暂无明确的JD外新增要求'
    }，建议由HR审核后再用于后续校准。`,
    score,
    updated_recommendation:
      score >= 65 ? '维持或提升推面建议' : '暂缓，建议补充验证',
    new_requirements: newRequirements,
    jd_gaps: [],
    contradictions: [],
    decision_suggestion: score >= 65 ? 'advance' : 'review',
  };
}

export function mockJobQualityResult(job: HrJob): JobQualityResult {
  const structured = [...job.responsibilities, ...job.requirements, ...job.techStack]
    .map((item) => item.trim())
    .filter(Boolean);
  const text = haystack(job.jdText, ...structured);
  const hasOutcome = /负责|支持|参与|设计|优化|交付|项目|系统|平台/.test(text);
  const hasStack = job.techStack.length > 0;
  const hasRequirements = job.requirements.length > 0;
  const hasPreferred = job.preferred.length > 0;
  const score = 45 + (hasOutcome ? 12 : 0) + (hasStack ? 12 : 0) +
    (hasRequirements ? 18 : 0) + (hasPreferred ? 6 : 0);

  return {
    quality_score: Math.min(100, score),
    summary: `Mock JD 质量分析：「${job.title}」${hasOutcome && hasStack ? '已包含职责与技术栈，可继续补齐可验证的产出要求。' : '还存在职责、产出或技术栈描述不足的风险。'}`,
    strengths: [
      ...(hasRequirements ? ['结构化要求字段已填写。'] : []),
      ...(hasStack ? ['技术栈有明确清单。'] : []),
      ...(hasOutcome ? ['JD 文本包含职责描述。'] : []),
    ],
    ambiguities: [
      ...(hasOutcome ? [] : ['缺少岗位负责范围和典型工作场景。']),
      '部分描述未说明预期产出或验证标准。',
    ],
    missing_requirements: [
      ...(hasRequirements ? [] : ['硬性技术要求为空。']),
      '缺少至少一条可验证的项目或系统产出要求。',
    ],
    risks: [
      ...(structured.length < 5 ? ['JD 信息密度偏低，可能影响 AI 匹配精度。'] : []),
      '需要确认最低年限、权限范围、协作对象和值班要求是否遗漏。',
    ],
    improvements: [
      '把 JD 中概括性描述改写为可验证的产出。',
      '按“必须具备 / 优先具备”拆分技术要求。',
      '补充团队规模、协作方式和系统边界。',
    ],
  };
}

export function mockMarketResult(
  job: HrJob,
  candidates: HrCandidate[],
  rounds: HrInterviewRound[],
): MarketResult {
  const stageCounts = [...new Set(candidates.map((item) => item.stage))].map(
    (stage) => ({
      stage,
      count: candidates.filter((item) => item.stage === stage).length,
    }),
  );
  const scores = candidates
    .map((item) => item.overallScore)
    .filter((item): item is number => typeof item === 'number');
  const average = scores.length
    ? Math.round(scores.reduce((sum, item) => sum + item, 0) / scores.length)
    : null;

  return {
    summary: `Mock岗位诊断：仅基于iclaw系统内数据说明「${job.title}」的当前漏斗与风险，不使用外部市场行情。`,
    insights: [
      `岗位共有 ${candidates.length} 名候选人，面试轮次 ${rounds.length} 场。`,
      ...stageCounts
        .slice(0, 4)
        .map((item) => `阶段 ${item.stage} 当前 ${item.count} 人。`),
      average == null
        ? '尚无足够AI评分可用于计算平均值。'
        : `AI平均匹配分为 ${average}。`,
    ],
    risks:
      candidates.length < 5
        ? ['候选人样本较少，诊断结论需人工确认。']
        : [],
    recommendations: [
      '优先复核高匹配候选人的项目证据。',
      '对JD缺口中的高频能力补充结构化追问。',
    ],
  };
}
