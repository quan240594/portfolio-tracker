import { describe, expect, it } from 'vitest';
import { API_ROUTES } from '@portfolio/shared';
import { matchRoute, normalisePath } from './router.js';
import { downsample } from './routes/portfolio.js';

describe('router', () => {
  it('matches every contract route', () => {
    for (const [name, spec] of Object.entries(API_ROUTES)) {
      const [method, path] = spec.split(' ') as [string, string];
      const m = matchRoute(method, path.replace('{id}', 'abc'));
      expect(m.name).toBe(name);
    }
  });

  it('extracts and decodes path params', () => {
    expect(matchRoute('DELETE', '/transactions/a%20b').pathParams).toEqual({ id: 'a b' });
  });

  it('throws a 404 HttpError for unknown routes', () => {
    expect(() => matchRoute('GET', '/transactions/x/y')).toThrowError(/Route not found/);
  });

  it('normalises paths', () => {
    expect(normalisePath('/api/portfolio/')).toBe('/portfolio');
    expect(normalisePath('/api')).toBe('/');
    expect(normalisePath('/apis')).toBe('/apis');
  });
});

describe('downsample', () => {
  const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ date: String(i), value: i, invested: 0 }));
  it('keeps short series untouched', () => {
    expect(downsample(pts(10))).toHaveLength(10);
  });
  it('keeps first and last and caps at the max', () => {
    const out = downsample(pts(1000), 400);
    expect(out).toHaveLength(400);
    expect(out[0]!.date).toBe('0');
    expect(out.at(-1)!.date).toBe('999');
  });
});
