import { describe, expect, it } from 'vitest';

describe('portable surface', () => {
  it('exposes the platform-neutral app and repositories, without the AWS composition', async () => {
    const surface = await import('./portable.js');
    expect(Object.keys(surface)).toEqual(
      expect.arrayContaining(['createApp', 'errorToResult', 'loadConfig', 'verifyWithTrading212', 'ItemRepository', 'ItemManagementRepository']),
    );
    expect(Object.keys(surface)).not.toContain('createAwsDeps');
  });
});
