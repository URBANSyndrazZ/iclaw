import { describe, expect, test } from 'vitest';
import { HrFeishuConfigSchema } from '../src/hr/schemas.js';

const baseConfig = {
  channel_account_id: 'account-1',
  app_token: 'bascn123',
  table_id: 'tbl123',
  field_mapping: {
    candidate_id: '候选人ID',
    full_name: '候选人',
    job_title: '岗位',
    stage: '阶段',
    score: '评分',
    recommendation: '推荐结论',
    resume_url: '简历链接',
    source: '来源',
    updated_at: '更新时间',
  },
  enabled: true,
};

describe('HR Feishu config schema', () => {
  test('accepts a complete Bitable mapping', () => {
    expect(HrFeishuConfigSchema.safeParse(baseConfig).success).toBe(true);
  });

  test('requires the external unique candidate id mapping', () => {
    const parsed = HrFeishuConfigSchema.safeParse({
      ...baseConfig,
      field_mapping: { ...baseConfig.field_mapping, candidate_id: '' },
    });
    expect(parsed.success).toBe(false);
  });
});
