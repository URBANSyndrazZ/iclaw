// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { hrApi } = vi.hoisted(() => ({
  hrApi: {
    listCandidates: vi.fn(),
    getCandidate: vi.fn(),
    getJob: vi.fn(),
    listJobRules: vi.fn(),
  },
}));

vi.mock('../web/src/pages/hr/api', () => ({ hrApi }));

const { HrBoardPage } = await import('../web/src/pages/hr/HrBoardPage');
const { HrCandidateDetailPage } = await import(
  '../web/src/pages/hr/HrCandidateDetailPage'
);
const { HrJobDetailPage } = await import(
  '../web/src/pages/hr/HrJobDetailPage'
);

const candidate = {
  id: 'candidate-1',
  jobId: 'job-1',
  fullName: 'Ada Lovelace',
  source: 'upload',
  sourceUrl: null,
  email: null,
  phone: null,
  stage: 'interview_1',
  overallScore: 82,
  recommendation: 'fit',
  summary: 'Go backend engineer',
  riskFlags: [],
  talentPool: false,
  aiStatus: 'completed' as const,
  aiError: null,
};

const job = {
  id: 'job-1',
  title: 'Backend Engineer',
  department: null,
  location: null,
  salaryRange: null,
  status: 'active',
  jdText: 'Build Go services.',
};

function render(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  return { container, root };
}

function renderAt(routePath: string, url: string, node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path={routePath} element={node} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: {
          configured: false,
          enabled: false,
          lastSyncedAt: null,
          lastStatus: null,
          lastError: null,
        },
      }),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('HR page convergence', () => {
  test('renders the new stage board from the shared HR API', async () => {
    hrApi.listCandidates.mockResolvedValue({ candidates: [candidate] });
    const { container, root } = render(<HrBoardPage />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(hrApi.listCandidates).toHaveBeenCalled();
    expect(container.textContent).toContain('一面 · 1');
    expect(container.textContent).toContain('Ada Lovelace');
    act(() => root.unmount());
  });

  test('renders candidate details with evidence and resume actions', async () => {
    hrApi.getCandidate.mockResolvedValue({
      candidate,
      resumes: [{
        id: 'resume-1',
        candidateId: candidate.id,
        jobId: job.id,
        fileName: 'Ada.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        sha256: 'hash',
        parserVersion: 'v1',
        parseStatus: 'parsed',
        createdAt: '2026-01-01T00:00:00Z',
      }],
      match: {
        score: 82,
        fitLevel: 'fit',
        dimensionScores: {},
        matchedRequirements: [{ requirement: 'Go', evidence: 'Go API project' }],
        missingRequirements: [],
        contradictions: [],
        rationale: 'Strong Go experience.',
      },
      questions: [],
      rounds: [],
      analysisJobs: [],
      feishuSyncStatus: null,
    });
    const { container, root } = renderAt(
      '/hr/candidates/:candidateId',
      '/hr/candidates/candidate-1',
      <HrCandidateDetailPage />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(hrApi.getCandidate).toHaveBeenCalledWith('candidate-1');
    expect(container.textContent).toContain('JD 匹配证据');
    expect(container.textContent).toContain('Go API project');
    expect(container.textContent).toContain('Ada.pdf');
    act(() => root.unmount());
  });

  test('renders job details, upload actions and scoring rules', async () => {
    hrApi.getJob.mockResolvedValue({ job });
    hrApi.listCandidates.mockResolvedValue({ candidates: [candidate] });
    hrApi.listJobRules.mockResolvedValue({
      rules: [{
        id: 'rule-1',
        ruleVersion: 1,
        status: 'draft',
        summary: 'Prefer database depth.',
        newRequirements: ['Database indexing'],
        jdGaps: [],
        contradictions: [],
        decisionSuggestion: 'review',
        createdAt: '2026-01-01T00:00:00Z',
      }],
      activeRule: null,
    });
    const { container, root } = renderAt(
      '/hr/jobs/:jobId',
      '/hr/jobs/job-1',
      <HrJobDetailPage />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(hrApi.getJob).toHaveBeenCalledWith('job-1');
    expect(hrApi.listJobRules).toHaveBeenCalledWith('job-1');
    expect(container.textContent).toContain('Build Go services.');
    expect(container.textContent).toContain('批量 AI 分析待评估');
    expect(container.textContent).toContain('Prefer database depth.');
    act(() => root.unmount());
  });
});
