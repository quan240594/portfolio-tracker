import { defaultGoalSettings, type GoalSettings } from '@portfolio/shared';
import { ApiError } from '../../api/client';
import {
  ADVANCED_FIELDS,
  apiFieldErrors,
  parseGoalForm,
  sameSettings,
  settingsToForm,
  targetHint,
  yearOptions,
  type GoalFormValues,
} from './goalFormModel';

const TODAY = '2026-10-15';
const defaults = defaultGoalSettings(TODAY);

describe('settingsToForm / parseGoalForm', () => {
  it('round-trips the settings through Dutch text', () => {
    const form = settingsToForm({ ...defaults, yieldOnNewMoneyPct: 3.5, startYieldPct: 2.25 });
    expect(form).toMatchObject({ goalType: 'income', targetAmount: '24000', targetYear: '2056', yieldOnNewMoneyPct: '3,5', startYieldPct: '2,25', adjustForInflation: true });
    expect(parseGoalForm(form, TODAY)).toEqual({ settings: { ...defaults, yieldOnNewMoneyPct: 3.5, startYieldPct: 2.25 } });
  });

  it('maps an empty starting yield to null and accepts Dutch thousands separators', () => {
    const form = { ...settingsToForm(defaults), startYieldPct: '', targetAmount: '1.250.000,50' };
    expect(parseGoalForm(form, TODAY)).toEqual({ settings: { ...defaults, startYieldPct: null, targetAmount: 1_250_000.5 } });
  });

  it('reports one message per invalid field', () => {
    const form: GoalFormValues = { ...settingsToForm(defaults), targetAmount: '0', monthlyContribution: '', inflationPct: 'abc', priceReturnPct: '31' };
    const result = parseGoalForm(form, TODAY);
    expect('errors' in result && result.errors).toEqual({
      targetAmount: 'Target amount must be a number between 1 and 1.000.000.000.',
      monthlyContribution: 'Monthly contribution must be a number between 0 and 1.000.000.',
      inflationPct: 'Inflation must be a number between 0 and 30.',
      priceReturnPct: 'Price return must be a number between 0 and 30.',
    });
  });

  it('reports a target year outside the selectable window', () => {
    const result = parseGoalForm({ ...settingsToForm(defaults), targetYear: '2020' }, TODAY);
    expect('errors' in result && result.errors).toEqual({ targetYear: 'Target year must be between 2027 and 2086' });
  });

  it('keeps the first error of a field', () => {
    const form = { ...settingsToForm(defaults), startYieldPct: '-1' };
    expect('errors' in parseGoalForm(form, TODAY) && Object.keys((parseGoalForm(form, TODAY) as { errors: object }).errors)).toEqual(['startYieldPct']);
  });
});

describe('apiFieldErrors', () => {
  it('reads field issues from a 400', () => {
    const err = new ApiError(400, 'VALIDATION_ERROR', 'Invalid goal', [{ path: ['targetAmount'] }, { path: ['bogus'] }, { path: ['targetAmount'] }, {}]);
    expect(apiFieldErrors(err)).toEqual({ targetAmount: 'Target amount must be a number between 1 and 1.000.000.000.' });
  });

  it('is empty for other errors', () => {
    expect(apiFieldErrors(new ApiError(500, 'INTERNAL', 'x'))).toEqual({});
    expect(apiFieldErrors(new Error('x'))).toEqual({});
  });
});

describe('sameSettings', () => {
  it('compares every field', () => {
    expect(sameSettings(defaults, { ...defaults })).toBe(true);
    for (const key of Object.keys(defaults) as (keyof GoalSettings)[]) {
      const changed = { ...defaults, [key]: typeof defaults[key] === 'boolean' ? !defaults[key] : 'x' } as GoalSettings;
      expect(sameSettings(defaults, changed)).toBe(false);
    }
  });
});

describe('yearOptions / targetHint / ADVANCED_FIELDS', () => {
  it('lists the next 60 years', () => {
    const years = yearOptions(TODAY);
    expect(years[0]).toBe(2027);
    expect(years.at(-1)).toBe(2086);
    expect(years).toHaveLength(60);
  });

  it('shows the monthly amount of an income goal', () => {
    expect(targetHint(defaults, TODAY, 'EUR').replace(/\u00a0/g, ' ')).toBe('€ 2.000 per month');
  });

  it('shows the inflated value goal, or says it is not adjusted', () => {
    const value: GoalSettings = { ...defaults, goalType: 'value', targetAmount: 100_000, targetYear: 2036, inflationPct: 2 };
    expect(targetHint(value, TODAY, 'EUR').replace(/\u00a0/g, ' ')).toBe('€ 121.899 in 2036 after inflation');
    expect(targetHint({ ...value, adjustForInflation: false }, TODAY, 'EUR')).toBe('Not adjusted for inflation');
  });

  it('knows the advanced fields', () => {
    expect(ADVANCED_FIELDS).toContain('inflationPct');
    expect(ADVANCED_FIELDS).not.toContain('targetAmount');
  });
});
