import { describe, expect, test } from 'vitest';

import { weChatPairReply } from '../src/wechat.js';

describe('WeChat pairing replies', () => {
  test('successful pairing tells the chat it is connected', () => {
    expect(weChatPairReply(true)).toBe('配对成功，此微信会话已连接。');
    expect(weChatPairReply({ ok: true })).toBe('配对成功，此微信会话已连接。');
  });

  test('invalid or expired pairing codes ask the user to regenerate', () => {
    for (const reason of [
      'invalid',
      'expired',
      'owner_mismatch',
      'account_mismatch',
    ] as const) {
      expect(weChatPairReply({ ok: false, reason })).toBe(
        '配对码无效或已过期，请在网页设置中重新生成。',
      );
    }
  });

  test('pairing service failures ask the user to retry', () => {
    for (const reason of [
      'target_conflict',
      'workspace_missing',
      'registration_failed',
    ] as const) {
      expect(weChatPairReply({ ok: false, reason })).toBe(
        '配对失败，请稍后重试。',
      );
    }
  });
});
