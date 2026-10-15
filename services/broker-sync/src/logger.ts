import { Logger } from '@aws-lambda-powertools/logger';

/** Only ids, counts and error codes are ever logged: never credentials, headers or amounts. */
export const logger = new Logger({
  serviceName: 'portfolio-tracker-broker-sync',
  logLevel: (process.env.LOG_LEVEL ?? 'INFO').toUpperCase() as 'INFO',
});
