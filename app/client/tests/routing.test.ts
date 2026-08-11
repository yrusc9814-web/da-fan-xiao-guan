import { describe, expect, it } from 'vitest';

import router from '../src/router';
import { getResponsiveMode } from '../src/utils/responsive';

describe('node 3 routing and responsive boundaries', () => {
  it('registers all framework placeholder routes', () => {
    const paths = router.getRoutes().map((route) => route.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/',
        '/recommendations',
        '/records',
        '/inventory',
        '/calendar',
        '/statistics',
        '/favorites',
        '/shopping',
        '/settings',
        '/chef',
        '/discovery',
        '/journal',
        '/recipes/:id'
      ])
    );
  });

  it('switches layout mode at the specified boundaries', () => {
    expect(getResponsiveMode(360)).toBe('mobile');
    expect(getResponsiveMode(767)).toBe('mobile');
    expect(getResponsiveMode(768)).toBe('tablet');
    expect(getResponsiveMode(1199)).toBe('tablet');
    expect(getResponsiveMode(1200)).toBe('desktop');
    expect(getResponsiveMode(1440)).toBe('desktop');
  });
});
