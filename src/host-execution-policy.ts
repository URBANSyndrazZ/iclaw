import type { User } from './types.js';

export type ExecutionMode = 'host' | 'container';

const revokingHostPrivilegeUserIds = new Set<string>();

export function isSingleHostModeEnabled(): boolean {
  const value = process.env.ICLAW_SINGLE_HOST_MODE?.trim().toLowerCase();
  return value === 'true' || value === '1';
}

export function beginHostPrivilegeRevocation(userId: string): void {
  revokingHostPrivilegeUserIds.add(userId);
}

export function endHostPrivilegeRevocation(userId: string): void {
  revokingHostPrivilegeUserIds.delete(userId);
}

/**
 * Host execution is a live privilege, not a property inherited forever from
 * a workspace row. Callers must resolve the user from the database at the
 * point of execution and pass that current record here.
 */
export function canExecuteOnHost(
  owner: (Pick<User, 'role' | 'status'> & { id?: string }) | null | undefined,
): boolean {
  return (
    owner?.role === 'admin' &&
    owner.status === 'active' &&
    (!owner.id || !revokingHostPrivilegeUserIds.has(owner.id))
  );
}

/**
 * Authorizes Agent runtime only. Unlike canExecuteOnHost, this deliberately
 * does not authorize scripts, mounts, or other direct host privileges.
 */
export function canRunHostAgent(
  owner: (Pick<User, 'role' | 'status'> & { id?: string }) | null | undefined,
): boolean {
  if (
    owner?.status !== 'active' ||
    (owner.id && revokingHostPrivilegeUserIds.has(owner.id))
  ) {
    return false;
  }
  return owner.role === 'admin' || isSingleHostModeEnabled();
}

export function resolveHomeExecutionMode(
  role: User['role'] | null | undefined,
): ExecutionMode {
  if (role === 'admin') return 'host';
  if (role === 'member' && isSingleHostModeEnabled()) return 'host';
  return 'container';
}

export const HOST_EXECUTION_FORBIDDEN_ERROR =
  'Host execution requires a currently active administrator owner';
