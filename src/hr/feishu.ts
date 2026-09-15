import crypto from 'node:crypto';
import { request } from 'undici';
import { getChannelAccountForUser } from '../db.js';
import { loadChannelAccountSecret } from '../channel-account-secrets.js';
import {
  getHrCandidate,
  getHrFeishuConfig,
  getHrJob,
  getHrFeishuSync,
  getLatestHrMatch,
  listHrResumesForCandidate,
  upsertHrFeishuSync,
} from './store.js';
import { HR_STAGE_LABELS, type HrFeishuConfig } from './types.js';

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

type FeishuFieldDefinition = {
  field_name?: unknown;
  type?: unknown;
};

const FEISHU_TEXT_FIELD_TYPES = new Set([1, 3, 13]);
const FEISHU_NUMBER_FIELD_TYPES = new Set([2]);
const FEISHU_DATE_FIELD_TYPES = new Set([5]);
const FEISHU_URL_FIELD_TYPES = new Set([15]);

const FEISHU_FIELD_COMPATIBILITY: Record<string, Set<number>> = {
  candidate_id: new Set([1, 3, 13]),
  full_name: new Set([1, 3]),
  job_title: new Set([1, 3]),
  stage: new Set([1, 3]),
  score: new Set([1, 2]),
  recommendation: new Set([1]),
  resume_url: new Set([1, 15]),
  source: new Set([1, 3]),
  interviewer_1: new Set([1, 3]),
  interviewer_2: new Set([1, 3]),
  interviewer_3: new Set([1, 3]),
  updated_at: new Set([1]),
};

const FEISHU_FIELD_TYPE_LABELS: Record<number, string> = {
  1: '文本',
  2: '数字',
  3: '单选',
  5: '日期',
  13: '电话',
  15: '链接',
  20: '公式',
  24: '创建时间',
  25: '修改时间',
};

const FEISHU_FIELD_EXPECTED_LABELS: Record<string, string> = {
  candidate_id: '文本/单选/电话',
  full_name: '文本/单选',
  job_title: '文本/单选',
  stage: '文本/单选',
  score: '数字/文本',
  recommendation: '文本',
  resume_url: '链接/文本',
  source: '文本/单选',
  interviewer_1: '文本/单选',
  interviewer_2: '文本/单选',
  interviewer_3: '文本/单选',
  updated_at: '文本',
};

const FIT_LEVEL_LABELS: Record<string, string> = {
  strong_fit: '强匹配',
  fit: '匹配',
  borderline: '边界匹配',
  not_fit: '不匹配',
};

export class HrFeishuError extends Error {}

export function formatFeishuUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HrFeishuError('Feishu updated_at is not a valid date');
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const year = String(parts.year ?? '0000');
  const month = String(Number(parts.month ?? '1'));
  const day = String(Number(parts.day ?? '1'));
  const hour = String(parts.hour ?? '00').padStart(2, '0');
  const minute = String(parts.minute ?? '00').padStart(2, '0');
  const second = String(parts.second ?? '00').padStart(2, '0');
  return `${year}年${month}月${day}日 ${hour}:${minute}:${second}`;
}

function isFeishuOk(body: any): boolean {
  return body && (body.code === 0 || Number(body.code) === 0);
}

async function feishuRequest(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  token: string,
  body?: unknown,
): Promise<any> {
  const response = await request(`${FEISHU_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.body.json()) as any;
  if (
    response.statusCode < 200 ||
    response.statusCode >= 300 ||
    !isFeishuOk(payload)
  ) {
    throw new HrFeishuError(
      `Feishu API ${response.statusCode}: ${payload?.msg ?? payload?.code ?? 'request failed'}`,
    );
  }
  return payload.data ?? payload;
}

async function tenantToken(appId: string, appSecret: string): Promise<string> {
  const cached = tokenCache.get(appId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const response = await request(
    `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
  );
  const payload = (await response.body.json()) as any;
  const token = String(payload?.tenant_access_token ?? '');
  const expires = Number(payload?.expire ?? 0);
  if (!isFeishuOk(payload) || !token) {
    throw new HrFeishuError(
      'Feishu credentials are invalid or missing permission',
    );
  }
  tokenCache.set(appId, {
    token,
    expiresAt: Date.now() + Math.max(expires - 300, 60) * 1000,
  });
  return token;
}

