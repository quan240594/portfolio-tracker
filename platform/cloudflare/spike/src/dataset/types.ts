/** A DynamoDB-shaped item (PK/SK + entityType + the entity's fields stored flat), the unit both datasets are built from. */
export type Item = { PK: string; SK: string; entityType?: string } & Record<string, unknown>;

export interface Dataset {
  name: string;
  userId: string;
  /** Fixed "today" (YYYY-MM-DD) so every run is reproducible. */
  today: string;
  items: Item[];
  /** Item count per entityType, for the report. */
  counts: Record<string, number>;
}

export const countByEntity = (items: readonly Item[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of items) out[i.entityType ?? '?'] = (out[i.entityType ?? '?'] ?? 0) + 1;
  return out;
};
