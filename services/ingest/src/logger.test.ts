import { afterEach, describe, expect, it, vi } from 'vitest';

const load = async () => {
  vi.resetModules();
  return (await import('./logger.js')).logger;
};

afterEach(() => vi.unstubAllEnvs());

describe('logger', () => {
  it('defaults to INFO when LOG_LEVEL is not set', async () => {
    vi.stubEnv('LOG_LEVEL', undefined as unknown as string);
    expect(process.env.LOG_LEVEL).toBeUndefined();
    const logger = await load();
    expect(logger.getLevelName()).toBe('INFO');
  });

  it('honours LOG_LEVEL case-insensitively', async () => {
    vi.stubEnv('LOG_LEVEL', 'debug');
    expect((await load()).getLevelName()).toBe('DEBUG');
  });

  it('tags log lines with the service name', async () => {
    vi.stubEnv('LOG_LEVEL', 'INFO');
    const logger = await load();
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (lines.push(String(chunk)), true));
    logger.info('hello', { key: 'value' });
    write.mockRestore();
    const entry = JSON.parse(lines.find((l) => l.includes('hello'))!);
    expect(entry).toMatchObject({ level: 'INFO', message: 'hello', service: 'portfolio-tracker-ingest', key: 'value' });
  });
});
