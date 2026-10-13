import { Logger } from '@aws-lambda-powertools/logger';

export const logger = new Logger({
  serviceName: 'portfolio-tracker-ingest',
  logLevel: (process.env.LOG_LEVEL ?? 'INFO').toUpperCase() as 'INFO',
});
