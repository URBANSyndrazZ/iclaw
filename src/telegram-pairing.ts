import crypto from 'crypto';

interface SqliteRunResult {
  changes: number;
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  transaction<T extends () => void>(fn: T): T;
}

let database: SqliteDatabase | null = null;

export function bindPairingCodeDatabase(instance: SqliteDatabase | null): void {
  database = instance;
}

function requireDatabase(): SqliteDatabase {
  if (!database) {
    throw new Error('Pairing codes require an initialized database');
  }
  return database;
}

export const PAIRING_TTL_MS = 5 * 60 * 1000;
const CODE_LENGTH = 6;

export type PairingCodeFailureReason =
  | 'invalid'
  | 'expired'
  | 'owner_mismatch'
  | 'account_mismatch';

export interface PairingCodeClaims {
  userId: string;
  accountId?: string;
}

export type PairingCodeValidation =
  | { ok: true; claims: PairingCodeClaims }
  | { ok: false; reason: PairingCodeFailureReason };

interface PairingCodeRow {
  code_hash: string;
  user_id: string;
  account_id: string | null;
  expires_at: number;
}

function ownerKey(userId: string, accountId?: string): string {
  return `${userId}\u0000${accountId || 'legacy'}`;
}

function randomCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const limit = 256 - (256 % chars.length);
  let result = '';
  while (result.length < CODE_LENGTH) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < limit) result += chars[byte % chars.length];
  }
  return result;
}

function codeHash(code: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(code.toUpperCase(), 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

function deleteExpired(): void {
  requireDatabase()
    .prepare('DELETE FROM channel_pairing_codes WHERE expires_at <= ?')
    .run(Date.now());
}

function getPairingCodeRow(code: string): PairingCodeRow | undefined {
  return requireDatabase()
    .prepare(
      `SELECT code_hash, user_id, account_id, expires_at
       FROM channel_pairing_codes
       WHERE code_hash = ?`,
    )
    .get(codeHash(code)) as PairingCodeRow | undefined;
}

function validateRow(
  row: PairingCodeRow,
  expected?: {
    userId?: string;
    accountId?: string;
    allowLegacyUnscopedCode?: boolean;
  },
): PairingCodeValidation {
  const db = requireDatabase();
  if (Date.now() > row.expires_at) {
    db.prepare('DELETE FROM channel_pairing_codes WHERE code_hash = ?').run(
      row.code_hash,
    );
    return { ok: false, reason: 'expired' };
  }

  const accountId = row.account_id ?? undefined;
  if (expected?.userId && row.user_id !== expected.userId) {
    return { ok: false, reason: 'owner_mismatch' };
  }
  if (expected?.accountId) {
    if (accountId !== expected.accountId) {
      return { ok: false, reason: 'account_mismatch' };
    }
  } else if (
    expected &&
    !expected.accountId &&
    accountId &&
    expected.allowLegacyUnscopedCode !== true
  ) {
    return { ok: false, reason: 'account_mismatch' };
  }

  return {
    ok: true,
    claims: { userId: row.user_id, accountId },
  };
}

export function generatePairingCode(
  userId: string,
  accountId?: string,
): {
  code: string;
  expiresAt: number;
  ttlSeconds: number;
} {
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  let code = '';
  const db = requireDatabase();
  db.transaction(() => {
    deleteExpired();
    db.prepare('DELETE FROM channel_pairing_codes WHERE owner_key = ?').run(
      ownerKey(userId, accountId),
    );

    do {
      code = randomCode();
    } while (getPairingCodeRow(code));

    db.prepare(
      `INSERT INTO channel_pairing_codes
         (code_hash, owner_key, user_id, account_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      codeHash(code),
      ownerKey(userId, accountId),
      userId,
      accountId ?? null,
      expiresAt,
      new Date().toISOString(),
    );
  })();

  return { code, expiresAt, ttlSeconds: PAIRING_TTL_MS / 1000 };
}

export function inspectPairingCode(
  code: string,
  expected?: {
    userId?: string;
    accountId?: string;
    allowLegacyUnscopedCode?: boolean;
  },
): PairingCodeValidation {
  const row = getPairingCodeRow(code);
  if (!row) return { ok: false, reason: 'invalid' };
  return validateRow(row, expected);
}

export function consumePairingCode(code: string): boolean {
  const result = requireDatabase()
    .prepare(
      `DELETE FROM channel_pairing_codes
       WHERE code_hash = ? AND expires_at > ?`,
    )
    .run(codeHash(code), Date.now());
  return result.changes > 0;
}

export function verifyPairingCode(code: string): PairingCodeClaims | null {
  const validation = inspectPairingCode(code);
  if (!validation.ok || !consumePairingCode(code)) return null;
  return validation.claims;
}
