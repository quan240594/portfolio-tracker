import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { allSettledOrThrow, groupBy, sequentially } from '@portfolio/shared';
import { logger } from './logger.js';
import { extractS3Objects, type S3ObjectRef } from './messages.js';
import { importOwner, processImportObject, type IngestDeps } from './processor.js';

export type IngestHandler = (event: SQSEvent, context?: { awsRequestId?: string }) => Promise<SQSBatchResponse>;

/**
 * Processes the refs of one message: different users concurrently, the refs of a single user in order
 * (so a user's imports are always applied in delivery order). The first failure is rethrown once all groups settled.
 */
async function processRefs(deps: IngestDeps, record: SQSRecord, refs: S3ObjectRef[], started: number): Promise<void> {
  // Refs outside the imports/ layout have no owner; they are ignored, so each forms its own group.
  const byUser = groupBy(refs, (ref) => importOwner(ref.key) ?? ref.key);
  const processGroup = async (group: S3ObjectRef[]): Promise<void> => {
    const outcomes = sequentially(group, async (ref) => ({ ref, outcome: await processImportObject(deps, ref) }));
    for await (const { ref, outcome } of outcomes) {
      logger.info('Processed object', { messageId: record.messageId, key: ref.key, outcome, latencyMs: Date.now() - started });
    }
  };
  await allSettledOrThrow([...byUser.values()].map(processGroup));
}

/** Handles one SQS message; resolves to its failure marker when it must be retried. */
async function processRecord(deps: IngestDeps, record: SQSRecord): Promise<SQSBatchItemFailure | null> {
  const started = Date.now();
  try {
    const refs = extractS3Objects(record.body);
    if (refs.length === 0) logger.warn('Message contains no S3 object references; acknowledging', { messageId: record.messageId });
    await processRefs(deps, record, refs, started);
    return null;
  } catch (err) {
    logger.error('Transient failure; message will be retried', { messageId: record.messageId, error: err as Error });
    return { itemIdentifier: record.messageId };
  }
}

/** SQS batch handler with partial batch responses (`ReportBatchItemFailures`). */
export function createHandler(getDeps: () => IngestDeps): IngestHandler {
  return async (event, context) => {
    const deps = getDeps();
    logger.appendKeys({ requestId: context?.awsRequestId });
    const batchItemFailures: SQSBatchItemFailure[] = [];
    for await (const failure of sequentially(event.Records, (record) => processRecord(deps, record))) {
      if (failure) batchItemFailures.push(failure);
    }
    logger.removeKeys(['requestId']);
    return { batchItemFailures };
  };
}
