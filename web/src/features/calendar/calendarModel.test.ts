import type { CalendarEvent } from '@portfolio/shared';
import {
  EVENT_META,
  applyCalendarState,
  eventAriaLabel,
  filterEvents,
  groupByDate,
  isDividend,
  isEstimated,
  localToday,
  monthGrid,
  monthIncome,
  parseCalendarState,
  remainingIncome,
  requestRange,
  shiftMonth,
  sourceLabel,
  type CalendarUiState,
} from './calendarModel';

const TODAY = '2026-10-15';
const parse = (query: string, view: 'calendar' | 'list' = 'calendar') => parseCalendarState(new URLSearchParams(query), TODAY, view);

const event = (e: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'e1',
  date: '2026-10-20',
  type: 'EX_DIVIDEND',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  status: 'CONFIRMED',
  origin: 'HOLDING',
  source: 'market-data',
  description: '',
  ...e,
});

describe('parseCalendarState', () => {
  it('defaults to the current month, everything visible and the given default view', () => {
    expect(parse('')).toEqual({
      view: 'calendar',
      range: 'month',
      month: '2026-10',
      types: ['EX_DIVIDEND', 'DIVIDEND_PAY', 'EARNINGS', 'SPLIT', 'CORPORATE_ACTION'],
      statuses: ['CONFIRMED', 'ESTIMATED', 'PAID'],
      scope: 'all',
    });
    expect(parse('', 'list').view).toBe('list');
  });

  it('reads the view, month, range, filters and scope from the URL', () => {
    expect(parse('view=list&month=2027-02&range=month&types=earnings,split&status=PAID&scope=watchlist')).toMatchObject({
      view: 'list',
      month: '2027-02',
      types: ['EARNINGS', 'SPLIT'],
      statuses: ['PAID'],
      scope: 'watchlist',
    });
  });

  it('ignores invalid values', () => {
    expect(parse('view=grid&month=2026-13&types=bogus,earnings&status=x&scope=nope')).toMatchObject({
      view: 'calendar',
      month: '2026-10',
      types: ['EARNINGS'],
      statuses: [],
      scope: 'all',
    });
    expect(parse('month=abc').month).toBe('2026-10');
  });

  it('treats an empty list as "none selected"', () => {
    expect(parse('types=').types).toEqual([]);
  });

  it('always shows the 12-month range as a list', () => {
    expect(parse('range=year&view=calendar')).toMatchObject({ range: 'year', view: 'list' });
    expect(parse('range=year', 'calendar').view).toBe('list');
  });
});

describe('applyCalendarState', () => {
  const base = parse('');
  const apply = (patch: Partial<CalendarUiState>, params = '') => applyCalendarState(new URLSearchParams(params), { ...base, ...patch }, TODAY, 'calendar').toString();

  it('leaves defaults out of the URL and keeps unrelated parameters', () => {
    expect(apply({})).toBe('');
    expect(apply({}, 'portfolio=p1&view=list&month=2027-01&types=EARNINGS')).toBe('portfolio=p1');
  });

  it('writes everything that differs from the defaults', () => {
    expect(apply({ view: 'list', range: 'year', month: '2026-12', types: ['EARNINGS'], statuses: ['PAID', 'ESTIMATED'], scope: 'holdings' })).toBe(
      'view=list&range=year&month=2026-12&types=EARNINGS&status=PAID%2CESTIMATED&scope=holdings',
    );
    expect(apply({ types: [] })).toBe('types=');
  });

  it('round-trips through parseCalendarState', () => {
    const state: CalendarUiState = { view: 'list', range: 'month', month: '2027-03', types: ['SPLIT', 'EARNINGS'], statuses: ['CONFIRMED'], scope: 'watchlist' };
    const params = applyCalendarState(new URLSearchParams(), state, TODAY, 'calendar');
    expect(parseCalendarState(params, TODAY, 'calendar')).toEqual(state);
  });
});

