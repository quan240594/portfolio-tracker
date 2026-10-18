import { describe, expect, it, vi } from 'vitest';
import { MemoryItemStore } from '@portfolio/platform';
import { defaultGoalSettings, type Category, type CategoryAssignment, type CustomAsset, type GoalItem, type PortfolioSettings } from '@portfolio/shared';
import { ItemManagementRepository } from './management-repository.js';

const setup = () => {
  const items = new MemoryItemStore();
  return { items, repo: new ItemManagementRepository(items) };
};
const sks = (items: MemoryItemStore) =>
  items
    .snapshot()
    .map((i) => i.SK)
    .sort((a, b) => a.localeCompare(b));

const settings: PortfolioSettings = { portfolioId: 'p1', userId: 'u', trackCash: true, updatedAt: 'x' };
const category: Category = { categoryId: 'c1', userId: 'u', portfolioId: 'p1', name: 'Core', color: '#000000', targetWeight: 50, createdAt: 'x', updatedAt: 'x' };
const assignment: CategoryAssignment = { userId: 'u', portfolioId: 'p1', symbol: 'AAPL', categoryId: 'c1' };
const asset: CustomAsset = {
  assetId: 'a1',
  userId: 'u',
  portfolioId: 'p1',
  name: 'House',
  assetClass: 'REAL_ESTATE',
  currency: 'EUR',
  costBasis: 1,
  valuations: [{ date: '2026-01-01', value: 1 }],
  createdAt: 'x',
  updatedAt: 'x',
};
const goal: GoalItem = { ...defaultGoalSettings('2026-06-15'), userId: 'u', portfolioId: 'all', createdAt: 'a', updatedAt: 'b' };

