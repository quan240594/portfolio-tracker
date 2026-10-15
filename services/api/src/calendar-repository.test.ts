import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoRepository } from './repository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const repo = new DynamoRepository(DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-west-1' })), 'tbl');

beforeEach(() => {
  ddbMock.reset();
});

describe('DynamoRepository.getCalendarEvents', () => {
  it('queries the EARN# and SPLIT# ranges of every symbol and strips the key attributes', async () => {
    ddbMock.on(QueryCommand).callsFake((input: { ExpressionAttributeValues: Record<string, string> }) => {
      const { ':pk': pk, ':from': from } = input.ExpressionAttributeValues;
      if (from!.startsWith('EARN#') && pk === 'TICKER#AAPL') {
        return { Items: [{ PK: pk, SK: 'EARN#2026-07-30', entityType: 'EARNINGS_EVENT', symbol: 'AAPL', date: '2026-07-30', source: 'alphavantage' }] };
      }
      if (from!.startsWith('SPLIT#') && pk === 'TICKER#MSFT') {
        return { Items: [{ PK: pk, SK: 'SPLIT#2026-07-01', entityType: 'SPLIT_EVENT', symbol: 'MSFT', date: '2026-07-01', fromFactor: 1, toFactor: 2, source: 'eodhd' }] };
      }
      return { Items: [] };
    });
    const result = await repo.getCalendarEvents(['AAPL', 'MSFT'], '2026-06-01', '2026-12-31');
    expect(result).toEqual({
      earnings: [{ symbol: 'AAPL', date: '2026-07-30', source: 'alphavantage' }],
      splits: [{ symbol: 'MSFT', date: '2026-07-01', fromFactor: 1, toFactor: 2, source: 'eodhd' }],
    });
    const calls = ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.TableName === 'tbl' && c.KeyConditionExpression === 'PK = :pk AND SK BETWEEN :from AND :to')).toBe(true);
    expect(calls.map((c) => [c.ExpressionAttributeValues![':pk'], c.ExpressionAttributeValues![':from'], c.ExpressionAttributeValues![':to']])).toEqual(
      expect.arrayContaining([
        ['TICKER#AAPL', 'EARN#2026-06-01', 'EARN#2026-12-31'],
        ['TICKER#MSFT', 'SPLIT#2026-06-01', 'SPLIT#2026-12-31'],
      ]),
    );
  });

  it('follows pagination', async () => {
    const page = (date: string, more: boolean) => ({
      Items: [{ PK: 'TICKER#A', SK: `EARN#${date}`, symbol: 'A', date, source: 's' }],
      ...(more ? { LastEvaluatedKey: { PK: 'TICKER#A', SK: `EARN#${date}` } } : {}),
    });
    ddbMock.on(QueryCommand).callsFake((input: { ExpressionAttributeValues: Record<string, string>; ExclusiveStartKey?: unknown }) => {
      if (!input.ExpressionAttributeValues[':from']!.startsWith('EARN#')) return { Items: [] };
      return input.ExclusiveStartKey ? page('2026-10-01', false) : page('2026-07-01', true);
    });
    const { earnings } = await repo.getCalendarEvents(['A'], '2026-06-01', '2026-12-31');
    expect(earnings.map((e) => e.date)).toEqual(['2026-07-01', '2026-10-01']);
  });
});