function credentialsFor(
  config: Pick<HrFeishuConfig, 'channelAccountId'>,
  ownerUserId: string,
) {
  const account = getChannelAccountForUser(
    config.channelAccountId,
    ownerUserId,
  );
  if (!account || account.provider !== 'feishu' || !account.enabled) {
    throw new HrFeishuError('Feishu channel account is unavailable');
  }
  const secret = loadChannelAccountSecret(account.secret_ref);
  const appId = secret?.appId?.trim();
  const appSecret = secret?.appSecret?.trim();
  if (!appId || !appSecret)
    throw new HrFeishuError('Feishu account credentials are incomplete');
  return { appId, appSecret };
}

export interface FeishuSyncInput {
  ownerUserId: string;
  actorId: string;
  candidateId: string;
  baseUrl: string;
}

function mappedEntry(
  config: HrFeishuConfig,
  key: string,
  value: unknown,
): { key: string; fieldName: string; value: unknown } | null {
  const fieldName = config.fieldMapping?.[key]?.trim();
  if (!fieldName) return null;
  return { key, fieldName, value };
}

function cleanSummaryText(value: unknown): string {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\.{3,}|…+/g, ' ')
    .replace(/[#*`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeRecommendation(
  recommendation: string | null,
  matchRationale?: string | null,
): string {
  const fitLabel =
    FIT_LEVEL_LABELS[String(recommendation ?? '').trim()] ??
    cleanSummaryText(recommendation);
  const hasRecognizedFitLevel = String(recommendation ?? '')
    .trim() in FIT_LEVEL_LABELS;
  const rationale = cleanSummaryText(matchRationale);
  if (!rationale) {
    return hasRecognizedFitLevel ? `匹配等级：${fitLabel}。` : fitLabel || '暂无推荐结论';
  }
  const summary = /[。！？!?]$/.test(rationale)
    ? rationale
    : `${rationale}。`;
  return `${fitLabel ? `匹配等级：${fitLabel}。` : ''}${summary}`;
}

function feishuFieldTypeLabel(type: number): string {
  return FEISHU_FIELD_TYPE_LABELS[type] ?? `类型 ${type}`;
}

function adaptFieldValue(
  key: string,
  fieldName: string,
  value: unknown,
  type: number | undefined,
): unknown | null {
  if (value === null || value === undefined || value === '') return null;
  if (type === undefined) return value;
  if (type === 20) {
    throw new HrFeishuError(
      `Feishu Bitable field "${fieldName}" is a formula field and cannot be written`,
    );
  }
  if (type === 24 || type === 25) {
    throw new HrFeishuError(
      `Feishu Bitable field "${fieldName}" is system-managed and cannot be written`,
    );
  }
  if (key === 'recommendation' && type !== 1) {
    throw new HrFeishuError(
      `Feishu Bitable field "${fieldName}" must be a text field for the recommendation, but it is ${feishuFieldTypeLabel(type)}`,
    );
  }
  if (key === 'updated_at' && type !== 1) {
    throw new HrFeishuError(
      `Feishu Bitable field "${fieldName}" must be a text field for updated_at, but it is ${feishuFieldTypeLabel(type)}`,
    );
  }
  if (FEISHU_TEXT_FIELD_TYPES.has(type)) return String(value);
  if (FEISHU_NUMBER_FIELD_TYPES.has(type)) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new HrFeishuError(
        `Feishu Bitable field "${fieldName}" is ${feishuFieldTypeLabel(type)} but value is not numeric`,
      );
    }
    return parsed;
  }
  if (FEISHU_DATE_FIELD_TYPES.has(type)) {
    const parsed =
      value instanceof Date
        ? value.getTime()
        : new Date(String(value)).getTime();
    if (!Number.isFinite(parsed)) {
      throw new HrFeishuError(
        `Feishu Bitable field "${fieldName}" is ${feishuFieldTypeLabel(type)} but value is not a valid date`,
      );
    }
    return parsed;
  }
  if (FEISHU_URL_FIELD_TYPES.has(type)) {
    const text = String(value);
    return { text, link: text };
  }
  throw new HrFeishuError(
    `Feishu Bitable field "${fieldName}" has unsupported write type ${feishuFieldTypeLabel(type)}`,
  );
}

