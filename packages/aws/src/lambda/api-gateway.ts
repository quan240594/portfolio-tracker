import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { IdentityResolver, PortableIdentity, PortableRequest, PortableResponse } from '@portfolio/platform';

type JwtAuthorizer = { jwt?: { claims?: Record<string, unknown> } };

/** Identity from the claims of the API Gateway JWT authorizer (Cognito). Only a non-empty string `sub` counts. */
export const apiGatewayIdentity: IdentityResolver<APIGatewayProxyEventV2> = {
  identify(event): PortableIdentity | undefined {
    const authorizer = (event.requestContext as { authorizer?: JwtAuthorizer }).authorizer;
    const sub = authorizer?.jwt?.claims?.sub;
    return typeof sub === 'string' && sub.length > 0 ? { subject: sub } : undefined;
  },
};

/** API Gateway HTTP API (payload format 2.0) event -> portable request. A base64 body is decoded to text here. */
export function toPortableRequest(event: APIGatewayProxyEventV2, requestId?: string): PortableRequest {
  const body = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const identity = apiGatewayIdentity.identify(event) as PortableIdentity | undefined;
  return {
    method: event.requestContext.http.method.toUpperCase(),
    path: event.rawPath,
    query: event.queryStringParameters ?? {},
    headers: event.headers ?? {},
    ...(body === undefined ? {} : { body }),
    ...(identity ? { identity } : {}),
    requestId: requestId ?? event.requestContext.requestId,
  };
}

export function toApiGatewayResult(response: PortableResponse): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: response.status,
    headers: response.headers,
    body: response.body,
    ...(response.cookies?.length ? { cookies: response.cookies } : {}),
  };
}
