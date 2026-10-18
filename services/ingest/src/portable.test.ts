import { describe, expect, it } from 'vitest';

describe('portable surface', () => {
  it('exposes the platform-neutral import job and its dependencies', async () => {
    const surface = await import('./portable.js');
    expect(Object.keys(surface)).toEqual(
      expect.arrayContaining(['importUploadedJob', 'processImport', 'importOwner', 'MAX_OBJECT_BYTES', 'ItemIngestStore', 'parseImportCsv', 'MAX_ERRORS']),
    );
    expect(Object.keys(surface)).not.toContain('createAwsDeps');
  });
});
