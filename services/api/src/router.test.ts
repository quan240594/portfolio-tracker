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
    expect(() => matchRoute('get', '/')).toThrow(expect.objectContaining({ statusCode: 404, code: 'NOT_FOUND', message: 'Route not found: GET /' }));
  });

  it('matches case-insensitively on method and returns the route template', () => {
    const m = matchRoute('get', '/api/imports/imp-1/');
    expect(m).toMatchObject({ name: 'getImport', route: 'GET /imports/{id}', pathParams: { id: 'imp-1' } });
  });

  it('does not let a path param span segments', () => {
    expect(() => matchRoute('DELETE', '/transactions/')).toThrow(/Route not found/);
  });

  it('serves the health route handler', async () => {
    await expect(matchRoute('GET', '/health').handler({} as never)).resolves.toEqual({ statusCode: 200, body: { status: 'ok' } });
  });

  it('normalises paths', () => {
    expect(normalisePath('/api/portfolio/')).toBe('/portfolio');
    expect(normalisePath('/api')).toBe('/');
    expect(normalisePath('/apis')).toBe('/apis');
    expect(normalisePath('/')).toBe('/');
    expect(normalisePath('')).toBe('/');
    expect(normalisePath('/health///')).toBe('/health');
  });
});

describe('downsample', () => {
  const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ date: String(i), value: i, invested: 0 }));
  it('keeps short series untouched', () => {
    const p = pts(10);
    expect(downsample(p)).toBe(p);
    expect(downsample(pts(400))).toHaveLength(400);
  });
  it('samples evenly', () => {
    expect(downsample(pts(9), 3).map((p) => p.value)).toEqual([0, 4, 8]);
    expect(downsample(pts(401)).map((p) => p.value).slice(0, 3)).toEqual([0, 1, 2]);
  });
  it('keeps first and last and caps at the max', () => {
    const out = downsample(pts(1000), 400);
    expect(out).toHaveLength(400);
    expect(out[0]!.date).toBe('0');
    expect(out.at(-1)!.date).toBe('999');
  });
});
