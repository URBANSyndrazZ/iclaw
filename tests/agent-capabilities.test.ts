import { describe, expect, test } from 'vitest';

import {
  checkHostCapabilities,
  pathLookupCommand,
  resetHostCapabilitiesCache,
} from '../src/agent-capabilities.js';

describe('host capability preflight', () => {
  test('uses the platform binary lookup command', () => {
    expect(pathLookupCommand('win32')).toBe('where');
    expect(pathLookupCommand('linux')).toBe('which');
    expect(pathLookupCommand('darwin')).toBe('which');
  });

  test('resolves node from the running backend even when which is unavailable', async () => {
    resetHostCapabilitiesCache();
    const result = await checkHostCapabilities();
    expect(result.available.map((capability) => capability.name)).toContain(
      'node',
    );
    expect(result.resolvedPaths.node).not.toBe('node');
  });
});
