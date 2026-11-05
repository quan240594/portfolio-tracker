import { addIsoDays, type GetCalendarResponse } from '@portfolio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiUrl } from '../api/client';
import { getSeed, resetDb } from './db';

const post = (body: unknown) => fetch(apiUrl('/calendar/dividends'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const calendar = async (from: string, to: string): Promise<GetCalendarResponse> => (await fetch(apiUrl(`/calendar?from=${from}&to=${to}&types=EX_DIVIDEND,DIVIDEND_PAY`))).json();

describe('mock dividend dates entered by hand (the demo)', () => {
  beforeEach(() => resetDb());
  const today = () => getSeed().today;

  it('stores an entry for a symbol of the demo portfolio, shows it in the calendar and removes it again', async () => {
    const exDate = addIsoDays(today(), 30);
    const res = await post({ symbol: 'ko', exDate, payDate: addIsoDays(exDate, 9), amount: 0.6 });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ symbol: 'KO', exDate, amount: 0.6, currency: 'USD', source: 'manual', declared: true });
    const mine = (await calendar(exDate, addIsoDays(exDate, 9))).events.filter((event) => event.source === 'manual');
    expect(mine.map((event) => [event.type, event.date])).toEqual([['EX_DIVIDEND', exDate], ['DIVIDEND_PAY', addIsoDays(exDate, 9)]]);
    expect((await fetch(apiUrl(`/calendar/dividends/KO/${exDate}`), { method: 'DELETE' })).status).toBe(204);
    expect((await calendar(exDate, exDate)).events.filter((event) => event.source === 'manual')).toEqual([]);
    expect((await fetch(apiUrl(`/calendar/dividends/KO/${exDate}`), { method: 'DELETE' })).status).toBe(404);
  });

  it('replaces the entry of the same ex-date and refuses a symbol that is not held or a pay date before the ex-date', async () => {
    const exDate = addIsoDays(today(), 40);
    await post({ symbol: 'KO', exDate, amount: 0.6 });
    expect(await (await post({ symbol: 'KO', exDate, amount: 0.7 })).json()).toMatchObject({ amount: 0.7 });
    expect((await calendar(exDate, exDate)).events.filter((event) => event.source === 'manual')).toHaveLength(1);
    expect((await post({ symbol: 'ZZZZ', exDate })).status).toBe(400);
    expect((await post({ symbol: 'KO', exDate, payDate: addIsoDays(exDate, -1) })).status).toBe(422);
    expect((await post({ symbol: 'KO' })).status).toBe(400);
  });
});
