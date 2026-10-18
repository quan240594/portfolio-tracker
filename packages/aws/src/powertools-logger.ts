import { Logger as Powertools } from '@aws-lambda-powertools/logger';
import type { LogFields, Logger } from '@portfolio/platform';

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'SILENT';

/** Adapts an AWS Lambda Powertools logger to the platform `Logger` port. */
export function adaptPowertools(logger: Powertools): Logger {
  const write = (level: 'debug' | 'info' | 'warn' | 'error') => (message: string, fields?: LogFields) => {
    logger[level](message, ...(fields ? [fields] : []));
  };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    appendKeys: (fields) => {
      logger.appendKeys(fields as Record<string, string>);
    },
    removeKeys: (keys) => {
      logger.removeKeys([...keys]);
    },
    createChild: (options) => adaptPowertools(logger.createChild(options?.persistentKeys ? { persistentKeys: options.persistentKeys as Record<string, string> } : {})),
  };
}

/** The structured JSON logger of the Lambda functions; the level comes from `LOG_LEVEL` (default INFO). */
export function createPowertoolsLogger(serviceName: string, env: Record<string, string | undefined> = process.env): Logger {
  return adaptPowertools(new Powertools({ serviceName, logLevel: (env.LOG_LEVEL ?? 'INFO').toUpperCase() as Level }));
}
