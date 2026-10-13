import { CSV_COLUMNS } from '@portfolio/shared';

export const CSV_HEADER = CSV_COLUMNS.join(',');

/** Columns follow CSV_COLUMNS: date,type,symbol,quantity,price,fee,currency,note,fxRate (fxRate empty = ECB rate / EUR trade). */
export const SAMPLE_CSV_ROWS: string[] = [
  '2024-01-15,BUY,VWRL.AS,25,108.42,2.00,EUR,Monthly ETF purchase,',
  '2024-02-01,BUY,AAPL,10,186.86,1.00,USD,Broker FX rate from the statement,1.0812',
  '2024-03-12,BUY,BTC-EUR,0.02,62150.00,1.50,EUR,,',
  '2024-05-16,DIVIDEND,AAPL,10,0.25,0.38,USD,Q2 dividend (fee = withholding tax),',
  '2024-06-03,SELL,AAPL,4,194.03,1.00,USD,Rebalance,',
];

export function buildSampleCsv(): string {
  return [CSV_HEADER, ...SAMPLE_CSV_ROWS].join('\n') + '\n';
}

export function downloadSampleCsv(): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([buildSampleCsv()], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'portfolio-tracker-sample.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
