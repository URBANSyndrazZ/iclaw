import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { hrApi } from './api';
import {
  EmptyState,
  HrNotice,
  HrPagination,
  HrShell,
  hrPaginationState,
  STAGE_LABELS,
} from './shared';

type QuestionItem = {
  question: {
    id: string;
    category: string;
    question: string;
    rationale: string;
    expectedSignal: string;
    priority: number;
  };
  candidate: { id: string; fullName: string; stage: string };
  jobTitle: string;
};

export function HrQuestionsPage() {
  const [items, setItems] = useState<QuestionItem[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await hrApi.questionLibrary<QuestionItem>({
      page: pagination.page,
      pageSize: pagination.pageSize,
      search,
      category: category === 'all' ? undefined : category,
    });
    const questionItems = Array.isArray(data.items) ? data.items : [];
    if (
      questionItems.length === 0 &&
      (data.page ?? 1) > 1 &&
      (data.total ?? 0) > 0
    ) {
      setPagination((prev) => ({
        ...prev,
        page: Math.min(data.total_pages, data.page - 1),
      }));
      return;
    }
    setItems(questionItems);
    const questionCategories = Array.isArray(data.categories) && data.categories.length
      ? data.categories
      : [...new Set(questionItems.map((item) => item.question.category))];
    setCategories(questionCategories);
    setPagination(hrPaginationState(data, questionItems.length));
  }, [category, pagination.page, pagination.pageSize, search]);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : '加载失败'))
      .finally(() => setLoading(false));
  }, [load]);

  const filtered = items;

  function updateSearch(value: string) {
    setSearch(value);
    setPagination((prev) => ({ ...prev, page: 1 }));
  }

  function updateCategory(value: string) {
    setCategory(value);
    setPagination((prev) => ({ ...prev, page: 1 }));
  }

  function updatePage(page: number) {
    setPagination((prev) => ({ ...prev, page }));
  }

  function updatePageSize(pageSize: number) {
    setPagination((prev) => ({ ...prev, pageSize, page: 1 }));
  }

  return (
    <HrShell title="面试问题库" description="聚合 AI 生成的 HR 面问题和追问理由">
      <HrNotice error={error} />
      <section className="mb-4 grid gap-3 rounded-2xl border bg-card p-4 sm:grid-cols-[2fr_1fr]">
        <input className="rounded-lg border bg-background p-2 text-sm" placeholder="搜索问题或候选人" value={search} onChange={(event) => updateSearch(event.target.value)} />
        <select className="rounded-lg border bg-background p-2 text-sm" value={category} onChange={(event) => updateCategory(event.target.value)}>
          <option value="all">全部类型</option>
          {categories.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </section>
      <div className="min-h-[320px]">
        {items.length === 0 && !loading ? (
          <EmptyState title="没有匹配数据" description="候选人完成 AI 匹配后，生成的 HR 面问题会在这里聚合。" />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {filtered.map((item) => (
              <article key={item.question.id} className="rounded-2xl border bg-card p-4">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{item.question.category}</span>
                  <span>优先级 {item.question.priority}</span>
                </div>
                <p className="mt-2 font-medium">{item.question.question}</p>
                <p className="mt-2 text-sm text-muted-foreground">{item.question.rationale}</p>
                <p className="mt-2 text-sm">关注信号：{item.question.expectedSignal}</p>
                <div className="mt-3 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{item.candidate.fullName} · {item.jobTitle}</span>
                  <Link className="text-brand-600" to={`/hr/candidates/${item.candidate.id}`}>查看</Link>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">当前阶段：{STAGE_LABELS[item.candidate.stage]}</p>
              </article>
            ))}
          </div>
        )}
        <HrPagination
          page={pagination.page}
          pageSize={pagination.pageSize}
          total={pagination.total}
          totalPages={pagination.totalPages}
          disabled={loading}
          onPageChange={updatePage}
          onPageSizeChange={updatePageSize}
        />
      </div>
    </HrShell>
  );
}
