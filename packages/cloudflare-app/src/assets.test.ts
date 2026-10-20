import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const wrangler = JSON.parse(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '')) as {
  assets: { not_found_handling: string; run_worker_first: string[] };
};

describe('static assets of the personal deployment', () => {
  it('serves /sw.js and the notification icons as plain static files: the Worker is not run for them and the SPA fallback cannot swallow a real file', () => {
    const { run_worker_first: workerFirst, not_found_handling: fallback } = wrangler.assets;
    expect(fallback).toBe('single-page-application');
    expect(workerFirst).toEqual(['/api/*', '/auth/*', '/usage', '/health']);
  });

  it('asks for /sw.js to be revalidated on every visit (the deployed web build ships the _headers file from web/public)', () => {
    const headers = readFileSync(join(ROOT, '..', '..', 'web', 'public', '_headers'), 'utf8');
    expect(headers).toMatch(/^\/sw\.js\n\s+Cache-Control: no-cache$/m);
  });

  it('documents the push variables next to the other ones', () => {
    const config = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
    expect(config).toContain('VAPID_PUBLIC_KEY');
    expect(config).toContain('VAPID_PRIVATE_KEY');
    expect(config).not.toMatch(/"VAPID_PRIVATE_KEY"\s*:/);
  });
});
