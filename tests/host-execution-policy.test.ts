import { describe, expect, test } from 'vitest';
import {
  beginHostPrivilegeRevocation,
  canExecuteOnHost,
  canRunHostAgent,
  endHostPrivilegeRevocation,
  isSingleHostModeEnabled,
  resolveHomeExecutionMode,
} from '../src/host-execution-policy.js';

describe('host execution live authorization', () => {
  test('allows only an active administrator', () => {
    expect(canExecuteOnHost({ role: 'admin', status: 'active' })).toBe(true);
    expect(canExecuteOnHost({ role: 'member', status: 'active' })).toBe(false);
    expect(canExecuteOnHost({ role: 'admin', status: 'disabled' })).toBe(false);
    expect(canExecuteOnHost({ role: 'admin', status: 'deleted' })).toBe(false);
    expect(canExecuteOnHost(undefined)).toBe(false);
  });

  test('fails closed while an administrator revocation is in flight', () => {
    const owner = {
      id: 'admin-1',
      role: 'admin' as const,
      status: 'active' as const,
    };
    beginHostPrivilegeRevocation(owner.id);
    expect(canExecuteOnHost(owner)).toBe(false);
    endHostPrivilegeRevocation(owner.id);
    expect(canExecuteOnHost(owner)).toBe(true);
  });
});

describe('single-host development runtime', () => {
  test('does not enable the escape hatch by default', () => {
    const previous = process.env.ICLAW_SINGLE_HOST_MODE;
    delete process.env.ICLAW_SINGLE_HOST_MODE;

    expect(isSingleHostModeEnabled()).toBe(false);
    expect(canRunHostAgent({ role: 'member', status: 'active' })).toBe(false);
    expect(resolveHomeExecutionMode('member')).toBe('container');

    if (previous === undefined) delete process.env.ICLAW_SINGLE_HOST_MODE;
    else process.env.ICLAW_SINGLE_HOST_MODE = previous;
  });

  test('allows an active member to run an agent, but not privileged host work', () => {
    process.env.ICLAW_SINGLE_HOST_MODE = 'true';

    expect(isSingleHostModeEnabled()).toBe(true);
    expect(canRunHostAgent({ role: 'member', status: 'active' })).toBe(true);
    expect(resolveHomeExecutionMode('member')).toBe('host');
    expect(canExecuteOnHost({ role: 'member', status: 'active' })).toBe(false);
    expect(canRunHostAgent({ role: 'member', status: 'disabled' })).toBe(false);

    delete process.env.ICLAW_SINGLE_HOST_MODE;
  });
});
