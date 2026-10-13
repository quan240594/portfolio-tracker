/**
 * Local HTTP server on :3001 that wraps the Lambda handler (API Gateway HTTP API payload v2).
 * Run with `pnpm --filter @portfolio/api dev` after `docker compose up -d` and `pnpm --filter @portfolio/api seed`.
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const LOCAL_ENV: Record<string, string> = {
  TABLE_NAME: 'portfolio-tracker-local',
  EVENT_BUS_NAME: 'portfolio-tracker-local',
  IMPORT_BUCKET: 'portfolio-tracker-imports-local',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  AWS_REGION: 'eu-west-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  CORS_ALLOWED_ORIGIN: '*',
};
for (const [k, v] of Object.entries(LOCAL_ENV)) process.env[k] ??= v;

const { handler } = await import('./index.js');
const PORT = Number(process.env.PORT ?? 3001);

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
}

export function toEvent(req: IncomingMessage, body: string | undefined): APIGatewayProxyEventV2 {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(',') : v;
  const query = Object.fromEntries(url.searchParams.entries());
  const method = (req.method ?? 'GET').toUpperCase();
  const now = new Date();
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: url.pathname,
    rawQueryString: url.searchParams.toString(),
    headers,
    queryStringParameters: Object.keys(query).length ? query : undefined,
    body,
    isBase64Encoded: false,
    requestContext: {
      accountId: '000000000000',
      apiId: 'local',
      domainName: headers.host ?? 'localhost',
      domainPrefix: 'localhost',
      http: { method, path: url.pathname, protocol: 'HTTP/1.1', sourceIp: req.socket.remoteAddress ?? '127.0.0.1', userAgent: headers['user-agent'] ?? '' },
      requestId: crypto.randomUUID(),
      routeKey: '$default',
      stage: '$default',
      time: now.toUTCString(),
      timeEpoch: now.getTime(),
    },
  };
}

const server = createServer(async (req, res) => {
  try {
    const event = toEvent(req, await readBody(req));
    const result = await handler(event, { awsRequestId: event.requestContext.requestId });
    res.writeHead(result.statusCode ?? 200, result.headers as Record<string, string>);
    res.end(result.body ?? '');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Local server error' } }));
  }
});

server.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT} (table=${process.env.TABLE_NAME}, endpoint=${process.env.AWS_ENDPOINT_URL})`);
});
