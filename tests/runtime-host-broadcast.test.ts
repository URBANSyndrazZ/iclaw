import { afterEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  clients: new Map<any, any>(),
  sessions: new Map<string, any>(),
}));

vi.mock('../src/web-context.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    wsClients: harness.clients,
    getCachedSessionWithUser: (sessionId: string) =>
      harness.sessions.get(sessionId),
    invalidateSessionCache: vi.fn(),
  };
});

vi.mock('../src/group-broadcast-acl.js', () => ({
  getGroupAllowedUserIds: vi.fn(() => new Set(['member-owner'])),
}));

vi.mock('../src/db.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    getRegisteredGroup: vi.fn((jid: string) =>
      jid === 'web:member-home'
        ? {
            jid,
            execution_mode: 'host',
            executionMode: 'host',
            created_by: 'member-owner',
            is_home: true,
          }
        : undefined,
    ),
  };
});

const { broadcastNewMessage, broadcastRunStarted } =
  await import('../src/web.js');

function addClient(sessionId: string, userId: string, role = 'member') {
  const client = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
  };
  harness.sessions.set(sessionId, {
    user_id: userId,
    role,
    status: 'active',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  harness.clients.set(client, { sessionId });
  return client;
}

afterEach(() => {
  harness.clients.clear();
  harness.sessions.clear();
  delete process.env.ICLAW_SINGLE_HOST_MODE;
});

describe('single-host workspace WebSocket broadcasts', () => {
  test('active member owner receives host runtime events only when enabled', () => {
    const owner = addClient('session-owner', 'member-owner');
    const outsider = addClient('session-other', 'member-other');
    process.env.ICLAW_SINGLE_HOST_MODE = 'true';

    broadcastNewMessage('web:member-home', {
      id: 'message-1',
      chat_jid: 'web:member-home',
      sender: 'member-owner',
      sender_name: 'member',
      content: 'hello',
      timestamp: '2026-09-10T00:00:00.000Z',
      is_from_me: false,
    });

    expect(owner.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(owner.send.mock.calls[0][0])).toMatchObject({
      type: 'new_message',
      chatJid: 'web:member-home',
      message: { id: 'message-1' },
    });
    expect(outsider.send).not.toHaveBeenCalled();
  });

  test('member owner does not receive host runtime events when mode is disabled', () => {
    const owner = addClient('session-owner', 'member-owner');
    delete process.env.ICLAW_SINGLE_HOST_MODE;

    broadcastRunStarted(
      'web:member-home',
      'run-1',
      Date.parse('2026-09-10T00:00:00.000Z'),
    );

    expect(owner.send).not.toHaveBeenCalled();
  });
});
