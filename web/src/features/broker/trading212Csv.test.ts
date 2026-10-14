import { describe, expect, it } from 'vitest';
import { prepareImportFile } from './trading212Csv';

const HEADER =
  'Action,Time (UTC),ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Total,Currency (Total),Withholding tax,Currency (Withholding tax),Currency conversion fee,Currency (Currency conversion fee)';
const BUY = 'Market buy,2026-01-05 10:00:00.123,US0378331005,AAPL,Apple,,ID1,2,100,USD,1.1,181.99,EUR,,,0.27,EUR';

describe('prepareImportFile', () => {
  it('converts a Trading 212 history export and reports what was left out', async () => {
    const file = new File([[HEADER, BUY, 'Deposit,2026-01-01 09:00:00,,,,,ID0,,,,,100,EUR,,,,'].join('\n')], 'history.csv', { type: 'text/csv' });
    const { file: prepared, conversion } = await prepareImportFile(file);
    expect(prepared).not.toBe(file);
    expect(prepared.name).toBe('history.csv');
    const text = await prepared.text();
    expect(text.split('\n')[0]).toBe('date,type,symbol,quantity,price,fee,currency,note,fxRate');
    expect(text.split('\n')[1]).toMatch(/^2026-01-05,BUY,AAPL,2,100,0\.297,USD,T212 AAPL,1\.1/);
    expect(conversion).toMatchObject({ imported: 1, ignored: [{ action: 'Deposit', count: 1 }], unmapped: [], invalid: [] });
  });

  it('passes other files through untouched', async () => {
    const file = new File(['date,type,symbol,quantity,price,fee,currency\n2024-01-01,BUY,AAPL,1,1,0,USD'], 'mine.csv');
    const prepared = await prepareImportFile(file);
    expect(prepared.file).toBe(file);
    expect(prepared.conversion).toBeUndefined();
    expect((await prepareImportFile(new File([''], 'empty.csv'))).conversion).toBeUndefined();
  });
});
