/**
 * Local HTTP server on :3001 serving the portable app (the same `PortableRequest -> PortableResponse` contract the
 * Lambda adapter and a Worker use). Run with `pnpm --filter @portfolio/api dev` after `docker compose up -d` and
 * `pnpm --filter @portfolio/api seed`.
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { PortableRequest } from '@portfolio/platform';

const LOCAL_ENV: Record<string, string> = {
  TABLE_NAME: 'portfolio-tracker-local',
  EVENT_BUS_NAME: 'portfolio-tracker-local',
  IMPORT_BUCKET: 'portfolio-tracker-imports-local',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  AWS_REGION: 'eu-west-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  CORS_ALLOWED_ORIGIN: '*',
  // LocalStack's free tier has no Cognito: local dev always runs as the demo user. Never set this in AWS.
  AUTH_MODE: 'demo',
};
for (const [k, v] of Object.entries(LOCAL_ENV)) process.env[k] ??= v;

const { createApp } = await import('./app.js');
const { createAwsDeps } = await import('./clients.js');
const { loadConfig } = await import('./config.js');
const { setLogger, createConsoleLogger } = await import('@portfolio/platform');
const PORT = Number(process.env.PORT ?? 3001);

setLogger(createConsoleLogger({ service: 'portfolio-tracker-api' }));
const config = loadConfig();
const deps = createAwsDeps(config);
const app = createApp(() => deps);

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
}

export function toRequest(req: IncomingMessage, body: string | undefined): PortableRequest {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(',') : v;
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    headers,
    ...(body === undefined ? {} : { body }),
    requestId: crypto.randomUUID(),
  };
}

const server = createServer(async (req, res) => {
  try {
    const result = await app(toRequest(req, await readBody(req)));
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Local server error' } }));
  }
});

server.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT} (table=${config.tableName}, endpoint=${config.endpointUrl})`);
});