describe('localToday', () => {
  it('formats the local date', () => {
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localToday(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
    expect(localToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('monthGrid', () => {
  it('covers whole Monday-first weeks around the month', () => {
    const grid = monthGrid('2026-10');
    expect(grid.from).toBe('2026-09-28');
    expect(grid.to).toBe('2026-11-01');
    expect(grid.weeks).toHaveLength(5);
    expect(grid.weeks[0]).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    expect(grid.weeks.every((w) => w.length === 7)).toBe(true);
  });

  it('handles months that start on a Monday or end on a Sunday, and six-week months', () => {
    const feb = monthGrid('2027-02'); // 1 Feb 2027 is a Monday, 28 Feb a Sunday
    expect([feb.from, feb.to, feb.weeks.length]).toEqual(['2027-02-01', '2027-02-28', 4]);
    const may = monthGrid('2026-05'); // starts on a Friday, ends on a Sunday
    expect([may.from, may.to, may.weeks.length]).toEqual(['2026-04-27', '2026-05-31', 5]);
    const aug = monthGrid('2026-08'); // starts on a Saturday, ends on a Monday
    expect([aug.from, aug.to, aug.weeks.length]).toEqual(['2026-07-27', '2026-09-06', 6]);
  });
});

describe('requestRange', () => {
  it('asks for the visible grid, the month, or the next 12 months', () => {
    expect(requestRange({ range: 'month', month: '2026-10', view: 'calendar' }, TODAY)).toEqual({ from: '2026-09-28', to: '2026-11-01' });
    expect(requestRange({ range: 'month', month: '2026-10', view: 'list' }, TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(requestRange({ range: 'year', month: '2026-10', view: 'list' }, TODAY)).toEqual({ from: '2026-10-15', to: '2027-10-14' });
  });
  it('shifts months', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });
});

describe('events', () => {
  const events = [
    event({ id: 'a', type: 'EX_DIVIDEND', status: 'CONFIRMED', origin: 'HOLDING' }),
    event({ id: 'b', type: 'EARNINGS', status: 'ESTIMATED', origin: 'WATCHLIST', date: '2026-10-21' }),
    event({ id: 'c', type: 'DIVIDEND_PAY', status: 'PAID', origin: 'HOLDING', date: '2026-10-20' }),
  ];
  const all = { types: Object.keys(EVENT_META) as CalendarUiState['types'], statuses: ['CONFIRMED', 'ESTIMATED', 'PAID'] as CalendarUiState['statuses'], scope: 'all' as const };

  it('filters by type, status and scope, and shows nothing when a list is empty', () => {
    expect(filterEvents(events, all)).toHaveLength(3);
    expect(filterEvents(events, { ...all, types: ['EARNINGS'] }).map((e) => e.id)).toEqual(['b']);
    expect(filterEvents(events, { ...all, statuses: ['PAID'] }).map((e) => e.id)).toEqual(['c']);
    expect(filterEvents(events, { ...all, scope: 'watchlist' }).map((e) => e.id)).toEqual(['b']);
    expect(filterEvents(events, { ...all, scope: 'holdings' }).map((e) => e.id)).toEqual(['a', 'c']);
    expect(filterEvents(events, { ...all, types: [] })).toEqual([]);
    expect(filterEvents(events, { ...all, statuses: [] })).toEqual([]);
  });

  it('groups by date in chronological order', () => {
    expect(groupByDate(events).map((g) => [g.date, g.events.map((e) => e.id)])).toEqual([
      ['2026-10-20', ['a', 'c']],
      ['2026-10-21', ['b']],
    ]);
    expect(groupByDate([])).toEqual([]);
  });

  it('sums the income of one month from the events that carry the dividend amount', () => {
    const income = [
      event({ id: '1', countsAsIncome: true, expectedAmount: 3.4, date: '2026-10-02' }),
      event({ id: '2', countsAsIncome: true, expectedAmount: 1.1, date: '2026-10-30' }),
      event({ id: '3', countsAsIncome: false, expectedAmount: 99, date: '2026-10-30' }),
      event({ id: '4', countsAsIncome: true, expectedAmount: 50, date: '2026-11-01' }),
      event({ id: '5', countsAsIncome: true, date: '2026-10-03' }),
    ];
    expect(monthIncome(income, '2026-10')).toBe(4.5);
    expect(monthIncome([], '2026-10')).toBe(0);
  });

  it('sums the income still to come in a date range, leaving out what was received', () => {
    const income = [
      event({ id: '1', countsAsIncome: true, expectedAmount: 3.4, date: '2026-10-15', status: 'CONFIRMED' }),
      event({ id: '2', countsAsIncome: true, expectedAmount: 1.1, date: '2026-12-31', status: 'ESTIMATED' }),
      event({ id: '3', countsAsIncome: true, expectedAmount: 50, date: '2026-10-10', status: 'PAID' }),
      event({ id: '4', countsAsIncome: true, expectedAmount: 20, date: '2026-10-20', status: 'PAID' }),
      event({ id: '5', countsAsIncome: false, expectedAmount: 99, date: '2026-11-01', status: 'CONFIRMED' }),
      event({ id: '6', countsAsIncome: true, expectedAmount: 7, date: '2027-01-02', status: 'CONFIRMED' }),
      event({ id: '7', countsAsIncome: true, date: '2026-11-03', status: 'CONFIRMED' }),
      event({ id: '8', countsAsIncome: true, expectedAmount: 8, date: '2026-10-14', status: 'CONFIRMED' }),
    ];
    expect(remainingIncome(income, '2026-10-15', '2026-12-31')).toBe(4.5);
    expect(remainingIncome([], '2026-10-15', '2026-12-31')).toBe(0);
  });

  it('names events for assistive technology', () => {
    expect(eventAriaLabel(event(), '€ 3,74')).toBe('AAPL, Ex-dividend, confirmed, € 3,74');
    expect(eventAriaLabel(event({ type: 'SPLIT', status: 'ESTIMATED' }), undefined)).toBe('AAPL, Stock split, estimated');
  });

  it('classifies events and labels sources', () => {
    expect(isDividend(event())).toBe(true);
    expect(isDividend(event({ type: 'DIVIDEND_PAY' }))).toBe(true);
    expect(isDividend(event({ type: 'EARNINGS' }))).toBe(false);
    expect(isEstimated(event({ status: 'ESTIMATED' }))).toBe(true);
    expect(sourceLabel('alphavantage')).toBe('Alpha Vantage');
    expect(sourceLabel('something-new')).toBe('something-new');
  });

  it('gives every type its own letter and shape', () => {
    const metas = Object.values(EVENT_META);
    expect(new Set(metas.map((m) => m.letter)).size).toBe(metas.length);
    expect(new Set(metas.map((m) => m.shape)).size).toBe(metas.length);
  });
});
