import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Category, CategoryAssignment, CustomAsset, PortfolioSettings } from '@portfolio/shared';
import { DynamoManagementRepository } from './management-repository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const repo = new DynamoManagementRepository(DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-west-1' })), 'tbl');
const conditionalFailure = () => new ConditionalCheckFailedException({ message: 'no', $metadata: {} });

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

beforeEach(() => {
  ddbMock.reset();
});

describe('DynamoManagementRepository', () => {
  it('stores each entity under its own key with an entityType and reads it back without keys', async () => {
    ddbMock.on(PutCommand).resolves({});
    await repo.putSettings(settings);
    await repo.putCategory(category);
    await repo.putAssignments([assignment]);
    await repo.putCustomAsset(asset);
    const items = ddbMock.commandCalls(PutCommand).map((c) => c.args[0].input.Item);
    expect(items.map((i) => [i!.PK, i!.SK, i!.entityType])).toEqual([
      ['USER#u', 'PSETTINGS#p1', 'PORTFOLIO_SETTINGS'],
      ['USER#u', 'CATEGORY#p1#c1', 'CATEGORY'],
      ['USER#u', 'CATASSIGN#p1#AAPL', 'CATEGORY_ASSIGNMENT'],
      ['USER#u', 'ASSET#p1#a1', 'CUSTOM_ASSET'],
    ]);
    expect(items[3]).toMatchObject({ valuations: [{ date: '2026-01-01', value: 1 }] });
  });

  it('gets settings and assets by key (consistent read) and maps missing items to null', async () => {
    ddbMock.on(GetCommand).resolvesOnce({ Item: { PK: 'x', SK: 'y', entityType: 'z', ...settings } }).resolvesOnce({}).resolvesOnce({ Item: { PK: 'x', ...asset } }).resolvesOnce({});
    expect(await repo.getSettings('u', 'p1')).toEqual(settings);
    expect(await repo.getSettings('u', 'p1')).toBeNull();
    expect(await repo.getCustomAsset('u', 'p1', 'a1')).toEqual(asset);
    expect(await repo.getCustomAsset('u', 'p1', 'a1')).toBeNull();
    expect(ddbMock.commandCalls(GetCommand)[0]!.args[0].input).toMatchObject({ Key: { PK: 'USER#u', SK: 'PSETTINGS#p1' }, ConsistentRead: true });
  });

  it('lists by prefix, following pages', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ PK: 'p', SK: 's', ...category }], LastEvaluatedKey: { PK: 'k' } })
      .resolvesOnce({ Items: [{ PK: 'p', SK: 's', ...category, categoryId: 'c2' }] })
      .resolves({});
    expect((await repo.listCategories('u', 'p1')).map((c) => c.categoryId)).toEqual(['c1', 'c2']);
    expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'USER#u', ':sk': 'CATEGORY#p1#' });
    await repo.listCategories('u');
    await repo.listAssignments('u', 'p1');
    await repo.listCustomAssets('u');
    await repo.listSettings('u');
    await repo.listWatchlist('u');
    expect(ddbMock.commandCalls(QueryCommand).slice(2).map((c) => c.args[0].input.ExpressionAttributeValues![':sk'])).toEqual([
      'CATEGORY#',
      'CATASSIGN#p1#',
      'ASSET#',
      'PSETTINGS#',
      'WATCH#',
    ]);
  });

  it('deletes a category together with its assignments only', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ PK: 'p', SK: 's', ...assignment }, { PK: 'p', SK: 's', ...assignment, symbol: 'MSFT', categoryId: 'other' }] });
    ddbMock.on(DeleteCommand).resolves({});
    await repo.deleteCategory('u', 'p1', 'c1');
    expect(ddbMock.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key!.SK).sort((a, b) => a.localeCompare(b))).toEqual([
      'CATASSIGN#p1#AAPL',
      'CATEGORY#p1#c1',
    ]);
  });

  it('deletes assignments, assets and, for a deleted portfolio, everything it owns', async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await repo.deleteAssignments('u', 'p1', ['AAPL', 'MSFT']);
    await repo.deleteCustomAsset('u', 'p1', 'a1');
    expect(ddbMock.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key!.SK)).toEqual(['CATASSIGN#p1#AAPL', 'CATASSIGN#p1#MSFT', 'ASSET#p1#a1']);

    ddbMock.reset();
    ddbMock.on(DeleteCommand).resolves({});
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ PK: 'p', SK: 's', ...category }] })
      .resolvesOnce({ Items: [{ PK: 'p', SK: 's', ...assignment }] })
      .resolvesOnce({ Items: [{ PK: 'p', SK: 's', ...asset }] });
    await repo.deletePortfolioData('u', 'p1');
    expect(ddbMock.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key!.SK).sort((a, b) => a.localeCompare(b))).toEqual([
      'ASSET#p1#a1',
      'CATASSIGN#p1#AAPL',
      'CATEGORY#p1#c1',
      'PSETTINGS#p1',
    ]);
  });

  it('adds watchlist entries create-only and reports duplicates', async () => {
    ddbMock.on(PutCommand).resolvesOnce({}).rejectsOnce(conditionalFailure()).rejectsOnce(new Error('boom'));
    const entry = { userId: 'u', symbol: 'NVDA', addedAt: 'x' };
    expect(await repo.addWatchlistEntry(entry)).toBe(true);
    expect(await repo.addWatchlistEntry(entry)).toBe(false);
    await expect(repo.addWatchlistEntry(entry)).rejects.toThrow('boom');
    expect(ddbMock.commandCalls(PutCommand)[0]!.args[0].input).toMatchObject({
      Item: { PK: 'USER#u', SK: 'WATCH#NVDA', entityType: 'WATCHLIST' },
      ConditionExpression: 'attribute_not_exists(PK)',
    });
  });

  it('removes watchlist entries and reports unknown symbols', async () => {
    ddbMock.on(DeleteCommand).resolvesOnce({}).rejectsOnce(conditionalFailure()).rejectsOnce(new Error('boom'));
    expect(await repo.deleteWatchlistEntry('u', 'NVDA')).toBe(true);
    expect(await repo.deleteWatchlistEntry('u', 'NVDA')).toBe(false);
    await expect(repo.deleteWatchlistEntry('u', 'NVDA')).rejects.toThrow('boom');
  });
});
