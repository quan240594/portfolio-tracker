import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { logger } from './logger.js';
import { extractS3Objects } from './messages.js';
import { processImportObject, type IngestDeps } from './processor.js';

export type IngestHandler = (event: SQSEvent, context?: { awsRequestId?: string }) => Promise<SQSBatchResponse>;

/** SQS batch handler with partial batch responses (`ReportBatchItemFailures`). */
export function createHandler(getDeps: () => IngestDeps): IngestHandler {
  return async (event, context) => {
    const deps = getDeps();
    logger.appendKeys({ requestId: context?.awsRequestId });
    const batchItemFailures: SQSBatchItemFailure[] = [];
    for (const record of event.Records) {
      const started = Date.now();
      try {
        const refs = extractS3Objects(record.body);
        if (refs.length === 0) logger.warn('Message contains no S3 object references; acknowledging', { messageId: record.messageId });
        for (const ref of refs) {
          const outcome = await processImportObject(deps, ref);
          logger.info('Processed object', { messageId: record.messageId, key: ref.key, outcome, latencyMs: Date.now() - started });
        }
      } catch (err) {
        logger.error('Transient failure; message will be retried', { messageId: record.messageId, error: err as Error });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    logger.removeKeys(['requestId']);
    return { batchItemFailures };
  };
}
