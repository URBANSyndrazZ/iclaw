import { describe, expect, test } from 'vitest';

import { filterNavItems } from '../web/src/components/layout/nav-items.js';

describe('billing navigation visibility', () => {
  test('does not expose billing in the main navigation while billing is disabled', () => {
    expect(filterNavItems(false).some((item) => item.path === '/billing')).toBe(
      false,
    );
  });

  test('moves the user-facing bill entry out of the primary navigation', () => {
    expect(filterNavItems(true).some((item) => item.path === '/billing')).toBe(
      false,
    );
  });
});
