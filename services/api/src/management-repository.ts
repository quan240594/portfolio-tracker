import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  MANAGEMENT_ENTITY,
  fromItem,
  managementKeys,
  type Category,
  type CategoryAssignment,
  type CustomAsset,
  type PortfolioSettings,
  type WatchlistEntry,
} from '@portfolio/shared';

/** Persistence of the portfolio-management entities (settings, categories, custom assets, watchlist). */
export interface ManagementRepository {
  getSettings(userId: string, portfolioId: string): Promise<PortfolioSettings | null>;
  /** Settings of every portfolio of the user that has any. */
  listSettings(userId: string): Promise<PortfolioSettings[]>;
  putSettings(settings: PortfolioSettings): Promise<void>;
  /** Categories of one portfolio, or of all portfolios when `portfolioId` is omitted. */
  listCategories(userId: string, portfolioId?: string): Promise<Category[]>;
  putCategory(category: Category): Promise<void>;
  /** Deletes the category and every assignment that points at it. */
  deleteCategory(userId: string, portfolioId: string, categoryId: string): Promise<void>;
  listAssignments(userId: string, portfolioId?: string): Promise<CategoryAssignment[]>;
  putAssignments(assignments: readonly CategoryAssignment[]): Promise<void>;
  deleteAssignments(userId: string, portfolioId: string, symbols: readonly string[]): Promise<void>;
  listCustomAssets(userId: string, portfolioId?: string): Promise<CustomAsset[]>;
  getCustomAsset(userId: string, portfolioId: string, assetId: string): Promise<CustomAsset | null>;
  putCustomAsset(asset: CustomAsset): Promise<void>;
  deleteCustomAsset(userId: string, portfolioId: string, assetId: string): Promise<void>;
  listWatchlist(userId: string): Promise<WatchlistEntry[]>;
  /** Create-only put; resolves false when the symbol is already on the watchlist. */
  addWatchlistEntry(entry: WatchlistEntry): Promise<boolean>;
  deleteWatchlistEntry(userId: string, symbol: string): Promise<boolean>;
  /** Removes settings, categories, assignments and custom assets of a deleted portfolio. */
  deletePortfolioData(userId: string, portfolioId: string): Promise<void>;
}

const isConditionalCheckFailure = (err: unknown) => (err as Error | undefined)?.name === 'ConditionalCheckFailedException';

