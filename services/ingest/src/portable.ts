/**
 * Platform-neutral surface of the CSV ingestion: the job and its dependencies. The SQS/S3 event handling (`app.ts`)
 * and the AWS wiring (`clients.ts`) are the AWS adapter.
 */
export { importOwner, importUploadedJob, processImport, MAX_OBJECT_BYTES, type IngestDeps, type ProcessOutcome } from './processor.js';
export { ItemIngestStore, type IngestStore } from './store.js';
export { MAX_ERRORS, parseImportCsv } from './csv.js';
