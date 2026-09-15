import { detectImageMimeTypeFromBase64Strict } from './image-detector.js';

export interface ImageAttachmentInput {
  type?: unknown;
  data?: unknown;
  mimeType?: unknown;
}

export interface NormalizedImageAttachment {
  type: 'image';
  data: string;
  mimeType: string;
}

interface NormalizeOptions {
  onMimeMismatch?: (ctx: {
    declaredMime: string;
    detectedMime: string;
  }) => void;
}

const DATA_URL_BASE64_RE = /^\s*data:([^;,]+);base64,(.*)\s*$/is;

function normalizeImageMimeType(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const lowered = raw.trim().toLowerCase();
  if (!lowered.startsWith('image/')) return undefined;
  return lowered;
}

function unwrapBase64Payload(raw: string): {
  base64: string;
  hintedMime?: string;
} {
  const match = DATA_URL_BASE64_RE.exec(raw);
  if (!match) return { base64: raw.replace(/\s+/g, '') };
  return {
    hintedMime: normalizeImageMimeType(match[1]),
    base64: match[2].replace(/\s+/g, ''),
  };
}

function resolveImageMimeType(
  declaredMime: string | undefined,
  detectedMime: string | null,
  options?: NormalizeOptions,
): string {
  if (declaredMime && detectedMime && declaredMime !== detectedMime) {
    options?.onMimeMismatch?.({ declaredMime, detectedMime });
    return detectedMime;
  }
  if (declaredMime) return declaredMime;
  if (detectedMime) return detectedMime;
  return 'image/jpeg';
}

export function normalizeImageAttachment(
  input: ImageAttachmentInput,
  options?: NormalizeOptions,
): NormalizedImageAttachment | null {
  // 历史附件数据可能缺少 type 字段，缺失时默认视为 image
  if ((input.type ?? 'image') !== 'image') return null;
  if (typeof input.data !== 'string' || input.data.length === 0) return null;

  const { base64, hintedMime } = unwrapBase64Payload(input.data);
  if (base64.length === 0) return null;

  const declared = normalizeImageMimeType(input.mimeType) || hintedMime;
  const detected = detectImageMimeTypeFromBase64Strict(base64);
  const mimeType = resolveImageMimeType(declared, detected, options);

  return {
    type: 'image',
    data: base64,
    mimeType,
  };
}

export function normalizeImageAttachments(
  inputs: unknown,
  options?: NormalizeOptions,
): NormalizedImageAttachment[] {
  if (!Array.isArray(inputs)) return [];
  const normalized: NormalizedImageAttachment[] = [];
  for (const item of inputs) {
    if (!item || typeof item !== 'object') continue;
    const out = normalizeImageAttachment(item as ImageAttachmentInput, options);
    if (out) normalized.push(out);
  }
  return normalized;
}

export function toAgentImages(
  attachments:
    | Array<NormalizedImageAttachment | NormalizedDocumentAttachment>
    | undefined,
): Array<{ data: string; mimeType: string }> | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments
    .filter((att): att is NormalizedImageAttachment => att.type === 'image')
    .map((att) => ({
      data: att.data,
      mimeType: att.mimeType,
    }));
}

export interface DocumentAttachmentInput {
  type?: unknown;
  attachmentId?: unknown;
  name?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
}

export interface NormalizedDocumentAttachment {
  type: 'document';
  attachmentId: string;
  name: string;
  mimeType?: string;
  sizeBytes: number;
}

const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.txt', '.md']);
const DOCUMENT_MIME_EXTENSIONS = new Map<string, string[]>([
  ['application/pdf', ['.pdf']],
  ['application/msword', ['.doc']],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ['.docx'],
  ],
  ['text/plain', ['.txt', '.md']],
  ['text/markdown', ['.md']],
  ['text/x-markdown', ['.md']],
]);
const DOCUMENT_ATTACHMENT_ID_RE = /^[0-9a-f-]{36}\.(pdf|doc|docx|txt|md)$/;

function normalizeDocumentMime(
  raw: unknown,
  extension: string,
): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const mimeType = raw.split(';', 1)[0]?.trim().toLowerCase();
  if (!mimeType) return undefined;
  const allowed = DOCUMENT_MIME_EXTENSIONS.get(mimeType);
  return allowed?.includes(extension) ? mimeType : undefined;
}

export function normalizeDocumentAttachment(
  input: DocumentAttachmentInput,
): NormalizedDocumentAttachment | null {
  if (input.type !== 'document') return null;
  const attachmentId =
    typeof input.attachmentId === 'string' ? input.attachmentId.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const sizeBytes = Number(input.sizeBytes);
  if (!DOCUMENT_ATTACHMENT_ID_RE.test(attachmentId) || !name) return null;
  const extension = attachmentId
    .slice(attachmentId.lastIndexOf('.'))
    .toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(extension) || !Number.isInteger(sizeBytes)) {
    return null;
  }
  if (sizeBytes <= 0 || sizeBytes > 10 * 1024 * 1024) return null;
  const mimeType = normalizeDocumentMime(input.mimeType, extension);
  if (input.mimeType && !mimeType) return null;
  return {
    type: 'document',
    attachmentId,
    name: name.slice(0, 255),
    ...(mimeType ? { mimeType } : {}),
    sizeBytes,
  };
}

export function normalizeMessageAttachments(
  inputs: unknown,
  options?: NormalizeOptions,
): Array<NormalizedImageAttachment | NormalizedDocumentAttachment> {
  if (!Array.isArray(inputs)) return [];
  const normalized: Array<
    NormalizedImageAttachment | NormalizedDocumentAttachment
  > = [];
  for (const item of inputs) {
    if (!item || typeof item !== 'object') continue;
    const record = item as DocumentAttachmentInput;
    if (record.type === 'document') {
      const document = normalizeDocumentAttachment(record);
      if (document) normalized.push(document);
      continue;
    }
    const image = normalizeImageAttachment(
      item as ImageAttachmentInput,
      options,
    );
    if (image) normalized.push(image);
  }
  return normalized;
}
