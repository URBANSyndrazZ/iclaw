import { describe, expect, test } from 'vitest';

import {
  isiclawBootstrapTurn,
  isiclawOwnerProfileRuntimeStructurallyEligible,
} from '../src/iclaw-bootstrap.js';

describe('iclaw first-wake eligibility', () => {
  test('allows only a real interactive Home turn of the built-in profile', () => {
    expect(
      isiclawBootstrapTurn({
        turnId: 'owner-turn',
        isHome: true,
        isDefaultProfile: true,
      }),
    ).toBe(true);
    expect(
      isiclawBootstrapTurn({
        isHome: true,
        isDefaultProfile: true,
      }),
    ).toBe(false);
    expect(
      isiclawBootstrapTurn({
        turnId: 'scheduled-turn',
        isHome: true,
        isDefaultProfile: true,
        isScheduledTask: true,
      }),
    ).toBe(false);
    expect(
      isiclawBootstrapTurn({
        turnId: 'custom-turn',
        isHome: true,
        isDefaultProfile: false,
      }),
    ).toBe(false);
    expect(
      isiclawBootstrapTurn({
        turnId: 'project-turn',
        isHome: false,
        isDefaultProfile: true,
      }),
    ).toBe(false);
  });
});

describe('iclaw Owner Profile structural runtime eligibility', () => {
  test('keeps capability across terminal warmup but denies unsafe runtime kinds', () => {
    const warmup = {
      isHome: true,
      isDefaultProfile: true,
    };
    expect(isiclawOwnerProfileRuntimeStructurallyEligible(warmup)).toBe(
      true,
    );
    expect(
      isiclawOwnerProfileRuntimeStructurallyEligible({
        ...warmup,
        runtimeAgentId: 'conversation-1',
        runtimeAgentKind: 'conversation',
      }),
    ).toBe(true);
    expect(
      isiclawOwnerProfileRuntimeStructurallyEligible({
        ...warmup,
        isScheduledTask: true,
      }),
    ).toBe(false);
    for (const runtimeAgentKind of ['task', 'spawn'] as const) {
      expect(
        isiclawOwnerProfileRuntimeStructurallyEligible({
          ...warmup,
          runtimeAgentId: `${runtimeAgentKind}-1`,
          runtimeAgentKind,
        }),
      ).toBe(false);
    }
    expect(
      isiclawOwnerProfileRuntimeStructurallyEligible({
        ...warmup,
        isHome: false,
      }),
    ).toBe(false);
    expect(
      isiclawOwnerProfileRuntimeStructurallyEligible({
        ...warmup,
        isDefaultProfile: false,
      }),
    ).toBe(false);
  });
});
