export interface Config {
  tableName: string;
  eventBusName: string;
  /** Secrets Manager prefix, e.g. `/portfolio-tracker/dev/broker/trading212`. */
  secretPrefix: string;
  /** Explicit symbol overrides: T212 ticker or ISIN -> canonical symbol (JSON in T212_SYMBOL_OVERRIDES). */
  symbolOverrides: Record<string, string>;
  /** Name of the sync Lambda the API invokes (asynchronously); unset locally, where the API runs the sync in-process. */
  syncFunctionName?: string;
  endpointUrl?: string;
  region: string;
}

function parseOverrides(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
    }
  } catch {
    // invalid JSON means no overrides
  }
  return {};
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    tableName: env.TABLE_NAME ?? 'portfolio-tracker-local',
    eventBusName: env.EVENT_BUS_NAME ?? 'portfolio-tracker-local',
    secretPrefix: env.BROKER_SECRET_PREFIX ?? '/portfolio-tracker/local/broker/trading212',
    symbolOverrides: parseOverrides(env.T212_SYMBOL_OVERRIDES),
    syncFunctionName: env.BROKER_SYNC_FUNCTION || undefined,
    endpointUrl: env.AWS_ENDPOINT_URL || undefined,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'eu-west-1',
  };
}
