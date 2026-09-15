export const RESUME_SCORING_VERSION = 'resume_scoring_v2';

export type ResumeRequirementStatus =
  | 'met'
  | 'partial'
  | 'not_evident'
  | 'contradiction';

export interface ResumeRequirementAssessment {
  requirement: string;
  status: ResumeRequirementStatus;
  critical: boolean;
  evidence: string;
}

export interface ResumeRiskAssessment {
  type: 'contradiction' | 'fabrication' | 'other';
  description: string;
}

export interface ResumeScoreAssessment {
  must_have_requirements: ResumeRequirementAssessment[];
  preferred_requirements: ResumeRequirementAssessment[];
  project_fit: {
    role_domain_similarity: number;
    scenario_match: number;
    complexity_scale: number;
    outcome_impact: number;
  };
  evidence_quality: {
    specific_technology: number;
    measurable_results: number;
    traceability: number;
  };
  risks: ResumeRiskAssessment[];
  rationale: string;
}

export interface ResumeScoreBreakdown {
  score_standard: typeof RESUME_SCORING_VERSION;
  total_score: number;
  fit_level: 'strong_fit' | 'fit' | 'borderline' | 'not_fit';
  weights: {
    must_have: number;
    project_fit: number;
    evidence_quality: number;
    preferred: number;
  };
  adjusted_for_experience: boolean;
  dimensions: {
    must_have_score: number;
    project_fit_score: number;
    evidence_quality_score: number;
    preferred_score: number;
    risk_penalty: number;
  };
  must_have_requirements: ResumeRequirementAssessment[];
  preferred_requirements: ResumeRequirementAssessment[];
  risks: ResumeRiskAssessment[];
  rationale: string;
}

function requirementScore(items: ResumeRequirementAssessment[]): number {
  if (items.length === 0) return 0;
  const credits = items.reduce((sum, item) => {
    if (item.status === 'met') return sum + 1;
    if (item.status === 'partial') return sum + 0.5;
    return sum;
  }, 0);
  return Math.round((credits / items.length) * 100);
}

function weightedScore(
  items: Array<{ score: number; weight: number }>,
): number {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight === 0) return 0;
  const value = items.reduce((sum, item) => sum + item.score * item.weight, 0);
  return Math.round(value / totalWeight);
}

function hasBlockingRequirement(items: ResumeRequirementAssessment[]): boolean {
  return items.some(
    (item) =>
      item.critical &&
      (item.status === 'not_evident' || item.status === 'contradiction'),
  );
}

export function scoreResumeAssessment(
  assessment: ResumeScoreAssessment,
): ResumeScoreBreakdown {
  const mustHaveScore = requirementScore(assessment.must_have_requirements);
  const preferredScore = requirementScore(assessment.preferred_requirements);
  const projectFitScore = weightedScore([
    {
      score: assessment.project_fit.role_domain_similarity,
      weight: 0.35,
    },
    { score: assessment.project_fit.scenario_match, weight: 0.3 },
    { score: assessment.project_fit.complexity_scale, weight: 0.2 },
    { score: assessment.project_fit.outcome_impact, weight: 0.15 },
  ]);
  const evidenceQualityScore = weightedScore([
    {
      score: assessment.evidence_quality.specific_technology,
      weight: 0.4,
    },
    {
      score: assessment.evidence_quality.measurable_results,
      weight: 0.3,
    },
    { score: assessment.evidence_quality.traceability, weight: 0.3 },
  ]);
  const riskPenalty = Math.min(
    15,
    assessment.risks.filter(
      (risk) => risk.type === 'contradiction' || risk.type === 'fabrication',
    ).length * 5,
  );
  const hasFabricationRisk = assessment.risks.some(
    (risk) => risk.type === 'fabrication',
  );
  const adjustedForExperience =
    projectFitScore >= 85 &&
    mustHaveScore >= 70 &&
    !hasBlockingRequirement(assessment.must_have_requirements) &&
    !hasFabricationRisk;

  const weights = adjustedForExperience
    ? {
        must_have: 0.3,
        project_fit: 0.45,
        evidence_quality: 0.15,
        preferred: 0.1,
      }
    : {
        must_have: 0.35,
        project_fit: 0.4,
        evidence_quality: 0.15,
        preferred: 0.1,
      };
  const totalScore = Math.min(
    100,
    Math.max(
      0,
      Math.round(
        mustHaveScore * weights.must_have +
          projectFitScore * weights.project_fit +
          evidenceQualityScore * weights.evidence_quality +
          preferredScore * weights.preferred -
          riskPenalty,
      ),
    ),
  );

  return {
    score_standard: RESUME_SCORING_VERSION,
    total_score: totalScore,
    fit_level:
      totalScore >= 85
        ? 'strong_fit'
        : totalScore >= 70
          ? 'fit'
          : totalScore >= 55
            ? 'borderline'
            : 'not_fit',
    weights,
    adjusted_for_experience: adjustedForExperience,
    dimensions: {
      must_have_score: mustHaveScore,
      project_fit_score: projectFitScore,
      evidence_quality_score: evidenceQualityScore,
      preferred_score: preferredScore,
      risk_penalty: riskPenalty,
    },
    must_have_requirements: assessment.must_have_requirements,
    preferred_requirements: assessment.preferred_requirements,
    risks: assessment.risks,
    rationale: assessment.rationale,
  };
}

export interface LegacyMatchResult {
  score: number;
  fit_level: ResumeScoreBreakdown['fit_level'];
  dimension_scores: Record<string, number>;
  matched_requirements: Array<{ requirement: string; evidence: string }>;
  missing_requirements: string[];
  contradictions: string[];
  rationale: string;
}

export function buildMatchResult(
  breakdown: ResumeScoreBreakdown,
): LegacyMatchResult {
  return {
    score: breakdown.total_score,
    fit_level: breakdown.fit_level,
    dimension_scores: {
      must_have_score: breakdown.dimensions.must_have_score,
      project_fit_score: breakdown.dimensions.project_fit_score,
      evidence_quality_score: breakdown.dimensions.evidence_quality_score,
      preferred_score: breakdown.dimensions.preferred_score,
      risk_penalty: breakdown.dimensions.risk_penalty,
    },
    matched_requirements: breakdown.must_have_requirements
      .filter((item) => item.status === 'met' || item.status === 'partial')
      .map((item) => ({
        requirement: item.requirement,
        evidence: item.evidence,
      })),
    missing_requirements: breakdown.must_have_requirements
      .filter(
        (item) =>
          item.status === 'not_evident' || item.status === 'contradiction',
      )
      .map((item) => item.requirement),
    contradictions: breakdown.risks
      .filter((risk) => risk.type !== 'other')
      .map((risk) => risk.description),
    rationale: breakdown.rationale,
  };
}
