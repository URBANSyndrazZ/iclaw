import {
  requestJson,
  type HrAnalysisJob,
  type HrCandidate,
  type HrCandidateDetail,
  type HrFeishuStatus,
  type HrFeishuConfigForm,
  type HrJob,
  type HrJobRule,
  type HrResume,
  type HrResumePreview,
  type HrResumeImportResult,
  type HrPaginationMeta,
} from './shared';

export type HrSyncResult = {
  attempted: boolean;
  error?: string;
};

export type HrJobSyncResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: string[];
};

export type HrJobListParams = {
  page?: number;
  pageSize?: number;
  withStats?: boolean;
  search?: string;
  lifecycle?: string;
  includeDeleted?: boolean;
};

export type HrCandidateListParams = {
  page?: number;
  pageSize?: number;
  search?: string;
  jobId?: string;
  stage?: string;
  source?: string;
  talentPool?: boolean;
  cleanupDue?: boolean;
};

export type HrAnalysisJobListParams = {
  page?: number;
  pageSize?: number;
  status?: string;
  candidateId?: string;
};

export type HrQuestionListParams = {
  page?: number;
  pageSize?: number;
  search?: string;
  category?: string;
};

function listCandidatesApi<T = HrCandidate>(
  limit?: number,
): Promise<{ candidates: T[] }>;
function listCandidatesApi<T = HrCandidate>(
  params: HrCandidateListParams,
): Promise<{ candidates: T[]; sources: string[] } & HrPaginationMeta>;
function listCandidatesApi<T = HrCandidate>(
  params: number | HrCandidateListParams = 500,
) {
  if (typeof params === 'number') {
    return requestJson<{ candidates: T[] }>(
      `/api/hr/candidates?limit=${params}`,
    );
  }
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('page_size', String(params.pageSize));
  if (params.search) query.set('search', params.search);
  if (params.jobId) query.set('job_id', params.jobId);
  if (params.stage) query.set('stage', params.stage);
  if (params.source) query.set('source', params.source);
  if (typeof params.talentPool === 'boolean') {
    query.set('talent_pool', String(params.talentPool));
  }
  if (params.cleanupDue) query.set('cleanup_due', 'true');
  return requestJson<
    {
      candidates: T[];
      sources: string[];
    } & HrPaginationMeta
  >(`/api/hr/candidates?${query.toString()}`);
}

function listAnalysisJobsApi(
  status?: string,
): Promise<{ jobs: HrAnalysisJob[] }>;
function listAnalysisJobsApi(
  params?: HrAnalysisJobListParams,
): Promise<{ jobs: HrAnalysisJob[] } & HrPaginationMeta>;
function listAnalysisJobsApi(
  params: string | HrAnalysisJobListParams | undefined = undefined,
) {
  if (typeof params === 'string') {
    return requestJson<{ jobs: HrAnalysisJob[] }>(
      `/api/hr/analysis-jobs${params ? `?status=${params}` : ''}`,
    );
  }
  const query = new URLSearchParams();
  if (params?.page) query.set('page', String(params.page));
  if (params?.pageSize) query.set('page_size', String(params.pageSize));
  if (params?.status) query.set('status', params.status);
  if (params?.candidateId) query.set('candidateId', params.candidateId);
  return requestJson<{ jobs: HrAnalysisJob[] } & HrPaginationMeta>(
    `/api/hr/analysis-jobs?${query.toString()}`,
  );
}

