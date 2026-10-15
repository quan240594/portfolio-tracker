import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { defaultGoalSettings, type GoalItem } from '@portfolio/shared';
import { DynamoManagementRepository } from './management-repository.js';
import { InMemoryManagementRepository } from './testing/management-fakes.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const repo = new DynamoManagementRepository(DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-west-1' })), 'tbl');
const goal: GoalItem = { ...defaultGoalSettings('2026-06-15'), userId: 'u', portfolioId: 'all', createdAt: 'a', updatedAt: 'b' };

beforeEach(() => {
  ddbMock.reset();
});

describe('DynamoManagementRepository goals', () => {
  it('stores one GOAL item per user and scope', async () => {
    ddbMock.on(PutCommand).resolves({});
    await repo.putGoal(goal);
    await repo.putGoal({ ...goal, portfolioId: 'p1' });
    const items = ddbMock.commandCalls(PutCommand).map((c) => c.args[0].input.Item!);
    expect(items.map((i) => [i.PK, i.SK, i.entityType])).toEqual([
      ['USER#u', 'GOAL#all', 'GOAL'],
      ['USER#u', 'GOAL#p1', 'GOAL'],
    ]);
    expect(items[0]).toMatchObject({ goalType: 'income', targetAmount: 24_000, targetYear: 2056, startYieldPct: null });
  });

  it('reads a goal back without key attributes and maps a missing item to null', async () => {
    ddbMock.on(GetCommand).resolvesOnce({ Item: { PK: 'USER#u', SK: 'GOAL#all', entityType: 'GOAL', ...goal } }).resolvesOnce({});
    expect(await repo.getGoal('u', 'all')).toEqual(goal);
    expect(await repo.getGoal('u', 'p9')).toBeNull();
    expect(ddbMock.commandCalls(GetCommand)[0]!.args[0].input).toMatchObject({ Key: { PK: 'USER#u', SK: 'GOAL#all' }, ConsistentRead: true });
  });

  it('deletes by key', async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await repo.deleteGoal('u', 'p1');
    expect(ddbMock.commandCalls(DeleteCommand)[0]!.args[0].input.Key).toEqual({ PK: 'USER#u', SK: 'GOAL#p1' });
  });
});

describe('InMemoryManagementRepository goals', () => {
  it('replaces per user and scope, isolates users and cascades with the portfolio', async () => {
    const mem = new InMemoryManagementRepository();
    await mem.putGoal(goal);
    await mem.putGoal({ ...goal, targetAmount: 5 });
    await mem.putGoal({ ...goal, userId: 'other' });
    await mem.putGoal({ ...goal, portfolioId: 'p1' });
    expect((await mem.getGoal('u', 'all'))?.targetAmount).toBe(5);
    expect(await mem.getGoal('nobody', 'all')).toBeNull();
    await mem.deletePortfolioData('u', 'p1');
    expect(await mem.getGoal('u', 'p1')).toBeNull();
    expect(await mem.getGoal('u', 'all')).not.toBeNull();
    await mem.deleteGoal('u', 'all');
    expect(await mem.getGoal('u', 'all')).toBeNull();
    expect(await mem.getGoal('other', 'all')).not.toBeNull();
  });
});