describe('ItemManagementRepository', () => {
  it('stores each entity under its own key with an entityType and reads it back without keys', async () => {
    const { items, repo } = setup();
    await repo.putSettings(settings);
    await repo.putCategory(category);
    await repo.putAssignments([assignment]);
    await repo.putCustomAsset(asset);
    expect(items.snapshot().map((i) => [i.PK, i.SK, i.entityType])).toEqual([
      ['USER#u', 'PSETTINGS#p1', 'PORTFOLIO_SETTINGS'],
      ['USER#u', 'CATEGORY#p1#c1', 'CATEGORY'],
      ['USER#u', 'CATASSIGN#p1#AAPL', 'CATEGORY_ASSIGNMENT'],
      ['USER#u', 'ASSET#p1#a1', 'CUSTOM_ASSET'],
    ]);
    expect(await repo.getSettings('u', 'p1')).toEqual(settings);
    expect(await repo.getCustomAsset('u', 'p1', 'a1')).toEqual(asset);
    expect(await repo.getSettings('u', 'p2')).toBeNull();
    expect(await repo.getCustomAsset('u', 'p1', 'nope')).toBeNull();
  });

  it('reads consistently', async () => {
    const { items, repo } = setup();
    const get = vi.spyOn(items, 'get');
    const query = vi.spyOn(items, 'query');
    await repo.getSettings('u', 'p1');
    await repo.listWatchlist('u');
    expect(get).toHaveBeenCalledWith({ PK: 'USER#u', SK: 'PSETTINGS#p1' }, { consistent: true });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ pk: 'USER#u', sk: { beginsWith: 'WATCH#' }, consistent: true }));
  });

  it('lists by prefix per user, for one portfolio or all', async () => {
    const { repo } = setup();
    await repo.putCategory(category);
    await repo.putCategory({ ...category, categoryId: 'c2' });
    await repo.putCategory({ ...category, portfolioId: 'p2', categoryId: 'c3' });
    await repo.putCategory({ ...category, userId: 'other', categoryId: 'c4' });
    await repo.putAssignments([assignment, { ...assignment, portfolioId: 'p2' }]);
    await repo.putCustomAsset(asset);
    await repo.putSettings(settings);
    expect((await repo.listCategories('u', 'p1')).map((c) => c.categoryId)).toEqual(['c1', 'c2']);
    expect((await repo.listCategories('u')).map((c) => c.categoryId)).toEqual(['c1', 'c2', 'c3']);
    expect(await repo.listAssignments('u', 'p1')).toEqual([assignment]);
    expect(await repo.listAssignments('u')).toHaveLength(2);
    expect(await repo.listCustomAssets('u')).toEqual([asset]);
    expect(await repo.listCustomAssets('u', 'p9')).toEqual([]);
    expect(await repo.listSettings('u')).toEqual([settings]);
    expect(await repo.listWatchlist('u')).toEqual([]);
  });

  it('deletes a category together with its assignments only', async () => {
    const { items, repo } = setup();
    await repo.putCategory(category);
    await repo.putCategory({ ...category, categoryId: 'other' });
    await repo.putAssignments([assignment, { ...assignment, symbol: 'MSFT', categoryId: 'other' }]);
    await repo.deleteCategory('u', 'p1', 'c1');
    expect(sks(items)).toEqual(['CATASSIGN#p1#MSFT', 'CATEGORY#p1#other']);
  });

  it('deletes assignments and assets by key', async () => {
    const { items, repo } = setup();
    await repo.putAssignments(['AAPL', 'MSFT', 'NVDA'].map((symbol) => ({ ...assignment, symbol })));
    await repo.putCustomAsset(asset);
    await repo.deleteAssignments('u', 'p1', ['AAPL', 'MSFT']);
    await repo.deleteCustomAsset('u', 'p1', 'a1');
    expect(sks(items)).toEqual(['CATASSIGN#p1#NVDA']);
  });

  it('removes everything a deleted portfolio owns, and nothing else', async () => {
    const { items, repo } = setup();
    for (const portfolioId of ['p1', 'p2']) {
      await repo.putSettings({ ...settings, portfolioId });
      await repo.putCategory({ ...category, portfolioId });
      await repo.putAssignments([{ ...assignment, portfolioId }]);
      await repo.putCustomAsset({ ...asset, portfolioId });
      await repo.putGoal({ ...goal, portfolioId });
    }
    await repo.putGoal(goal);
    await repo.deletePortfolioData('u', 'p1');
    expect(sks(items).filter((sk) => sk.includes('p1'))).toEqual([]);
    expect(sks(items)).toEqual(['ASSET#p2#a1', 'CATASSIGN#p2#AAPL', 'CATEGORY#p2#c1', 'GOAL#all', 'GOAL#p2', 'PSETTINGS#p2']);
  });

  it('adds watchlist entries create-only and reports duplicates', async () => {
    const { items, repo } = setup();
    const entry = { userId: 'u', symbol: 'NVDA', addedAt: 'x' };
    expect(await repo.addWatchlistEntry(entry)).toBe(true);
    expect(await repo.addWatchlistEntry({ ...entry, addedAt: 'later' })).toBe(false);
    expect(items.snapshot()).toEqual([{ PK: 'USER#u', SK: 'WATCH#NVDA', entityType: 'WATCHLIST', ...entry }]);
    expect(await repo.listWatchlist('u')).toEqual([entry]);
  });

  it('removes watchlist entries and reports unknown symbols', async () => {
    const { repo } = setup();
    await repo.addWatchlistEntry({ userId: 'u', symbol: 'NVDA', addedAt: 'x' });
    expect(await repo.deleteWatchlistEntry('u', 'NVDA')).toBe(true);
    expect(await repo.deleteWatchlistEntry('u', 'NVDA')).toBe(false);
  });

  it('surfaces storage errors', async () => {
    const { items, repo } = setup();
    vi.spyOn(items, 'put').mockRejectedValue(new Error('boom'));
    await expect(repo.addWatchlistEntry({ userId: 'u', symbol: 'NVDA', addedAt: 'x' })).rejects.toThrow('boom');
  });

  it('stores one GOAL item per user and scope, reads it back and deletes it', async () => {
    const { items, repo } = setup();
    await repo.putGoal(goal);
    await repo.putGoal({ ...goal, portfolioId: 'p1' });
    expect(items.snapshot().map((i) => [i.PK, i.SK, i.entityType])).toEqual([
      ['USER#u', 'GOAL#all', 'GOAL'],
      ['USER#u', 'GOAL#p1', 'GOAL'],
    ]);
    expect(items.snapshot()[0]).toMatchObject({ goalType: 'income', targetAmount: 24_000, targetYear: 2056, startYieldPct: null });
    expect(await repo.getGoal('u', 'all')).toEqual(goal);
    expect(await repo.getGoal('u', 'p9')).toBeNull();
    await repo.deleteGoal('u', 'p1');
    expect(sks(items)).toEqual(['GOAL#all']);
  });
});