export const hrApi = {
  listJobs<T = HrJob>(params: HrJobListParams = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.pageSize) query.set('page_size', String(params.pageSize));
    if (params.withStats) query.set('with_stats', 'true');
    if (params.search) query.set('search', params.search);
    if (params.lifecycle) query.set('lifecycle', params.lifecycle);
    if (params.includeDeleted) query.set('include_deleted', 'true');
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return requestJson<{ jobs: T[] } & HrPaginationMeta>(
      `/api/hr/jobs${suffix}`,
    );
  },

  createJob(input: {
    title: string;
    jd_text: string;
    status?: string;
    expires_at?: string | null;
  }) {
    return requestJson<{ job: HrJob }>('/api/hr/jobs', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  listCandidates: listCandidatesApi,

  getCandidate(candidateId: string) {
    return requestJson<HrCandidateDetail>(`/api/hr/candidates/${candidateId}`);
  },

  reanalyzeCandidate(candidateId: string) {
    return requestJson<{ candidate: HrCandidate; analysis_status: string }>(
      `/api/hr/candidates/${candidateId}/reanalyze`,
      { method: 'POST' },
    );
  },

  retryAnalysis(jobId: string) {
    return requestJson<{ candidate: HrCandidate }>(
      `/api/hr/analysis-jobs/${jobId}/retry`,
      { method: 'POST' },
    );
  },

  listAnalysisJobs: listAnalysisJobsApi,

  analyzePending(jobId: string) {
    return requestJson<{ queued: number }>(
      `/api/hr/jobs/${jobId}/analyze-pending`,
      { method: 'POST' },
    );
  },

  updateCandidate(
    candidateId: string,
    patch: {
      full_name?: string;
      stage?: string;
      talent_pool?: boolean;
      summary?: string | null;
      interviewer_1?: string | null;
      interviewer_2?: string | null;
      interviewer_3?: string | null;
      retention_expires_at?: string | null;
    },
  ) {
    return requestJson<{ candidate: HrCandidate; feishu_sync: HrSyncResult }>(
      `/api/hr/candidates/${candidateId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      },
    );
  },

  hardDeleteCandidate(candidateId: string, confirmFullName: string) {
    return requestJson<{ deleted: boolean }>(
      `/api/hr/candidates/${candidateId}/hard-delete`,
      {
        method: 'POST',
        body: JSON.stringify({ confirm_full_name: confirmFullName }),
      },
    );
  },

  syncCandidate(candidateId: string) {
    return requestJson<{ synced: boolean; recordId: string | null }>(
      `/api/hr/candidates/${candidateId}/feishu/sync`,
      { method: 'POST' },
    );
  },

  submitFeedback(
    candidateId: string,
    input: { stage: string; feedback_text: string; outcome?: string },
  ) {
    return requestJson<{ job_rule: HrJobRule | null }>(
      `/api/hr/candidates/${candidateId}/feedback`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },

  deleteResume(resumeId: string) {
    return requestJson<{ candidate_id: string; feishu_sync: HrSyncResult }>(
      `/api/hr/resumes/${resumeId}`,
      { method: 'DELETE' },
    );
  },

  replaceResume(candidateId: string, resumeId: string, file: File) {
    const form = new FormData();
    form.append('file', file);
    return requestJson<{
      candidate: HrCandidate;
      resume: HrResume;
      feishu_sync: HrSyncResult;
    }>(`/api/hr/candidates/${candidateId}/resumes/${resumeId}/replace`, {
      method: 'POST',
      body: form,
    });
  },

  async resumePreview(resume: HrResume): Promise<HrResumePreview> {
    const response = await fetch(`/api/hr/resumes/${resume.id}/view`, {
      credentials: 'include',
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(
        (payload as { error?: string }).error || '简历预览加载失败',
      );
    }
    if (contentType.startsWith('application/pdf')) {
      const blob = await response.blob();
      return {
        kind: 'pdf',
        content: null,
        objectUrl: URL.createObjectURL(blob),
      };
    }
    return {
      kind: 'text',
      content: await response.text(),
      objectUrl: null,
    };
  },

  async importResumes(
    jobId: string,
    files: File[],
    onItem?: (
      file: File,
      status: 'uploading' | 'imported' | 'failed',
      message?: string,
    ) => void,
  ): Promise<number> {
    let imported = 0;
    for (const file of files) {
      onItem?.(file, 'uploading');
      const form = new FormData();
      form.append('job_id', jobId);
      form.append('file', file);
      try {
        await requestJson<{ candidate: HrCandidate }>(
          '/api/hr/candidates/import',
          { method: 'POST', body: form },
        );
        imported += 1;
        onItem?.(file, 'imported');
      } catch (error) {
        onItem?.(
          file,
          'failed',
          error instanceof Error ? error.message : '导入失败',
        );
      }
    }
    return imported;
  },

  importResumeLink(
    jobId: string,
    sourceUrl: string,
    candidate?: { full_name?: string },
  ) {
    return requestJson<HrResumeImportResult>(
      '/api/hr/candidates/import/link',
      {
        method: 'POST',
        body: JSON.stringify({
          job_id: jobId,
          source_url: sourceUrl,
          candidate,
        }),
      },
    );
  },

  getJob(jobId: string) {
    return requestJson<{ job: HrJob }>(`/api/hr/jobs/${jobId}`);
  },

  updateJob(
    jobId: string,
    patch: {
      title?: string;
      jd_text?: string;
      expires_at?: string | null;
    },
  ) {
    return requestJson<{ job: HrJob; feishu_sync: HrJobSyncResult }>(
      `/api/hr/jobs/${jobId}`,
      {
        method: 'PUT',
        body: JSON.stringify(patch),
      },
    );
  },

  deleteJob(jobId: string) {
    return requestJson<{ job: HrJob }>(`/api/hr/jobs/${jobId}`, {
      method: 'DELETE',
    });
  },

  restoreJob(jobId: string) {
    return requestJson<{ job: HrJob }>(`/api/hr/jobs/${jobId}/restore`, {
      method: 'POST',
    });
  },

  listJobRules(jobId: string) {
    return requestJson<{ rules: HrJobRule[]; activeRule: HrJobRule | null }>(
      `/api/hr/jobs/${jobId}/rules`,
    );
  },

  updateJobRule(jobId: string, ruleId: string, action: 'activate' | 'discard') {
    return requestJson<{ rule: HrJobRule }>(
      `/api/hr/jobs/${jobId}/rules/${ruleId}/${action}`,
      { method: 'POST' },
    );
  },

  marketAnalysis(jobId: string) {
    return requestJson<{ analysis: { summary: string; insights: string[] } }>(
      `/api/hr/jobs/${jobId}/market-analysis`,
      { method: 'POST' },
    );
  },

  feishuStatus() {
    return requestJson<{ status: HrFeishuStatus }>('/api/hr/feishu/status');
  },

  feishuConfig() {
    return requestJson<{ config: Partial<HrFeishuConfigForm> | null }>(
      '/api/hr/feishu/config',
    );
  },

  saveFeishuConfig(config: HrFeishuConfigForm) {
    return requestJson<{ config: Partial<HrFeishuConfigForm> }>(
      '/api/hr/feishu/config',
      {
        method: 'PUT',
        body: JSON.stringify(config),
      },
    );
  },

  testFeishuConfig(config: HrFeishuConfigForm) {
    return requestJson<{
      connected: boolean;
      fields: string[];
      missingFields: string[];
      typeIssues: Array<{ field: string; message: string }>;
    }>('/api/hr/feishu/test', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },

  overview<T>() {
    return requestJson<{ overview: T }>('/api/hr/overview');
  },

  agentActivity() {
    return requestJson<{
      activity: Array<{
        id: string;
        action: string;
        targetId: string | null;
        jobId: string | null;
        jobTitle: string | null;
        candidateId: string | null;
        candidateName: string | null;
        summary: string;
        source: 'agent_runtime' | 'web' | 'system' | 'unknown';
        createdAt: string;
      }>;
    }>('/api/hr/agent-activity');
  },

  analytics<T>() {
    return requestJson<{ analytics: T }>('/api/hr/analytics');
  },

  questionLibrary<T>(params: HrQuestionListParams = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.pageSize) query.set('page_size', String(params.pageSize));
    if (params.search) query.set('search', params.search);
    if (params.category) query.set('category', params.category);
    return requestJson<{ items: T[]; categories: string[] } & HrPaginationMeta>(
      `/api/hr/questions?${query.toString()}`,
    );
  },
};
