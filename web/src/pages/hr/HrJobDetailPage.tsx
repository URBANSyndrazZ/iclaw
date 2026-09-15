import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { RefreshCw, Sparkles, Upload } from 'lucide-react';
import {
  AI_STATUS_LABELS,
  EmptyState,
  HR_STAGES,
  HrNotice,
  HrShell,
  STAGE_LABELS,
  scoreColor,
  formatHrDate,
  isHrJobExpired,
  type HrCandidate,
  type HrJob,
  type HrJobRule,
} from './shared';
import { hrApi } from './api';

type ResumeItem = {
  file: File;
  status: 'waiting' | 'uploading' | 'imported' | 'failed';
  message: string | null;
};

const HR_MAX_BATCH_FILES = 20;

function validateResume(file: File): string | null {
  const extension = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
  if (!['.pdf', '.doc', '.docx', '.txt', '.md'].includes(extension)) {
    return '格式不支持';
  }
  if (file.size > 10 * 1024 * 1024) return '文件超过 10MB';
  if (file.size === 0) return '文件为空';
  return null;
}

function CandidateCard({ candidate }: { candidate: HrCandidate }) {
  return (
    <Link
      to={`/hr/candidates/${candidate.id}`}
      className="block rounded-xl border border-border bg-card p-3 transition-colors hover:border-brand-300"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{candidate.fullName}</span>
        <span className={`text-sm font-semibold ${scoreColor(candidate.overallScore)}`}>
          {candidate.overallScore ?? '—'}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
        {candidate.summary || '暂无解析摘要'}
      </p>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{STAGE_LABELS[candidate.stage]}</span>
        <span className={candidate.aiStatus === 'failed' ? 'text-rose-600' : ''}>
          {AI_STATUS_LABELS[candidate.aiStatus]}
        </span>
      </div>
    </Link>
  );
}

