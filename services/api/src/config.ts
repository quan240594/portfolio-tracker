import { DEFAULT_BASE_CURRENCY, DEMO_USER_ID } from '@portfolio/shared';

export interface Config {
  tableName: string;
  eventBusName: string;
  importBucket: string;
  baseCurrency: string;
  demoUserId: string;
  corsAllowedOrigin: string;
  endpointUrl?: string;
  region: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    tableName: env.TABLE_NAME ?? 'portfolio-tracker-local',
    eventBusName: env.EVENT_BUS_NAME ?? 'portfolio-tracker-local',
    importBucket: env.IMPORT_BUCKET ?? 'portfolio-tracker-imports-local',
    baseCurrency: (env.BASE_CURRENCY?.trim() || DEFAULT_BASE_CURRENCY).toUpperCase(),
    demoUserId: env.DEMO_USER_ID || DEMO_USER_ID,
    corsAllowedOrigin: env.CORS_ALLOWED_ORIGIN ?? '*',
    endpointUrl: env.AWS_ENDPOINT_URL || undefined,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'eu-west-1',
  };
}
