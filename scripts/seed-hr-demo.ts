import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../src/db.js';
import { getUserByUsername } from '../src/db.js';
import {
  HR_MOCK_MODEL_ENV,
} from '../src/hr/mock-output.js';
import { ingestResume } from '../src/hr/import.js';
import {
  createHrInterviewRound,
  createHrJob,
  createHrAnalysisJob,
  createHrJobRule,
  listHrAnalysisJobs,
  listHrInterviewRounds,
  listHrCandidates,
  listHrJobs,
  listHrResumesForCandidate,
  markHrAnalysisStatus,
  updateHrCandidate,
} from '../src/hr/store.js';
import { processCandidateAnalysis } from '../src/hr/analysis-service.js';
import type { HrJob } from '../src/hr/types.js';

const projectRoot = process.cwd();
const jdDir = path.join(projectRoot, 'data', 'jd');
const resumeDir = path.join(projectRoot, 'data', 'resume');
const techTerms = [
  'Golang', 'Go', 'Java', 'Python', 'MySQL', 'Redis', 'Kafka',
  'Docker', 'Kubernetes', 'K8s', 'GORM', 'XORM', 'pprof',
];

interface JobSeed {
  title: string;
  jdText: string;
  keywords: string[];
  responsibilities: string[];
  requirements: string[];
  preferred: string[];
  techStack: string[];
}

function normalizeTitle(fileName: string): string {
  return path.basename(fileName, path.extname(fileName)).trim();
}

function candidateName(fileName: string): string {
  const stem = normalizeTitle(fileName);
  const bracketed = stem.match(/[【[]([^】\]]+)[】\]]\s*(.+)$/);
  const source = bracketed?.[2] ?? stem;
  return source.split(/[-_—]/, 1)[0]?.trim() || stem;
}

function bulletList(text: string, startMarker: string, endMarkers: string[]): string[] {
  const start = text.indexOf(startMarker);
  if (start < 0) return [];
  const rest = text.slice(start + startMarker.length);
  const end = Math.min(
    ...endMarkers.map((marker) => {
      const index = rest.indexOf(marker);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    }),
  );
  const section = rest.slice(0, end === Number.MAX_SAFE_INTEGER ? undefined : end);
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s\d、.]+[-、.]?\s*/, '').trim())
    .filter((line) => line.length > 3 && line.length <= 300)
    .slice(0, 20);
}

function parseJobSeed(fileName: string): JobSeed {
  const jdText = fs.readFileSync(path.join(jdDir, fileName), 'utf8').trim();
  const title = normalizeTitle(fileName);
  const requirementLines = [
    ...bulletList(jdText, '硬性要求', ['软性要求', '优先条件', '加分项']),
    ...bulletList(jdText, '能力要求', ['优先条件', '工作职责', '工作内容']),
  ];
  const preferredLines = [
    ...bulletList(jdText, '优先条件', ['加分项']),
    ...bulletList(jdText, '加分项', []),
  ];
  const lowerText = jdText.toLowerCase();
  const techStack = techTerms.filter((term) =>
    lowerText.includes(term.toLowerCase()),
  );
  const requirements = [...new Set(requirementLines)].filter((item) =>
    item.split(/[，,。;；]/).some((part) =>
      techStack.some((term) => part.toLowerCase().includes(term.toLowerCase())),
    ),
  );
  return {
    title,
    jdText,
    keywords: [...techStack],
    responsibilities: bulletList(jdText, '岗位职责', ['任职要求', '能力要求']),
    requirements: requirements.length
      ? requirements
      : [...new Set(requirementLines)].slice(0, 8),
    preferred: [...new Set(preferredLines)].slice(0, 8),
    techStack: [...new Set(techStack.filter((item) => item !== 'Go'))],
  };
}

function chooseJob(stem: string, jobs: HrJob[]): HrJob {
  const direct = jobs.find((job) => stem.includes(job.title));
  if (direct) return direct;
  const scored = jobs
    .map((job) => ({
      job,
      score: stem.includes(job.title) ? 1 : 0,
    }))
    .sort((left, right) => right.score - left.score);
  const fallback = scored[0]?.job ?? jobs[0]!;
  return fallback as HrJob;
}