export function candidatePayload(
  config: HrFeishuConfig,
  candidateId: string,
  fullName: string,
  jobTitle: string,
  stage: string,
  score: number | null,
  recommendation: string | null,
  resumeUrl: string | null,
  source: string,
  updatedAt: string,
  fieldDefinitions: FeishuFieldDefinition[] = [],
  matchRationale?: string | null,
  interviewers?: [string | null, string | null, string | null],
): Record<string, unknown> {
  const interviewerValues = interviewers ?? [null, null, null];
  const recommendationSummary = summarizeRecommendation(
    recommendation,
    matchRationale,
  );
  const mappedEntries = [
    mappedEntry(config, 'candidate_id', candidateId),
    mappedEntry(config, 'full_name', fullName),
    mappedEntry(config, 'job_title', jobTitle),
    mappedEntry(
      config,
      'stage',
      HR_STAGE_LABELS[stage as keyof typeof HR_STAGE_LABELS] ?? stage,
    ),
    mappedEntry(config, 'score', score),
    mappedEntry(config, 'recommendation', recommendationSummary),
    mappedEntry(config, 'resume_url', resumeUrl ?? ''),
    mappedEntry(config, 'source', source),
    mappedEntry(config, 'interviewer_1', interviewerValues[0] ?? ''),
    mappedEntry(config, 'interviewer_2', interviewerValues[1] ?? ''),
    mappedEntry(config, 'interviewer_3', interviewerValues[2] ?? ''),
    mappedEntry(config, 'updated_at', formatFeishuUpdatedAt(updatedAt)),
  ].filter(
    (entry): entry is { key: string; fieldName: string; value: unknown } =>
      entry !== null,
  );
  const fieldMap = new Map<string, FeishuFieldDefinition>(
    fieldDefinitions.flatMap(
      (field): Array<[string, FeishuFieldDefinition]> => {
        const fieldName = String(field.field_name ?? '').trim();
        return fieldName ? [[fieldName, field]] : [];
      },
    ),
  );
  const requiredField = config.fieldMapping?.candidate_id?.trim();
  if (
    requiredField &&
    fieldDefinitions.length > 0 &&
    !fieldMap.has(requiredField)
  ) {
    throw new HrFeishuError(
      `Feishu Bitable field "${requiredField}" does not exist`,
    );
  }
  const entries = mappedEntries.map((entry) => [
    entry.fieldName,
    ['resume_url', 'interviewer_1', 'interviewer_2', 'interviewer_3'].includes(entry.key)
      ? entry.value === '' ? null : entry.value
      : entry.value,
  ]);
  const adaptedEntries = mappedEntries.flatMap(
    (entry): Array<[string, unknown]> => {
      const field = fieldMap.get(entry.fieldName);
      if (!field) return [];
      const adapted = adaptFieldValue(
        entry.key,
        entry.fieldName,
        entry.value,
        Number(field.type),
      );
      if (adapted === null) {
        return ['resume_url', 'interviewer_1', 'interviewer_2', 'interviewer_3'].includes(entry.key)
          ? [[entry.fieldName, null]]
          : [];
      }
      return [[entry.fieldName, adapted]];
    },
  );
  return Object.fromEntries(fieldDefinitions.length ? adaptedEntries : entries);
}

export async function syncCandidateToFeishu(
  input: FeishuSyncInput,
): Promise<{ synced: boolean; recordId: string | null }> {
  const config = getHrFeishuConfig(input.ownerUserId);
  if (!config || !config.enabled)
    throw new HrFeishuError('Feishu sync is not configured');
  const candidate = getHrCandidate(input.ownerUserId, input.candidateId);
  if (!candidate) throw new HrFeishuError('Candidate not found');
  const job = getHrJob(input.ownerUserId, candidate.jobId);
  if (!job) throw new HrFeishuError('Job not found');
  const resume = listHrResumesForCandidate(input.ownerUserId, candidate.id)[0];
  const match = getLatestHrMatch(input.ownerUserId, candidate.id);
  const { appId, appSecret } = credentialsFor(config, input.ownerUserId);
  const token = await tenantToken(appId, appSecret);
  const fieldResponse = await feishuRequest(
    `/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}/fields?page_size=100`,
    'GET',
    token,
  );
  const payload = candidatePayload(
    config,
    candidate.id,
    candidate.fullName,
    job.title,
    candidate.stage,
    candidate.overallScore,
    candidate.recommendation,
    resume ? `${input.baseUrl}/api/hr/resumes/${resume.id}/download` : null,
    candidate.source,
    candidate.updatedAt,
    (fieldResponse?.items ?? []) as FeishuFieldDefinition[],
    match?.rationale ?? null,
    [candidate.interviewer1, candidate.interviewer2, candidate.interviewer3],
  );
  const payloadHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
  const existing = await upsertHrFeishuSync(
    input.ownerUserId,
    candidate.id,
    config.id,
  );
  if (
    existing.status === 'synced' &&
    existing.payloadHash === payloadHash &&
    existing.recordId
  ) {
    return { synced: true, recordId: existing.recordId };
  }
  const attempt = existing.attempt + 1;
  await upsertHrFeishuSync(input.ownerUserId, candidate.id, config.id, {
    status: 'pending',
    attempt,
    payloadHash,
  });
  try {
    let recordId = existing.recordId;
    if (!recordId) {
      const candidateIdField = config.fieldMapping?.candidate_id ?? '候选人ID';
      const search = await feishuRequest(
        `/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}/records/search?page_size=20`,
        'POST',
        token,
        {
          field_names: Object.keys(payload),
          filter: {
            conjunction: 'and',
            conditions: [
              {
                field_name: candidateIdField,
                operator: 'is',
                value: [candidate.id],
              },
            ],
          },
        },
      );
      recordId = search?.items?.[0]?.record_id ?? null;
    }
    if (recordId) {
      await feishuRequest(
        `/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}/records/${encodeURIComponent(recordId)}`,
        'PUT',
        token,
        { fields: payload },
      );
    } else {
      const created = await feishuRequest(
        `/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}/records?client_token=${encodeURIComponent(crypto.randomUUID())}`,
        'POST',
        token,
        { fields: payload },
      );
      recordId = created?.record?.record_id ?? null;
    }
    await upsertHrFeishuSync(input.ownerUserId, candidate.id, config.id, {
      recordId,
      payloadHash,
      status: 'synced',
      attempt,
      lastSyncedAt: new Date().toISOString(),
    });
    return { synced: true, recordId };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Feishu sync failed';
    await upsertHrFeishuSync(input.ownerUserId, candidate.id, config.id, {
      status: 'failed',
      attempt,
      error: message,
    });
    throw error;
  }
}

