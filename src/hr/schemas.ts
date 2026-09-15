import { z } from 'zod';
import { HR_STAGES } from './types.js';

const HR_INTERVIEW_STAGES = [
  'interview_1',
  'interview_2',
  'interview_3',
] as const;

export const HrJobCreateSchema = z.object({
  title: z.string().trim().min(1).max(160),
  department: z.string().trim().max(120).nullable().optional(),
  location: z.string().trim().max(160).nullable().optional(),
  level: z.string().trim().max(80).nullable().optional(),
  salary_range: z.string().trim().max(120).nullable().optional(),
  status: z.enum(['active', 'paused', 'closed']).optional().default('active'),
  expires_at: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional()
    .default(null),
  jd_text: z.string().min(1).max(60000),
  keywords: z
    .array(z.string().trim().min(1).max(80))
    .max(100)
    .optional()
    .default([]),
  responsibilities: z
    .array(z.string().trim().min(1).max(300))
    .max(100)
    .optional()
    .default([]),
  requirements: z
    .array(z.string().trim().min(1).max(300))
    .max(100)
    .optional()
    .default([]),
  preferred: z
    .array(z.string().trim().min(1).max(300))
    .max(100)
    .optional()
    .default([]),
  tech_stack: z
    .array(z.string().trim().min(1).max(80))
    .max(100)
    .optional()
    .default([]),
});

export const HrJobUpdateSchema = HrJobCreateSchema.partial();

export const HrCandidateUpdateSchema = z.object({
  full_name: z.string().trim().min(1).max(160).optional(),
  email: z.string().trim().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  location: z.string().trim().max(160).nullable().optional(),
  stage: z.enum(HR_STAGES).optional(),
  talent_pool: z.boolean().optional(),
  source_url: z.string().trim().max(1024).nullable().optional(),
  interviewer_1: z.string().trim().max(120).nullable().optional(),
  interviewer_2: z.string().trim().max(120).nullable().optional(),
  interviewer_3: z.string().trim().max(120).nullable().optional(),
  retention_expires_at: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional(),
});

export const HrCandidateHardDeleteSchema = z.object({
  confirm_full_name: z.string().trim().min(1).max(160),
});

const HrFeishuFieldMappingSchema = z
  .strictObject({
    candidate_id: z.string().trim().min(1).max(120),
    full_name: z.string().trim().max(120).optional(),
    job_title: z.string().trim().max(120).optional(),
    stage: z.string().trim().max(120).optional(),
    score: z.string().trim().max(120).optional(),
    recommendation: z.string().trim().max(120).optional(),
    resume_url: z.string().trim().max(120).optional(),
    source: z.string().trim().max(120).optional(),
    interviewer_1: z.string().trim().max(120).optional(),
    interviewer_2: z.string().trim().max(120).optional(),
    interviewer_3: z.string().trim().max(120).optional(),
    updated_at: z.string().trim().max(120).optional(),
  })
  .default({
    candidate_id: '候选人ID',
    full_name: '候选人',
    job_title: '岗位',
    stage: '阶段',
    score: '评分',
    recommendation: '推荐结论',
    resume_url: '简历链接',
    source: '来源',
    updated_at: '更新时间',
  });

export const HrFeishuConfigSchema = z.object({
  channel_account_id: z.string().trim().min(1).max(128),
  app_token: z.string().trim().min(1).max(256),
  table_id: z.string().trim().min(1).max(256),
  field_mapping: HrFeishuFieldMappingSchema,
  enabled: z.boolean().optional().default(true),
});

export const HrFeedbackSchema = z.object({
  stage: z.enum(HR_INTERVIEW_STAGES),
  interviewer: z.string().trim().max(120).nullable().optional(),
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
  completed_at: z.string().datetime({ offset: true }).nullable().optional(),
  outcome: z.enum(['pass', 'reject', 'hold']).nullable().optional(),
  feedback_text: z.string().min(1).max(30000),
});

export const HrResumeLinkImportSchema = z.object({
  job_id: z.string().trim().min(1).max(128),
  candidate: z
    .object({
      full_name: z.string().trim().min(1).max(160),
      email: z.string().trim().max(254).nullable().optional(),
      phone: z.string().trim().max(40).nullable().optional(),
      location: z.string().trim().max(160).nullable().optional(),
    })
    .optional(),
  source_url: z.string().trim().min(1).max(1024).url().startsWith('https://'),
});

export type HrJobCreateInput = z.infer<typeof HrJobCreateSchema>;
export type HrJobUpdateInput = z.infer<typeof HrJobUpdateSchema>;
export type HrCandidateUpdateInput = z.infer<typeof HrCandidateUpdateSchema>;
export type HrFeishuConfigInput = z.infer<typeof HrFeishuConfigSchema>;
export type HrFeedbackInput = z.infer<typeof HrFeedbackSchema>;
export type HrResumeLinkImportInput = z.infer<
  typeof HrResumeLinkImportSchema
>;
