import { CSV_COLUMNS, csvRowSchema } from '@portfolio/shared';
import { buildSampleCsv, CSV_HEADER, downloadSampleCsv, SAMPLE_CSV_ROWS } from './sampleCsv';

describe('sample CSV', () => {
  it('builds a header plus rows that all satisfy the shared CSV row schema', () => {
    expect(CSV_HEADER).toBe(CSV_COLUMNS.join(','));
    const lines = buildSampleCsv().split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines.at(-1)).toBe('');
    expect(lines.slice(1, -1)).toEqual(SAMPLE_CSV_ROWS);
    for (const line of SAMPLE_CSV_ROWS) {
      const cells = line.split(',');
      const row = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, cells[i] ?? '']));
      expect(csvRowSchema.safeParse(row).success).toBe(true);
    }
  });

  it('downloads the sample through a temporary object URL', async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn((_: Blob) => 'blob:sample');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.href).toBe('blob:sample');
      expect(this.download).toBe('portfolio-tracker-sample.csv');
      expect(document.body.contains(this)).toBe(true);
    });
    try {
      downloadSampleCsv();
      expect(click).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0]![0];
      expect(blob.type).toBe('text/csv');
      expect(document.querySelector('a[download]')).toBeNull();
      expect(revokeObjectURL).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:sample');
    } finally {
      vi.useRealTimers();
      // @ts-expect-error cleanup of the stubbed static methods
      delete URL.createObjectURL;
      // @ts-expect-error cleanup of the stubbed static methods
      delete URL.revokeObjectURL;
    }
  });

  it('is a no-op where object URLs are unsupported', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    expect(typeof URL.createObjectURL).not.toBe('function');
    downloadSampleCsv();
    expect(click).not.toHaveBeenCalled();
  });
});