export async function testFeishuConfig(
  config: Pick<
    HrFeishuConfig,
    'channelAccountId' | 'appToken' | 'tableId' | 'fieldMapping'
  >,
  ownerUserId: string,
): Promise<{
  connected: boolean;
  fields: string[];
  missingFields: string[];
  typeIssues: Array<{ field: string; message: string }>;
}> {
  const { appId, appSecret } = credentialsFor(config, ownerUserId);
  const token = await tenantToken(appId, appSecret);
  const result = await feishuRequest(
    `/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}/fields?page_size=100`,
    'GET',
    token,
  );
  const definitions = (result?.items ?? []) as FeishuFieldDefinition[];
  const fields = definitions
    .map((item) => String(item.field_name ?? '').trim())
    .filter(Boolean);
  const mappedFields = [
    ...new Set(Object.values(config.fieldMapping).filter(Boolean)),
  ];
  const fieldSet = new Set(fields);
  const typeIssues = Object.entries(config.fieldMapping).flatMap(
    ([key, fieldName]) => {
      const field = definitions.find(
        (item) => String(item.field_name ?? '').trim() === fieldName,
      );
      const compatibleTypes = FEISHU_FIELD_COMPATIBILITY[key];
      const type = Number(field?.type);
      if (!field || !compatibleTypes || !Number.isFinite(type)) return [];
      if (compatibleTypes.has(type)) return [];
      return [
        {
          field: fieldName,
          message: `期望 ${FEISHU_FIELD_EXPECTED_LABELS[key] ?? '文本'}，实际为 ${feishuFieldTypeLabel(type)}`,
        },
      ];
    },
  );
  return {
    connected: true,
    fields,
    missingFields: mappedFields.filter((field) => !fieldSet.has(field)),
    typeIssues,
  };
}

export async function deleteFeishuCandidateRecord(input: {
  ownerUserId: string;
  candidateId: string;
}): Promise<{ attempted: boolean; deleted: boolean; recordId: string | null }> {
  const config = getHrFeishuConfig(input.ownerUserId);
  if (!config || !config.enabled) {
    return { attempted: false, deleted: false, recordId: null };
  }
  const sync = getHrFeishuSync(input.ownerUserId, input.candidateId);
  const candidateIdField = config.fieldMapping?.candidate_id ?? '候选人ID';
  const { appId, appSecret } = credentialsFor(config, input.ownerUserId);
  const token = await tenantToken(appId, appSecret);
  let recordId = sync?.recordId ?? null;
  if (!recordId) {
    const search = await feishuRequest(
      `/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}/records/search?page_size=20`,
      'POST',
      token,
      {
        field_names: [candidateIdField],
        filter: {
          conjunction: 'and',
          conditions: [{
            field_name: candidateIdField,
            operator: 'is',
            value: [input.candidateId],
          }],
        },
      },
    );
    recordId = search?.items?.[0]?.record_id ?? null;
  }
  if (!recordId) return { attempted: true, deleted: false, recordId: null };
  await feishuRequest(
    `/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}/records/${encodeURIComponent(recordId)}`,
    'DELETE',
    token,
  );
  return { attempted: true, deleted: true, recordId };
}
