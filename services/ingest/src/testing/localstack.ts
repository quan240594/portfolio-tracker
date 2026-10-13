export const LOCALSTACK_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

/** True when LOCALSTACK=1 and LocalStack answers its health endpoint. Integration suites skip otherwise. */
export async function localStackAvailable(): Promise<boolean> {
  if (process.env.LOCALSTACK !== '1') return false;
  try {
    const res = await fetch(`${LOCALSTACK_ENDPOINT}/_localstack/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    console.warn(`LocalStack not reachable at ${LOCALSTACK_ENDPOINT}; skipping integration tests`);
    return false;
  }
}

export const localAwsConfig = {
  region: 'eu-west-1',
  endpoint: LOCALSTACK_ENDPOINT,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};
