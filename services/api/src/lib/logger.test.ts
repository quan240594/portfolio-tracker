import { afterEach, describe, expect, it, vi } from 'vitest';

const original = process.env.LOG_LEVEL;

async function loadLogger() {
  vi.resetModules();
  return (await import('./logger.js')).logger;
}

afterEach(() => {
  if (original === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = original;
});

describe('logger', () => {
  it('defaults to INFO when LOG_LEVEL is unset', async () => {
    delete process.env.LOG_LEVEL;
    const logger = await loadLogger();
    expect(logger.getLevelName()).toBe('INFO');
  });

  it('honours LOG_LEVEL case-insensitively', async () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = await loadLogger();
    expect(logger.getLevelName()).toBe('DEBUG');
  });

  it('tags log entries with the service name', async () => {
    process.env.LOG_LEVEL = 'INFO';
    const logger = await loadLogger();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      logger.info('hello');
      const output = [...write.mock.calls, ...log.mock.calls].map((c) => String(c[0])).join('\n');
      expect(output).toContain('"service":"portfolio-tracker-api"');
      expect(output).toContain('"message":"hello"');
    } finally {
      write.mockRestore();
      log.mockRestore();
    }
  });
});