async function main(): Promise<void> {
  const username = process.argv[2];
  if (!username) {
    throw new Error('Usage: npm run seed:hr-demo -- <username> [--with-model]');
  }
  const useRealModel = process.argv.includes('--with-model');
  if (!useRealModel) process.env[HR_MOCK_MODEL_ENV] = 'true';

  initDatabase();
  const user = getUserByUsername(username);
  if (!user) throw new Error(`User not found: ${username}`);

  const jobSeeds = fs.readdirSync(jdDir)
    .filter((name) => name.endsWith('.txt'))
    .map(parseJobSeed);
  if (jobSeeds.length === 0) throw new Error(`No JD files found in ${jdDir}`);

  const existingJobs = listHrJobs(user.id);
  const jobs: HrJob[] = jobSeeds.map((seed) => {
    const existing = existingJobs.find((job) => job.title === seed.title);
    if (existing) return existing;
    return createHrJob({
      ownerUserId: user.id,
      department: null,
      location: null,
      level: null,
      salaryRange: null,
      ...seed,
      status: 'active',
    });
  });

  const resumeFiles = fs.readdirSync(resumeDir)
    .filter((name) => ['.pdf', '.doc', '.docx', '.txt', '.md'].includes(path.extname(name).toLowerCase()));
  if (resumeFiles.length === 0) {
    throw new Error(`No resume files found in ${resumeDir}`);
  }

  const imported: Array<{ candidateId: string; jobId: string; resumeId: string }> = [];
  for (const fileName of resumeFiles) {
    const stem = normalizeTitle(fileName);
    const job = chooseJob(stem, jobs);
    const candidate = listHrCandidates(user.id, { jobId: job.id, limit: 500 })
      .find((item) => item.fullName === candidateName(fileName));
    if (candidate) {
      const resumes = listHrResumesForCandidate(user.id, candidate.id);
      if (resumes.length > 0) {
        imported.push({
          candidateId: candidate.id,
          jobId: job.id,
          resumeId: resumes[0]!.id,
        });
        continue;
      }
    }
    const result = await ingestResume({
      ownerUserId: user.id,
      actorId: user.id,
      job,
      fileName,
      mimeType: fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : null,
      content: fs.readFileSync(path.join(resumeDir, fileName)),
      source: 'manual',
      candidate: { full_name: candidateName(fileName) },
    });
    imported.push({
      candidateId: result.candidate.id,
      jobId: job.id,
      resumeId: result.resume.id,
    });
  }

  let completed = 0;
  let failed = 0;
  for (const [index, item] of imported.entries()) {
    if (!useRealModel || index < imported.length - 1) {
      try {
        await processCandidateAnalysis(user.id, item.candidateId);
        completed += 1;
      } catch (error) {
        failed += 1;
        console.warn(
          `analysis failed for candidate ${item.candidateId}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  const firstCandidate = listHrCandidates(user.id, {
    jobId: jobs[0]!.id,
    limit: 1,
  })[0];
  if (firstCandidate) {
    const existingRound = listHrInterviewRounds(user.id, firstCandidate.id)
      .find((round) => round.feedbackText.includes('演示反馈'));
    if (!existingRound) {
    const round = createHrInterviewRound({
      ownerUserId: user.id,
      jobId: jobs[0]!.id,
      candidateId: firstCandidate.id,
      stage: 'interview_1',
      interviewer: 'Demo Interviewer',
      scheduledAt: null,
      completedAt: new Date().toISOString(),
      outcome: 'hold',
      feedbackText:
        '演示反馈：候选人项目经历基本真实，建议追问数据库索引、缓存失效和线上故障处理。',
      score: 78,
    });
    createHrJobRule({
      ownerUserId: user.id,
      jobId: jobs[0]!.id,
      status: 'draft',
      sourceRoundId: round.id,
      summary: '演示规则：关注数据库索引、缓存和线上故障排查深度。',
      newRequirements: ['数据库索引设计'],
      jdGaps: ['线上故障排查流程'],
      contradictions: [],
      decisionSuggestion: 'review',
      model: 'hr-demo-seed',
    });
    }
  }

  const failureCandidate = [...imported].reverse().find((item) => {
    const candidate = listHrCandidates(user.id, { jobId: item.jobId, limit: 500 })
      .find((candidate) => candidate.id === item.candidateId);
    return candidate?.aiStatus === 'completed';
  });
  if (failureCandidate) {
    const existingFailure = listHrAnalysisJobs(user.id, failureCandidate.candidateId)
      .find((job) => job.error?.includes('演示数据'));
    if (!existingFailure) {
    const candidate = updateHrCandidate(user.id, failureCandidate.candidateId, {
      aiStatus: 'failed',
      aiError: '演示数据：模拟模型输出校验失败',
    });
    if (candidate) {
      const analysisJob = createHrAnalysisJob({
        ownerUserId: user.id,
        type: 'jd_match',
        targetId: candidate.id,
        inputHash: 'demo-failure',
        model: 'hr-mock-model',
      });
      markHrAnalysisStatus(user.id, analysisJob.id, 'failed', {
        error: '演示数据：模拟模型输出校验失败',
        model: 'hr-mock-model',
      });
    }
  }
  }

  console.log(
    `HR demo seed complete: jobs=${jobs.length}, resumes=${imported.length}, analyzed=${completed}, failed=${failed}, demo_failure=${failureCandidate ? 1 : 0}, mock_model=${!useRealModel}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
