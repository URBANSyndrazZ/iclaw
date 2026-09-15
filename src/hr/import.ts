import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { extractFileText } from '../file-text-extractor.js';
import type { HrResumeLinkImportInput } from './schemas.js';
import {
  createHrCandidate,
  createHrResume,
  getHrCandidate,
  listHrCandidates,
  listHrResumesForCandidate,
} from './store.js';
import type {
  HrCandidate,
  HrCandidateSource,
  HrJob,
  HrResume,
} from './types.js';

export const HR_RESUME_MAX_BYTES = 10 * 1024 * 1024;
const HR_RESUME_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.txt', '.md']);
const HR_RESUME_PARSER_VERSION = 'iclaw-hr-v1';
const HR_LINK_TIMEOUT_MS = 30_000;
const HR_LINK_MAX_REDIRECTS = 3;
const HR_LINK_MIME_EXTENSIONS = new Map<string, string>([
  ['application/pdf', '.pdf'],
  ['application/msword', '.doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['text/plain', '.txt'],
  ['text/markdown', '.md'],
  ['text/x-markdown', '.md'],
]);
export class HrImportError extends Error {}

const HR_FILENAME_NOISE = /(?:^|[\s._-]+)(?:个人简历|简历|resume|cv|候选人)(?=$|[\s._-]+)/gi;
const HR_FILENAME_DATE = /\b\d{4}[-_.]?\d{1,2}[-_.]?\d{1,2}\b|\b\d{1,2}[-_.]\d{1,2}[-_.]\d{4}\b|\d{4}[-_年]\d{1,2}(?:[-_月]\d{1,2}日?)?/g;
const HR_FILENAME_LONG_NUMBER = /(?:[0-9a-f]{8,}|\d{5,})/gi;
const HR_FILENAME_VERSION = /(?:^|[\s._-]+)(?:v\d+(?:\.\d+)*|final|最新)(?=$|[\s._-]+)/gi;
const HR_FILENAME_EMAIL = /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g;

export function cleanResumeFileName(fileName: string): string {
  const original = path.parse(fileName).name;
  const cleaned = original
    .replace(HR_FILENAME_EMAIL, ' ')
    .replace(HR_FILENAME_DATE, ' ')
    .replace(HR_FILENAME_LONG_NUMBER, ' ')
    .replace(HR_FILENAME_VERSION, ' ')
    .replace(HR_FILENAME_NOISE, ' ')
    .replace(/[\s._/-]+/g, ' ')
    .trim();
  return cleaned || original.trim() || '未命名候选人';
}

function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180);
}

function assertResumeFile(name: string, buffer: Buffer): void {
  if (buffer.byteLength === 0) throw new HrImportError('Resume file is empty');
  if (buffer.byteLength > HR_RESUME_MAX_BYTES)
    throw new HrImportError('Resume file exceeds 10MB');
  const extension = path.extname(name).toLowerCase();
  if (!HR_RESUME_EXTENSIONS.has(extension))
    throw new HrImportError('Unsupported resume file type');
}

function assertResumeMimeType(fileName: string, mimeType: string | null): void {
  const extension = path.extname(fileName).toLowerCase();
  if (!HR_RESUME_EXTENSIONS.has(extension))
    throw new HrImportError('Unsupported resume file type');
  const normalized = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  if (!normalized || normalized === 'application/octet-stream') return;
  if (!HR_LINK_MIME_EXTENSIONS.has(normalized)) {
    throw new HrImportError('Unsupported resume URL content type');
  }
  const expected = HR_LINK_MIME_EXTENSIONS.get(normalized);
  if (expected && expected !== extension) {
    throw new HrImportError('Resume URL content type does not match the file name');
  }
}

