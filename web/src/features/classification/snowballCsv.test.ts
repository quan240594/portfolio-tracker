import { MAX_CLASSIFICATION_IMPORT_BYTES, MAX_CLASSIFICATION_IMPORT_ROWS } from '@portfolio/shared';
import { snowballCsv, snowballFile, CHANGED_ROW, UNHELD_ROW } from '../../test/snowballFixtures';
import { readSnowballFile } from './snowballCsv';

describe('readSnowballFile', () => {
  it('parses a synthetic export into normalised rows and keeps the parser notes', async () => {
    const result = await readSnowballFile(snowballFile([CHANGED_ROW, UNHELD_ROW, { holding: 'ODD', name: 'Odd Kind', category: 'Whatever' }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({ ticker: 'VWRL', name: 'Invented World Fund', assetClass: 'ETF', currency: 'EUR' });
    expect(result.rows[1]).toMatchObject({ ticker: 'ZZZZ', assetClass: 'STOCK' });
    expect(result.issues).toEqual([{ line: 4, message: expect.stringContaining('Whatever') }]);
  });

  it('refuses a file over the API limit without reading it', async () => {
    const file = new File(['x'], 'big.csv');
    Object.defineProperty(file, 'size', { value: MAX_CLASSIFICATION_IMPORT_BYTES + 1 });
    const text = vi.spyOn(file, 'text');
    expect(await readSnowballFile(file)).toEqual({ ok: false, message: 'The file is larger than 1 MB; the Snowball holdings export is much smaller.' });
    expect(text).not.toHaveBeenCalled();
  });

  it('accepts a file of exactly the limit', async () => {
    const file = snowballFile([CHANGED_ROW]);
    Object.defineProperty(file, 'size', { value: MAX_CLASSIFICATION_IMPORT_BYTES });
    expect((await readSnowballFile(file)).ok).toBe(true);
  });

  it('says so when the file cannot be read', async () => {
    const file = new File(['x'], 'broken.csv');
    vi.spyOn(file, 'text').mockRejectedValue(new Error('disk'));
    expect(await readSnowballFile(file)).toEqual({ ok: false, message: 'The selected file could not be read.' });
  });

  it('names the problem of a file that is not a holdings export or has no rows', async () => {
    const foreign = await readSnowballFile(new File(['date,type,symbol\n2024-01-01,BUY,AAPL'], 'transactions.csv'));
    expect(foreign).toEqual({ ok: false, message: expect.stringContaining('Not a Snowball holdings export') });
    expect(await readSnowballFile(new File([''], 'empty.csv'))).toEqual({ ok: false, message: expect.stringContaining('Not a Snowball holdings export') });
    expect(await readSnowballFile(new File([snowballCsv([])], 'header-only.csv'))).toEqual({ ok: false, message: 'The file has no rows to import.' });
  });

  it('refuses more rows than one import takes', async () => {
    const rows = Array.from({ length: MAX_CLASSIFICATION_IMPORT_ROWS + 1 }, (_, i) => ({ holding: `T${i}`, name: `Invented ${i}` }));
    const result = await readSnowballFile(new File([snowballCsv(rows)], 'many.csv'));
    expect(result).toEqual({ ok: false, message: `The file has more than ${MAX_CLASSIFICATION_IMPORT_ROWS} rows, which is more than one import takes.` });
  });
});