export function HrJobDetailPage() {
  const { jobId } = useParams();
  const [job, setJob] = useState<HrJob | null>(null);
  const [candidates, setCandidates] = useState<HrCandidate[]>([]);
  const [rules, setRules] = useState<HrJobRule[]>([]);
  const [activeRule, setActiveRule] = useState<HrJobRule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ title: '', jdText: '', expiresAt: '' });
  const [savingJob, setSavingJob] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [resumeItems, setResumeItems] = useState<ResumeItem[]>([]);
  const [resumeLinkUrl, setResumeLinkUrl] = useState('');
  const [importingResumeLink, setImportingResumeLink] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);

  const load = useCallback(async () => {
    if (!jobId) return;
    const [jobData, candidateData, ruleData] = await Promise.all([
      hrApi.getJob(jobId),
      hrApi.listCandidates(),
      hrApi.listJobRules(jobId),
    ]);
    setJob(jobData.job);
    setEditForm({
      title: jobData.job.title,
      jdText: jobData.job.jdText,
      expiresAt: jobData.job.expiresAt ? jobData.job.expiresAt.slice(0, 16) : '',
    });
    setCandidates(candidateData.candidates);
    setRules(ruleData.rules);
    setActiveRule(ruleData.activeRule);
  }, [jobId]);

  useEffect(() => {
    if (!jobId) return;
    setLoading(true);
    load()
      .then(() => setError(null))
      .catch((err) => setError(err instanceof Error ? err.message : '加载失败'))
      .finally(() => setLoading(false));
  }, [jobId, load]);

  useEffect(() => {
    if (!candidates.some((candidate) => candidate.aiStatus === 'running')) return;
    const timer = setInterval(() => {
      void load().catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [candidates, load]);

  const grouped = HR_STAGES.map((stage) => ({
    stage,
    items: candidates.filter((candidate) => candidate.jobId === jobId && candidate.stage === stage),
  }));

  function selectResumes(files: File[]) {
    if (files.length > HR_MAX_BATCH_FILES) {
      setError(`每次最多选择 ${HR_MAX_BATCH_FILES} 个简历文件`);
      return;
    }
    setError(null);
    setResumeItems(files.map((file) => ({
      file,
      status: 'waiting',
      message: validateResume(file),
    })));
  }

  async function saveJob(event: React.FormEvent) {
    event.preventDefault();
    if (!jobId || savingJob) return;
    const title = editForm.title.trim();
    const jdText = editForm.jdText.trim();
    if (!title || !jdText) return;
    setSavingJob(true);
    try {
      const result = await hrApi.updateJob(jobId, {
        title,
        jd_text: jdText,
        expires_at: editForm.expiresAt ? new Date(editForm.expiresAt).toISOString() : null,
      });
      setMessage(
        result.feishu_sync.attempted
          ? `岗位已保存；飞书同步 ${result.feishu_sync.succeeded} 成功，${result.feishu_sync.failed} 失败`
          : '岗位已保存',
      );
      setEditOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '岗位保存失败');
    } finally {
      setSavingJob(false);
    }
  }

  async function analyzePending() {
    if (!jobId || analyzing) return;
    setAnalyzing(true);
    setMessage('批量分析任务已入队');
    try {
      const result = await hrApi.analyzePending(jobId);
      setMessage(`已为 ${result.queued} 名候选人创建 AI 分析任务`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量分析失败');
    } finally {
      setAnalyzing(false);
    }
  }

  async function uploadResumes() {
    if (!jobId || uploading) return;
    const valid = resumeItems.filter((item) => !item.message);
    if (!valid.length) return;
    setUploading(true);
    const byName = new Map(valid.map((item) => [item.file.name, item]));
    await hrApi.importResumes(
      jobId,
      valid.map((item) => item.file),
      (file, status, errorMessage) => {
        const item = byName.get(file.name);
        if (!item) return;
        setResumeItems((items) => items.map((current) => (
          current.file === item.file ? { ...current, status, message: errorMessage ?? null } : current
        )));
      },
    );
    setMessage('批量导入完成，请在 AI 任务页查看分析进度');
    setUploading(false);
    await load();
  }

  async function importResumeLink() {
    if (!jobId || !resumeLinkUrl.trim()) return;
    setImportingResumeLink(true);
    setMessage('正在从链接下载简历…');
    try {
      const result = await hrApi.importResumeLink(jobId, resumeLinkUrl.trim());
      setResumeLinkUrl('');
      setMessage(result.duplicate ? '简历已存在，已复用候选人' : '简历链接导入完成');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败');
    } finally {
      setImportingResumeLink(false);
    }
  }

  async function updateRule(ruleId: string, action: 'activate' | 'discard') {
    if (!jobId) return;
    try {
      await hrApi.updateJobRule(jobId, ruleId, action);
      setMessage(action === 'activate' ? '评分规则已激活' : '评分规则已废弃');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '评分规则更新失败');
    }
  }

  async function diagnose() {
    if (!jobId || diagnosing) return;
    setDiagnosing(true);
    try {
      const result = await hrApi.marketAnalysis(jobId);
      setMessage(result.analysis.summary || '岗位诊断完成');
    } catch (err) {
      setError(err instanceof Error ? err.message : '分析失败');
    } finally {
      setDiagnosing(false);
    }
  }

  if (loading) {
    return (
      <HrShell title="岗位详情" description="正在加载岗位数据">
        <EmptyState title="加载中" description="请稍候。" />
      </HrShell>
    );
  }

  if (!job) {
    return (
      <HrShell title="岗位详情" description="岗位不存在或没有访问权限">
        <EmptyState title="未找到岗位" description="请返回岗位库。" />
      </HrShell>
    );
  }

  return (
    <HrShell title={job.title} description="JD、简历导入、推面看板与评分规则">
      <HrNotice error={error} />
      {message && (
        <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          {message}
        </div>
      )}
      <div className="space-y-4">
        <section className="rounded-2xl border bg-card p-4">
          <p className="text-sm text-muted-foreground">
            {job.department || '未设置部门'} · {job.location || '未设置地点'} · {job.salaryRange || '薪酬未设置'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            截止：{formatHrDate(job.expiresAt)}
            {isHrJobExpired(job) && <span className="ml-2 text-amber-700">已过期</span>}
          </p>
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-muted/40 p-3 text-sm">
            {job.jdText}
          </pre>
          {editOpen && (
            <form className="mt-3 space-y-2" onSubmit={saveJob}>
              <input
                className="w-full rounded-lg border bg-background p-2 text-sm"
                value={editForm.title}
                onChange={(event) => setEditForm((prev) => ({ ...prev, title: event.target.value }))}
              />
              <textarea
                className="min-h-48 w-full rounded-lg border bg-background p-3 text-sm"
                value={editForm.jdText}
                onChange={(event) => setEditForm((prev) => ({ ...prev, jdText: event.target.value }))}
              />
              <input
                className="w-full rounded-lg border bg-background p-2 text-sm"
                type="datetime-local"
                aria-label="招聘截止时间"
                value={editForm.expiresAt}
                onChange={(event) => setEditForm((prev) => ({ ...prev, expiresAt: event.target.value }))}
              />
              <div className="flex gap-2">
                <button className="rounded-lg bg-brand-600 px-3 py-2 text-sm text-white" disabled={savingJob}>
                  {savingJob ? '保存中…' : '保存 JD'}
                </button>
                <button type="button" className="rounded-lg border px-3 py-2 text-sm" onClick={() => setEditOpen(false)}>
                  取消
                </button>
              </div>
            </form>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => void diagnose()} disabled={diagnosing}>
              <RefreshCw className="mr-2 inline h-4 w-4" />
              {diagnosing ? '诊断中…' : '岗位诊断'}
            </button>
            <button
              className="rounded-lg border px-3 py-2 text-sm"
              onClick={() => {
                setEditOpen((prev) => !prev);
                setEditForm({
                  title: job.title,
                  jdText: job.jdText,
                  expiresAt: job.expiresAt ? job.expiresAt.slice(0, 16) : '',
                });
              }}
            >
              {editOpen ? '取消编辑 JD' : '编辑 JD'}
            </button>
            <button className="rounded-lg bg-brand-600 px-3 py-2 text-sm text-white" disabled={analyzing} onClick={() => void analyzePending()}>
              <Sparkles className="mr-2 inline h-4 w-4" />
              {analyzing ? '任务入队中…' : '批量 AI 分析待评估'}
            </button>
          </div>
        </section>

        <section className="rounded-2xl border bg-card p-4">
          <h2 className="font-medium">导入简历</h2>
          <input
            className="mt-2 w-full rounded-lg border bg-background p-2 text-sm"
            placeholder="候选人简历链接（https://...）"
            type="url"
            value={resumeLinkUrl}
            onChange={(event) => setResumeLinkUrl(event.target.value)}
          />
          <div className="mt-3 rounded-xl border-2 border-dashed p-4 text-center">
            <p className="text-sm text-muted-foreground">拖拽或点击下方按钮选择简历</p>
            <label className="mt-3 inline-flex cursor-pointer items-center justify-center rounded-lg border bg-background px-3 py-2 text-sm">
              选择简历
              <input
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.txt,.md"
                className="hidden"
                onChange={(event) => {
                  selectResumes(Array.from(event.target.files ?? []));
                  event.target.value = '';
                }}
              />
            </label>
          </div>
          {resumeItems.length > 0 && (
            <div className="mt-3 max-h-48 space-y-2 overflow-y-auto rounded-lg border bg-background p-2">
              {resumeItems.map((item) => (
                <div key={item.file.name + item.file.size} className="flex items-start justify-between gap-2 text-sm">
                  <p className="truncate">{item.file.name}</p>
                  <span className={item.status === 'imported' ? 'text-emerald-600' : item.status === 'failed' ? 'text-rose-600' : 'text-muted-foreground'}>
                    {item.status === 'uploading' ? '上传中' : item.status === 'imported' ? '已导入' : item.status === 'failed' ? '导入失败' : item.message || '等待中'}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded-lg bg-brand-600 px-3 py-2 text-white disabled:opacity-60"
              disabled={uploading || !resumeItems.some((item) => !item.message)}
              onClick={() => void uploadResumes()}
            >
              <Upload className="mr-2 inline h-4 w-4" />
              {uploading ? '导入中…' : '批量上传'}
            </button>
            <button
              className="rounded-lg bg-brand-600 px-3 py-2 text-white disabled:opacity-60"
              disabled={importingResumeLink || !resumeLinkUrl.trim()}
              onClick={() => void importResumeLink()}
            >
              {importingResumeLink ? '导入中…' : 'HTTPS 链接导入'}
            </button>
            {resumeItems.length > 0 && !uploading && (
              <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => setResumeItems([])}>清空清单</button>
            )}
          </div>
        </section>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
          {grouped.map(({ stage, items }) => (
            <div key={stage} className="rounded-2xl border bg-card p-3">
              <h3 className="mb-2 text-sm font-medium">
                {STAGE_LABELS[stage]} · {items.length}
              </h3>
              <div className="space-y-2">
                {items.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} />)}
              </div>
            </div>
          ))}
        </div>

        <section className="rounded-2xl border bg-card p-4">
          <h2 className="font-medium">AI 评分规则版本</h2>
          {activeRule ? (
            <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              当前生效：v{activeRule.ruleVersion} · {activeRule.summary}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">暂无已激活规则，当前评分以原始 JD 为准。</p>
          )}
          <div className="mt-3 space-y-2">
            {rules.map((rule) => (
              <div key={rule.id} className="rounded-xl border p-3 text-sm">
                <div className="flex items-center justify-between">
                  <strong>v{rule.ruleVersion} · {rule.status}</strong>
                  {rule.status === 'draft' && (
                    <span className="flex gap-2">
                      <button className="rounded-lg border px-2 py-1 text-xs" onClick={() => void updateRule(rule.id, 'activate')}>激活</button>
                      <button className="rounded-lg border px-2 py-1 text-xs" onClick={() => void updateRule(rule.id, 'discard')}>废弃</button>
                    </span>
                  )}
                </div>
                <p className="mt-1">{rule.summary}</p>
                {(rule.newRequirements.length > 0 || rule.jdGaps.length > 0 || rule.contradictions.length > 0) && (
                  <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {rule.newRequirements.length > 0 && <p>新增考察：{rule.newRequirements.join('、')}</p>}
                    {rule.jdGaps.length > 0 && <p>JD 缺口：{rule.jdGaps.join('、')}</p>}
                    {rule.contradictions.length > 0 && <p>矛盾点：{rule.contradictions.join('、')}</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
      <div className="mt-5">
        <Link className="text-sm text-brand-600" to="/hr/jobs">返回岗位库</Link>
      </div>
    </HrShell>
  );
}