function isPrivateIp(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (version === 6) {
    const value = address.toLowerCase();
    return (
      value === '::' ||
      value === '::1' ||
      value.startsWith('fc') ||
      value.startsWith('fd') ||
      value.startsWith('fe8') ||
      value.startsWith('fe9') ||
      value.startsWith('fea') ||
      value.startsWith('feb') ||
      value.startsWith('ff')
    );
  }
  return true;
}

function assertPublicHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HrImportError('Resume URL is invalid');
  }
  if (url.protocol !== 'https:') {
    throw new HrImportError('Resume URL must use HTTPS');
  }
  if (url.port && url.port !== '443') {
    throw new HrImportError('Resume URL must use port 443');
  }
  if (net.isIP(url.hostname) && isPrivateIp(url.hostname)) {
    throw new HrImportError('Resume URL host is not allowed');
  }
  return url;
}

async function assertPublicDns(hostname: string): Promise<void> {
  if (net.isIP(hostname)) return;
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0 || records.some((record) => isPrivateIp(record.address))) {
    throw new HrImportError('Resume URL host is not allowed');
  }
}

function fileNameFromResponse(url: URL, disposition: string | null, contentType: string | null): string {
  const dispositionName = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition ?? '')?.[1];
  if (dispositionName) {
    try {
      return decodeURIComponent(dispositionName.replace(/"/g, ''));
    } catch {
      return dispositionName.replace(/"/g, '');
    }
  }
  const basename = path.basename(decodeURIComponent(url.pathname));
  if (path.extname(basename)) return basename;
  const normalizedType = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const extension = HR_LINK_MIME_EXTENSIONS.get(normalizedType) ?? '.pdf';
  return `${crypto.randomUUID()}${extension}`;
}

async function downloadResume(input: HrResumeLinkImportInput): Promise<{
  content: Buffer;
  fileName: string;
  mimeType: string | null;
  sourceUrl: string;
}> {
  let currentUrl = assertPublicHttpsUrl(input.source_url);
  for (let redirect = 0; redirect <= HR_LINK_MAX_REDIRECTS; redirect += 1) {
    await assertPublicDns(currentUrl.hostname);
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(HR_LINK_TIMEOUT_MS),
        headers: { accept: Object.keys(HR_LINK_MIME_EXTENSIONS).join(', ') },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new HrImportError('Resume URL request timed out');
      }
      throw new HrImportError('Resume URL request failed');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new HrImportError('Resume URL redirect has no target');
      if (redirect === HR_LINK_MAX_REDIRECTS) {
        throw new HrImportError('Resume URL redirects too many times');
      }
      currentUrl = assertPublicHttpsUrl(new URL(location, currentUrl).toString());
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) {
      throw new HrImportError(`Resume URL returned HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > HR_RESUME_MAX_BYTES) {
      throw new HrImportError('Resume file exceeds 10MB');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += data.byteLength;
      if (size > HR_RESUME_MAX_BYTES) {
        throw new HrImportError('Resume file exceeds 10MB');
      }
      chunks.push(data);
    }
    const content = Buffer.concat(chunks);
    const contentType = response.headers.get('content-type');
    const fileName = safeName(
      fileNameFromResponse(currentUrl, response.headers.get('content-disposition'), contentType),
    );
    assertResumeMimeType(fileName, contentType);
    assertResumeFile(fileName, content);
    return {
      content,
      fileName,
      mimeType: contentType,
      sourceUrl: currentUrl.toString(),
    };
  }
  throw new HrImportError('Resume URL redirects too many times');
}

export interface IngestResumeInput {
  ownerUserId: string;
  actorId: string;
  job: HrJob;
  fileName: string;
  mimeType?: string | null;
  content: Buffer;
  source: HrCandidateSource;
  sourceUrl?: string | null;
  candidate?: HrResumeLinkImportInput['candidate'];
  candidateId?: string;
}

export interface IngestResumeResult {
  candidate: HrCandidate;
  resume: HrResume;
  analysisError: string | null;
  duplicate?: boolean;
}

function normalizedEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase();
  return email ? email : null;
}

function normalizedPhone(value: string | null | undefined): string | null {
  const phone = value?.replace(/\D/g, '');
  return phone && phone.length >= 7 ? phone : null;
}

function findDuplicateCandidate(
  input: IngestResumeInput,
  sha256: string,
): HrCandidate | undefined {
  const email = normalizedEmail(input.candidate?.email);
  const phone = normalizedPhone(input.candidate?.phone);
  return listHrCandidates(input.ownerUserId, {
    jobId: input.job.id,
    limit: 500,
  }).find((candidate) => {
    if (email && normalizedEmail(candidate.email) === email) return true;
    if (phone && normalizedPhone(candidate.phone) === phone) return true;
    return listHrResumesForCandidate(input.ownerUserId, candidate.id).some(
      (resume) => resume.sha256 === sha256,
    );
  });
}

export async function ingestResume(
  input: IngestResumeInput,
): Promise<IngestResumeResult> {
  assertResumeFile(input.fileName, input.content);
  const sha256 = crypto
    .createHash('sha256')
    .update(input.content)
    .digest('hex');
  const targetCandidate = input.candidateId
    ? getHrCandidate(input.ownerUserId, input.candidateId)
    : undefined;
  if (input.candidateId && !targetCandidate) {
    throw new HrImportError('Target candidate not found');
  }
  const duplicate = input.candidateId
    ? undefined
    : findDuplicateCandidate(input, sha256);
  const candidate =
    targetCandidate ??
    duplicate ??
    createHrCandidate({
      ownerUserId: input.ownerUserId,
      jobId: input.job.id,
      fullName: input.candidate?.full_name ?? cleanResumeFileName(input.fileName),
      fullNameSource: input.candidate?.full_name ? 'provided' : 'filename',
      email: input.candidate?.email ?? null,
      phone: input.candidate?.phone ?? null,
      location: input.candidate?.location ?? null,
      source: input.source,
      sourceUrl: input.sourceUrl ?? null,
      yearsExperience: null,
      summary: null,
      recommendation: null,
      overallScore: null,
      profile: null,
    });
  const extension = path.extname(input.fileName).toLowerCase();
  const resumeDir = path.join(
    DATA_DIR,
    'hr',
    'resumes',
    input.ownerUserId,
    candidate.id,
  );
  await fs.mkdir(resumeDir, { recursive: true });
  const storedName = `${crypto.randomUUID()}${extension}`;
  const filePath = path.join(resumeDir, storedName);
  await fs.writeFile(filePath, input.content, { mode: 0o600 });
  const extracted = await extractFileText(filePath);
  const resume = createHrResume({
    ownerUserId: input.ownerUserId,
    candidateId: candidate.id,
    jobId: input.job.id,
    filePath,
    fileName: safeName(input.fileName),
    mimeType: input.mimeType ?? null,
    sizeBytes: input.content.byteLength,
    sha256,
    extractedText: extracted?.text ?? null,
    parserVersion: HR_RESUME_PARSER_VERSION,
    parseStatus: extracted ? 'pending' : 'unsupported',
  });
  return {
    candidate,
    resume,
    analysisError: null,
    duplicate: Boolean(duplicate),
  };
}

export async function importResumeFromLink(
  ownerUserId: string,
  actorId: string,
  job: HrJob,
  input: HrResumeLinkImportInput,
): Promise<IngestResumeResult> {
  const downloaded = await downloadResume(input);
  return ingestResume({
    ownerUserId,
    actorId,
    job,
    fileName: downloaded.fileName,
    mimeType: downloaded.mimeType,
    content: downloaded.content,
    source: 'link',
    sourceUrl: downloaded.sourceUrl,
    candidate: input.candidate
      ? {
          ...input.candidate,
          full_name: input.candidate.full_name ?? path.parse(downloaded.fileName).name,
        }
      : undefined,
  });
}