export class DynamoManagementRepository implements ManagementRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  private async queryAll(input: Omit<QueryCommandInput, 'TableName'>, ExclusiveStartKey?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const res = await this.doc.send(new QueryCommand({ ...input, TableName: this.tableName, ExclusiveStartKey }));
    const items = (res.Items ?? []) as Record<string, unknown>[];
    // Each page needs the previous page's cursor, so pages are fetched sequentially.
    return res.LastEvaluatedKey ? [...items, ...(await this.queryAll(input, res.LastEvaluatedKey))] : items;
  }

  private listByPrefix<T>(userId: string, prefix: string): Promise<T[]> {
    return this.queryAll({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': prefix },
      ConsistentRead: true,
    }).then((items) => items.map((i) => fromItem<T>(i)));
  }

  private put(key: { PK: string; SK: string }, entityType: string, item: object, condition?: string): Promise<unknown> {
    return this.doc.send(new PutCommand({ TableName: this.tableName, Item: { ...key, entityType, ...item }, ConditionExpression: condition }));
  }

  private remove(key: { PK: string; SK: string }): Promise<unknown> {
    return this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: key }));
  }

  async getSettings(userId: string, portfolioId: string): Promise<PortfolioSettings | null> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: managementKeys.settings(userId, portfolioId), ConsistentRead: true }));
    return res.Item ? fromItem<PortfolioSettings>(res.Item) : null;
  }

  listSettings(userId: string): Promise<PortfolioSettings[]> {
    return this.listByPrefix(userId, managementKeys.settingsPrefix);
  }

  async putSettings(s: PortfolioSettings): Promise<void> {
    await this.put(managementKeys.settings(s.userId, s.portfolioId), MANAGEMENT_ENTITY.settings, s);
  }

  listCategories(userId: string, portfolioId?: string): Promise<Category[]> {
    return this.listByPrefix(userId, managementKeys.categoryPrefix(portfolioId));
  }

  async putCategory(c: Category): Promise<void> {
    await this.put(managementKeys.category(c.userId, c.portfolioId, c.categoryId), MANAGEMENT_ENTITY.category, c);
  }

  async deleteCategory(userId: string, portfolioId: string, categoryId: string): Promise<void> {
    const assignments = await this.listAssignments(userId, portfolioId);
    await Promise.all(assignments.filter((a) => a.categoryId === categoryId).map((a) => this.remove(managementKeys.assignment(userId, portfolioId, a.symbol))));
    await this.remove(managementKeys.category(userId, portfolioId, categoryId));
  }

  listAssignments(userId: string, portfolioId?: string): Promise<CategoryAssignment[]> {
    return this.listByPrefix(userId, managementKeys.assignmentPrefix(portfolioId));
  }

  async putAssignments(assignments: readonly CategoryAssignment[]): Promise<void> {
    await Promise.all(
      assignments.map((a) => this.put(managementKeys.assignment(a.userId, a.portfolioId, a.symbol), MANAGEMENT_ENTITY.categoryAssignment, a)),
    );
  }

  async deleteAssignments(userId: string, portfolioId: string, symbols: readonly string[]): Promise<void> {
    await Promise.all(symbols.map((symbol) => this.remove(managementKeys.assignment(userId, portfolioId, symbol))));
  }

  listCustomAssets(userId: string, portfolioId?: string): Promise<CustomAsset[]> {
    return this.listByPrefix(userId, managementKeys.customAssetPrefix(portfolioId));
  }

  async getCustomAsset(userId: string, portfolioId: string, assetId: string): Promise<CustomAsset | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: managementKeys.customAsset(userId, portfolioId, assetId), ConsistentRead: true }),
    );
    return res.Item ? fromItem<CustomAsset>(res.Item) : null;
  }

  async putCustomAsset(a: CustomAsset): Promise<void> {
    await this.put(managementKeys.customAsset(a.userId, a.portfolioId, a.assetId), MANAGEMENT_ENTITY.customAsset, a);
  }

  async deleteCustomAsset(userId: string, portfolioId: string, assetId: string): Promise<void> {
    await this.remove(managementKeys.customAsset(userId, portfolioId, assetId));
  }

  listWatchlist(userId: string): Promise<WatchlistEntry[]> {
    return this.listByPrefix(userId, managementKeys.watchlistPrefix);
  }

  async addWatchlistEntry(entry: WatchlistEntry): Promise<boolean> {
    try {
      await this.put(managementKeys.watchlist(entry.userId, entry.symbol), MANAGEMENT_ENTITY.watchlist, entry, 'attribute_not_exists(PK)');
      return true;
    } catch (err) {
      if (isConditionalCheckFailure(err)) return false;
      throw err;
    }
  }

  async deleteWatchlistEntry(userId: string, symbol: string): Promise<boolean> {
    try {
      await this.doc.send(
        new DeleteCommand({ TableName: this.tableName, Key: managementKeys.watchlist(userId, symbol), ConditionExpression: 'attribute_exists(PK)' }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailure(err)) return false;
      throw err;
    }
  }

  async deletePortfolioData(userId: string, portfolioId: string): Promise<void> {
    const [categories, assignments, assets] = await Promise.all([
      this.listCategories(userId, portfolioId),
      this.listAssignments(userId, portfolioId),
      this.listCustomAssets(userId, portfolioId),
    ]);
    await Promise.all([
      ...assignments.map((a) => this.remove(managementKeys.assignment(userId, portfolioId, a.symbol))),
      ...categories.map((c) => this.remove(managementKeys.category(userId, portfolioId, c.categoryId))),
      ...assets.map((a) => this.remove(managementKeys.customAsset(userId, portfolioId, a.assetId))),
      this.remove(managementKeys.settings(userId, portfolioId)),
    ]);
  }
}
