export interface Config {
  tableName: string;
  eventBusName: string;
  importBucket: string;
  endpointUrl?: string;
  region: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    tableName: env.TABLE_NAME ?? 'portfolio-tracker-local',
    eventBusName: env.EVENT_BUS_NAME ?? 'portfolio-tracker-local',
    importBucket: env.IMPORT_BUCKET ?? 'portfolio-tracker-imports-local',
    endpointUrl: env.AWS_ENDPOINT_URL || undefined,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'eu-west-1',
  };
}
