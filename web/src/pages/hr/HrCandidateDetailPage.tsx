import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { RefreshCw, Send, Sparkles } from 'lucide-react';
import {
  AI_STATUS_LABELS,
  EmptyState,
  HR_STAGES,
  HrNotice,
  HrShell,
  STAGE_LABELS,
  scoreColor,
  type HrCandidateDetail,
  type HrResume,
} from './shared';
import { hrApi } from './api';

type Preview = {
  resume: HrResume;
  kind: 'pdf' | 'text';
  content: string | null;
  objectUrl: string | null;
  loading: boolean;
  error: string | null;
};

const INTERVIEW_STAGES = ['interview_1', 'interview_2', 'interview_3'];

export function HrCandidateDetailPage() {
  const { candidateId } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<HrCandidateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [nameValue, setNameValue] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [deletingResumeId, setDeletingResumeId] = useState<string | null>(null);
  const [replacingResumeId, setReplacingResumeId] = useState<string | null>(
    null,
  );
  const [syncing, setSyncing] = useState(false);
  const [interviewerForm, setInterviewerForm] = useState({
    interviewer_1: '',
    interviewer_2: '',
    interviewer_3: '',
  });
  const [savingInterviewers, setSavingInterviewers] = useState(false);
  const [retentionValue, setRetentionValue] = useState('');
  const [savingRetention, setSavingRetention] = useState(false);
  const [hardDeleteName, setHardDeleteName] = useState('');
  const [hardDeleteOpen, setHardDeleteOpen] = useState(false);
  const [deletingCandidate, setDeletingCandidate] = useState(false);

  const load = useCallback(async () => {
    if (!candidateId) return;
    const next = await hrApi.getCandidate(candidateId);
    setDetail(next);
    setNameValue(next.candidate.fullName);
    setInterviewerForm({
      interviewer_1: next.candidate.interviewer1 ?? '',
      interviewer_2: next.candidate.interviewer2 ?? '',
      interviewer_3: next.candidate.interviewer3 ?? '',
    });
    setRetentionValue(
      next.candidate.retentionExpiresAt
        ? next.candidate.retentionExpiresAt.slice(0, 16)
        : '',
    );
  }, [candidateId]);

  useEffect(() => {
    if (!candidateId) return;
    setLoading(true);
    load()
      .then(() => setError(null))
      .catch((err) => setError(err instanceof Error ? err.message : '加载失败'))
      .finally(() => setLoading(false));
  }, [candidateId, load]);

  useEffect(() => {
    return () => {
      if (preview?.objectUrl) URL.revokeObjectURL(preview.objectUrl);
    };
  }, [preview]);

  useEffect(() => {
    if (detail?.candidate.aiStatus !== 'running') return;
    const timer = setInterval(() => {
      void load().catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [detail?.candidate.aiStatus, load]);

  async function openPreview(resume: HrResume) {
    if (preview?.objectUrl) URL.revokeObjectURL(preview.objectUrl);
    setPreview({
      resume,
      kind: resume.fileName.toLowerCase().endsWith('.pdf') ? 'pdf' : 'text',
      content: null,
      objectUrl: null,
      loading: true,
      error: null,
    });
    try {
      const result = await hrApi.resumePreview(resume);
      setPreview({
        resume,
        ...result,
        loading: false,
        error: null,
      });
    } catch (err) {
      setPreview((prev) =>
        prev && prev.resume.id === resume.id
          ? {
              ...prev,
              loading: false,
              error: err instanceof Error ? err.message : '简历预览加载失败',
            }
          : prev,
      );
    }
  }

  async function saveName(event: React.FormEvent) {
    event.preventDefault();
    if (!candidateId || !detail) return;
    const fullName = nameValue.trim();
    if (!fullName) return;
    setSavingName(true);
    try {
      const result = await hrApi.updateCandidate(candidateId, {
        full_name: fullName,
      });
      setMessage(
        result.feishu_sync?.error
          ? `姓名已更新，但飞书同步失败：${result.feishu_sync.error}`
          : '姓名已更新',
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '姓名更新失败');
    } finally {
      setSavingName(false);
    }
  }

  async function analyze() {
    if (!candidateId) return;
    setMessage('AI 分析已排队');
    await hrApi.reanalyzeCandidate(candidateId);
    await load();
  }

  async function updateStage(stage: string) {
    if (!candidateId) return;
    try {
      const result = await hrApi.updateCandidate(candidateId, { stage });
      setMessage(
        result.feishu_sync?.error
          ? `流程已更新，但飞书同步失败：${result.feishu_sync.error}`
          : '流程已更新并同步飞书',
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新失败');
    }
  }

  async function syncFeishu() {
    if (!candidateId) return;
    setSyncing(true);
    try {
      await hrApi.syncCandidate(candidateId);
      setMessage('飞书同步成功');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '飞书同步失败');
    } finally {
      setSyncing(false);
    }
  }

  async function saveInterviewers() {
    if (!candidateId || !detail || savingInterviewers) return;
    setSavingInterviewers(true);
    try {
      const result = await hrApi.updateCandidate(candidateId, {
        interviewer_1: interviewerForm.interviewer_1.trim() || null,
        interviewer_2: interviewerForm.interviewer_2.trim() || null,
        interviewer_3: interviewerForm.interviewer_3.trim() || null,
      });
      setMessage(
        result.feishu_sync?.error
          ? `面试官已保存，但飞书同步失败：${result.feishu_sync.error}`
          : '面试官已保存并同步飞书',
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '面试官保存失败');
    } finally {
      setSavingInterviewers(false);
    }
  }

  async function saveRetention(expiresAt: string | null) {
    if (!candidateId || !detail || savingRetention) return;
    setSavingRetention(true);
    try {
      await hrApi.updateCandidate(candidateId, {
        retention_expires_at: expiresAt,
      });
      setMessage(expiresAt ? '保留期已设置' : '保留期已清除');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保留期保存失败');
    } finally {
      setSavingRetention(false);
    }
  }

  async function hardDeleteCandidate() {
    if (!candidateId || !detail || deletingCandidate) return;
    setDeletingCandidate(true);
    try {
      await hrApi.hardDeleteCandidate(candidateId, hardDeleteName.trim());
      setMessage('候选人已彻底删除');
      setHardDeleteOpen(false);
      navigate('/hr/candidates');
    } catch (err) {
      setError(err instanceof Error ? err.message : '候选人删除失败');
    } finally {
      setDeletingCandidate(false);
    }
  }

  async function submitFeedback(event: React.FormEvent) {
    event.preventDefault();
    if (!candidateId || !detail || !feedback.trim()) return;
    setSubmittingFeedback(true);
    try {
      const result = await hrApi.submitFeedback(candidateId, {
        stage: detail.candidate.stage,
        feedback_text: feedback,
        outcome: 'hold',
      });
      setFeedback('');
      setMessage(
        result.job_rule
          ? '反馈分析完成，已生成评分规则草稿'
          : '反馈分析完成，未发现 JD/面试偏差',
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '反馈分析失败');
    } finally {
      setSubmittingFeedback(false);
    }
  }

  async function deleteResume(resume: HrResume) {
    if (!candidateId || deletingResumeId) return;
    if (!window.confirm(`确认删除简历：${resume.fileName}？`)) return;
    setDeletingResumeId(resume.id);
    try {
      const result = await hrApi.deleteResume(resume.id);
      setMessage(
        result.feishu_sync?.error
          ? `简历已删除，但飞书同步失败：${result.feishu_sync.error}`
          : '简历已删除',
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '简历删除失败');
    } finally {
      setDeletingResumeId(null);
    }
  }

  async function replaceResume(resume: HrResume, file: File) {
    if (!candidateId) return;
    setReplacingResumeId(resume.id);
    try {
      const result = await hrApi.replaceResume(candidateId, resume.id, file);
      setMessage(
        result.feishu_sync?.error
          ? `简历已替换，但飞书同步失败：${result.feishu_sync.error}`
          : '简历已替换；请重新 AI 分析',
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '简历替换失败');
    } finally {
      setReplacingResumeId(null);
    }
  }

  if (loading) {
    return (
      <HrShell title="候选人详情" description="正在加载候选人数据">
        <EmptyState title="加载中" description="请稍候。" />
      </HrShell>
    );
  }

  if (!detail) {
    return (
      <HrShell title="候选人详情" description="候选人不存在或没有访问权限">
        <EmptyState title="未找到候选人" description="请返回候选人中心。" />
      </HrShell>
    );
  }

  const candidate = detail.candidate;

  return (
    <HrShell
      title={candidate.fullName}
      description="简历证据、匹配结论、反馈与同步状态"
    >
      <HrNotice error={error} />
      {message && (
        <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          {message}
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-3">
        <section className="rounded-2xl border bg-card p-4 lg:col-span-2">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-muted-foreground">
                {STAGE_LABELS[candidate.stage]} · {candidate.source}
              </p>
              <form className="mt-2 flex gap-2" onSubmit={saveName}>
                <input
                  aria-label="候选人姓名"
                  className="w-48 rounded-lg border bg-background px-2 py-1 text-sm"
                  value={nameValue}
                  onChange={(event) => setNameValue(event.target.value)}
                />
                <button
                  className="rounded-lg border px-2 py-1 text-xs disabled:opacity-60"
                  disabled={
                    savingName ||
                    !nameValue.trim() ||
                    nameValue.trim() === candidate.fullName
                  }
                >
                  保存姓名
                </button>
              </form>
            </div>
            <span
              className={`text-2xl font-bold ${scoreColor(candidate.overallScore)}`}
            >
              {candidate.overallScore ?? '—'}
            </span>
            <span className="block text-right text-[10px] uppercase tracking-wide text-muted-foreground">
              {candidate.overallScoreStandard === 'resume_scoring_v2'
                ? 'v2 标准'
                : candidate.overallScoreStandard
                  ? '旧标准'
                  : '旧标准'}
            </span>
          </div>
          <p className="mt-3 text-sm">
            {candidate.summary || '暂无候选人摘要'}
          </p>
          <div className="mt-3 rounded-xl border bg-background p-3 text-sm">
            <div className="flex items-center justify-between">
              <strong>AI 匹配分析</strong>
              <span
                className={
                  candidate.aiStatus === 'failed'
                    ? 'text-rose-700'
                    : 'text-muted-foreground'
                }
              >
                {AI_STATUS_LABELS[candidate.aiStatus]}
              </span>
            </div>
            {candidate.aiError && (
              <p className="mt-1 text-rose-700">{candidate.aiError}</p>
            )}
            <button
              className="mt-2 rounded-lg border px-3 py-1 text-xs disabled:opacity-60"
              disabled={candidate.aiStatus === 'running'}
              onClick={() => void analyze()}
            >
              <RefreshCw className="mr-1 inline h-3 w-3" />
              {candidate.aiStatus === 'running' ? '分析中…' : '重新分析'}
            </button>
          </div>
          {detail.match && (
            <div className="mt-4 rounded-xl border p-3">
              <h3 className="font-medium">JD 匹配证据</h3>
              {detail.match.scoreStandard === 'resume_scoring_v2' && (
                <p className="mt-1 text-xs text-muted-foreground">
                  resume_scoring_v2 · 固定公式评分
                  {detail.match.scoreBreakdown?.adjusted_for_experience
                    ? ' · 经验优先调整'
                    : ''}
                </p>
              )}
              <p className="mt-2 text-sm">{detail.match.rationale}</p>
              <div className="mt-3 space-y-2 text-sm">
                {detail.match.matchedRequirements.map((item, index) => (
                  <div
                    key={index}
                    className="rounded-lg bg-emerald-50 p-2 text-emerald-800"
                  >
                    <strong>{item.requirement}</strong>
                    <p>{item.evidence}</p>
                  </div>
                ))}
                {detail.match.missingRequirements.map((item, index) => (
                  <div
                    key={index}
                    className="rounded-lg bg-amber-50 p-2 text-amber-800"
                  >
                    {item}
                  </div>
                ))}
                {detail.match.contradictions.map((item, index) => (
                  <div
                    key={index}
                    className="rounded-lg bg-rose-50 p-2 text-rose-800"
                  >
                    {item}
                  </div>
                ))}
              </div>
              {detail.match.scoreBreakdown && (
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-5">
                  <div className="rounded-lg bg-muted p-2">
                    <div>Must-have</div>
                    <strong>
                      {detail.match.scoreBreakdown.dimensions.must_have_score}
                    </strong>
                    <div className="text-muted-foreground">
                      权重{' '}
                      {Math.round(
                        detail.match.scoreBreakdown.weights.must_have * 100,
                      )}
                      %
                    </div>
                  </div>
                  <div className="rounded-lg bg-muted p-2">
                    <div>项目契合</div>
                    <strong>
                      {detail.match.scoreBreakdown.dimensions.project_fit_score}
                    </strong>
                    <div className="text-muted-foreground">
                      权重{' '}
                      {Math.round(
                        detail.match.scoreBreakdown.weights.project_fit * 100,
                      )}
                      %
                    </div>
                  </div>
                  <div className="rounded-lg bg-muted p-2">
                    <div>证据质量</div>
                    <strong>
                      {
                        detail.match.scoreBreakdown.dimensions
                          .evidence_quality_score
                      }
                    </strong>
                    <div className="text-muted-foreground">
                      权重{' '}
                      {Math.round(
                        detail.match.scoreBreakdown.weights.evidence_quality *
                          100,
                      )}
                      %
                    </div>
                  </div>
                  <div className="rounded-lg bg-muted p-2">
                    <div>优先项</div>
                    <strong>
                      {detail.match.scoreBreakdown.dimensions.preferred_score}
                    </strong>
                    <div className="text-muted-foreground">
                      权重{' '}
                      {Math.round(
                        detail.match.scoreBreakdown.weights.preferred * 100,
                      )}
                      %
                    </div>
                  </div>
                  <div className="rounded-lg bg-rose-50 p-2 text-rose-700">
                    <div>风险扣分</div>
                    <strong>
                      -{detail.match.scoreBreakdown.dimensions.risk_penalty}
                    </strong>
                  </div>
                </div>
              )}
            </div>
          )}
          {INTERVIEW_STAGES.includes(candidate.stage) ? (
            <form onSubmit={submitFeedback} className="mt-5 space-y-2">
              <label className="text-sm font-medium">新增面试反馈</label>
              <textarea
                className="min-h-28 w-full rounded-lg border bg-background p-3 text-sm"
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
              />
              <button
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-white"
                disabled={submittingFeedback}
              >
                <Sparkles className="h-4 w-4" />
                {submittingFeedback ? '分析中…' : '分析反馈'}
              </button>
            </form>
          ) : (
            <p className="mt-5 rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
              面试反馈在候选人进入一面、二面或三面后开放。
            </p>
          )}
        </section>
        <aside className="space-y-4">
          <div className="rounded-2xl border bg-card p-4">
            <h3 className="font-medium">简历</h3>
            {detail.resumes.map((resume) => (
              <div
                key={resume.id}
                className="mt-2 rounded-lg border p-2 text-sm"
              >
                <p className="truncate">{resume.fileName}</p>
                <div className="mt-1 flex flex-wrap gap-2 text-xs">
                  {['.pdf', '.txt', '.md'].some((ext) =>
                    resume.fileName.toLowerCase().endsWith(ext),
                  ) && (
                    <button
                      className="text-brand-600 hover:underline"
                      onClick={() => void openPreview(resume)}
                    >
                      查看
                    </button>
                  )}
                  <a
                    className="text-muted-foreground hover:underline"
                    href={`/api/hr/resumes/${resume.id}/download`}
                  >
                    下载
                  </a>
                  <label
                    className={`cursor-pointer text-brand-600 hover:underline ${replacingResumeId === resume.id ? 'pointer-events-none opacity-60' : ''}`}
                  >
                    替换
                    <input
                      type="file"
                      accept=".pdf,.doc,.docx,.txt,.md"
                      className="hidden"
                      disabled={replacingResumeId === resume.id}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void replaceResume(resume, file);
                        event.target.value = '';
                      }}
                    />
                  </label>
                  <button
                    className="text-rose-600 hover:underline"
                    disabled={deletingResumeId === resume.id}
                    onClick={() => void deleteResume(resume)}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
            {detail.resumes.length === 0 && (
              <p className="mt-2 text-sm text-muted-foreground">暂无简历</p>
            )}
          </div>
          <div className="rounded-2xl border bg-card p-4">
            <h3 className="font-medium">面试官</h3>
            {(['interviewer_1', 'interviewer_2', 'interviewer_3'] as const).map(
              (field, index) => (
                <label
                  key={field}
                  className="mt-2 block text-xs text-muted-foreground"
                >
                  {`${index + 1} 面面试官`}
                  <input
                    className="mt-1 w-full rounded-lg border bg-background px-2 py-1 text-sm"
                    value={interviewerForm[field]}
                    placeholder="可留空"
                    onChange={(event) =>
                      setInterviewerForm((prev) => ({
                        ...prev,
                        [field]: event.target.value,
                      }))
                    }
                  />
                </label>
              ),
            )}
            <button
              className="mt-3 w-full rounded-lg border px-3 py-2 text-sm disabled:opacity-60"
              disabled={savingInterviewers}
              onClick={() => void saveInterviewers()}
            >
              {savingInterviewers ? '保存中…' : '保存面试官并同步'}
            </button>
          </div>
          <div className="rounded-2xl border bg-card p-4">
            <h3 className="font-medium">推面状态</h3>
            <select
              className="mt-2 w-full rounded-lg border bg-background p-2 text-sm"
              value={candidate.stage}
              onChange={(event) => void updateStage(event.target.value)}
            >
              {HR_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {STAGE_LABELS[stage]}
                </option>
              ))}
            </select>
            <button
              className="mt-3 w-full rounded-lg border px-3 py-2 text-sm"
              disabled={syncing}
              onClick={() => void syncFeishu()}
            >
              <Send className="mr-2 inline h-4 w-4" />
              {syncing ? '同步中…' : '同步飞书'}
            </button>
            {detail.feishuSyncStatus && (
              <p className="mt-2 text-xs text-muted-foreground">
                状态：{detail.feishuSyncStatus.status}
                {detail.feishuSyncStatus.lastSyncedAt
                  ? ` · ${detail.feishuSyncStatus.lastSyncedAt}`
                  : ''}
                {detail.feishuSyncStatus.error
                  ? ` · ${detail.feishuSyncStatus.error}`
                  : ''}
              </p>
            )}
          </div>
          {['closed_hired', 'closed_rejected', 'closed_withdrawn'].includes(
            candidate.stage,
          ) && (
            <div className="rounded-2xl border bg-card p-4">
              <h3 className="font-medium">数据保留期</h3>
              <input
                className="mt-2 w-full rounded-lg border bg-background px-2 py-1 text-sm"
                type="datetime-local"
                aria-label="保留到期时间"
                value={retentionValue}
                onChange={(event) => setRetentionValue(event.target.value)}
              />
              <div className="mt-2 flex gap-2">
                <button
                  className="flex-1 rounded-lg border px-3 py-2 text-sm disabled:opacity-60"
                  disabled={savingRetention}
                  onClick={() =>
                    void saveRetention(
                      retentionValue
                        ? new Date(retentionValue).toISOString()
                        : null,
                    )
                  }
                >
                  {savingRetention ? '保存中…' : '保存保留期'}
                </button>
                <button
                  className="rounded-lg border px-3 py-2 text-sm"
                  disabled={savingRetention}
                  onClick={() => void saveRetention(null)}
                >
                  清除
                </button>
              </div>
              {candidate.retentionExpiresAt && (
                <p className="mt-2 text-xs text-muted-foreground">
                  到期后进入清理提示，不会自动删除。
                </p>
              )}
            </div>
          )}
          <div className="rounded-2xl border bg-card p-4">
            <h3 className="font-medium">HR 面问题</h3>
            <ol className="mt-2 space-y-2 text-sm">
              {detail.questions.map((question) => (
                <li key={question.id}>
                  <strong>{question.category}：</strong>
                  {question.question}
                  <p className="text-xs text-muted-foreground">
                    {question.rationale}
                  </p>
                </li>
              ))}
            </ol>
          </div>
          {detail.rounds.length > 0 && (
            <div className="rounded-2xl border bg-card p-4">
              <h3 className="font-medium">反馈时间线</h3>
              <div className="mt-2 space-y-3 text-sm">
                {detail.rounds.map((round) => (
                  <div key={round.id} className="rounded-lg border p-2">
                    <div className="text-xs text-muted-foreground">
                      {STAGE_LABELS[round.stage]} · {round.score ?? '未评分'}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap">
                      {round.feedbackText}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
      {hardDeleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <form
            className="w-full max-w-md rounded-2xl bg-background p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void hardDeleteCandidate();
            }}
          >
            <h3 className="text-lg font-semibold">彻底删除候选人</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              将删除简历、评分、面问题、反馈、AI
              任务和飞书同步记录；审计摘要保留。
            </p>
            <input
              className="mt-3 w-full rounded-lg border bg-background px-3 py-2 text-sm"
              placeholder={`输入完整姓名：${candidate.fullName}`}
              value={hardDeleteName}
              onChange={(event) => setHardDeleteName(event.target.value)}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border px-3 py-2 text-sm"
                disabled={deletingCandidate}
                onClick={() => setHardDeleteOpen(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className="rounded-lg bg-rose-600 px-3 py-2 text-white disabled:opacity-60"
                disabled={
                  deletingCandidate ||
                  hardDeleteName.trim() !== candidate.fullName
                }
              >
                {deletingCandidate ? '删除中…' : '永久删除'}
              </button>
            </div>
          </form>
        </div>
      )}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-2xl bg-background">
            <div className="flex items-center justify-between border-b p-3">
              <strong className="truncate">{preview.resume.fileName}</strong>
              <button
                className="rounded-lg border px-3 py-1 text-sm"
                onClick={() => {
                  if (preview.objectUrl) URL.revokeObjectURL(preview.objectUrl);
                  setPreview(null);
                }}
              >
                关闭
              </button>
            </div>
            <div className="max-h-[75vh] overflow-auto p-3">
              {preview.loading && <p>加载中…</p>}
              {preview.error && (
                <p className="text-rose-600">{preview.error}</p>
              )}
              {preview.kind === 'pdf' && preview.objectUrl && (
                <iframe
                  className="h-[70vh] w-full"
                  src={preview.objectUrl}
                  title={preview.resume.fileName}
                />
              )}
              {preview.kind === 'text' && preview.content !== null && (
                <pre className="whitespace-pre-wrap text-sm">
                  {preview.content}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="mt-5">
        <Link className="text-sm text-brand-600" to="/hr/candidates">
          返回候选人中心
        </Link>
      </div>
    </HrShell>
  );
}
