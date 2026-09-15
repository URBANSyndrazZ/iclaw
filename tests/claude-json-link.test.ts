import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { ensureClaudeJsonLink } from '../src/claude-json-link.js';

const temporaryDirectories: string[] = [];

function temporaryFile(name: string, content = '{}') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('ensureClaudeJsonLink', () => {
  test('falls back to a hard link when symlink creation is forbidden', () => {
    const target = temporaryFile('claude.json', '{"userID":"device-1"}');
    const local = path.join(path.dirname(target), 'session-claude.json');

    const result = ensureClaudeJsonLink(local, target, {
      ...fs,
      symlinkSync: () => {
        const error = new Error('EPERM') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      },
    });

    expect(result).toBe('hardlink');
    expect(fs.lstatSync(local).isSymbolicLink()).toBe(false);
    expect(fs.statSync(local).ino).toBe(fs.statSync(target).ino);
    expect(fs.statSync(local).dev).toBe(fs.statSync(target).dev);
    expect(ensureClaudeJsonLink(local, target)).toBe('already-linked');
  });

  test('copies the shared identity file when neither link type is available', () => {
    const target = temporaryFile('claude.json', '{"userID":"device-1"}');
    const local = path.join(path.dirname(target), 'session-claude.json');

    const result = ensureClaudeJsonLink(local, target, {
      ...fs,
      symlinkSync: () => {
        throw new Error('EPERM');
      },
      linkSync: () => {
        throw new Error('EPERM');
      },
    });

    expect(result).toBe('copy');
    expect(fs.readFileSync(local, 'utf8')).toBe('{"userID":"device-1"}');
  });
});
