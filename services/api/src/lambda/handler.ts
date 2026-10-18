import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { toApiGatewayResult, toPortableRequest } from '@portfolio/aws';
import { createApp } from '../app.js';
import type { Deps } from '../deps.js';

export type ApiHandler = (
  event: APIGatewayProxyEventV2,
  context?: Partial<Context>,
) => Promise<APIGatewayProxyStructuredResultV2>;

/** AWS Lambda adapter (API Gateway HTTP API, payload format 2.0): the only place that knows the event shape. */
export function createHandler(getDeps: () => Deps): ApiHandler {
  const app = createApp(getDeps);
  return async (event, context) => toApiGatewayResult(await app(toPortableRequest(event, context?.awsRequestId)));
}
